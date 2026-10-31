import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CodingxError } from '../util/errors.js';

export const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
export const OBJECT_CHUNK_BYTES = 256 * 1024;
export interface ObjectRef { sha256: string; size: number; chunks: string[] }
export const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function validateObjectRef(ref: ObjectRef): void {
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > MAX_OBJECT_BYTES || !Array.isArray(ref.chunks) || ref.chunks.length !== Math.ceil(ref.size / OBJECT_CHUNK_BYTES) || ref.chunks.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new CodingxError('OBJECT_ERROR', 'Invalid or oversized object reference.');
}
export async function putObject(bytes: Uint8Array, put: (hash: string, chunk: Buffer) => Promise<void>): Promise<ObjectRef> {
  if (bytes.byteLength > MAX_OBJECT_BYTES) throw new CodingxError('OBJECT_ERROR', 'Object exceeds 16 MiB.');
  const buffer = Buffer.from(bytes);
  const ref: ObjectRef = { sha256: digest(buffer), size: buffer.length, chunks: [] };
  for (let i = 0; i < buffer.length; i += OBJECT_CHUNK_BYTES) {
    const chunk = buffer.subarray(i, i + OBJECT_CHUNK_BYTES);
    const hash = digest(chunk);
    await put(hash, chunk);
    ref.chunks.push(hash);
  }
  return ref;
}
export async function getObject(ref: ObjectRef, get: (hash: string, index: number) => Promise<Buffer>): Promise<Buffer> {
  validateObjectRef(ref);
  const chunks: Buffer[] = [];
  for (const [index, hash] of ref.chunks.entries()) {
    const bytes = await get(hash, index);
    if (bytes.length > OBJECT_CHUNK_BYTES || digest(bytes) !== hash) throw new CodingxError('OBJECT_ERROR', 'Object chunk is damaged.');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== ref.size || digest(bytes) !== ref.sha256) throw new CodingxError('OBJECT_ERROR', 'Object is missing or damaged.');
  return bytes;
}
export class SessionObjects {
  constructor(private readonly directory: string) {}
  async put(bytes: Uint8Array): Promise<ObjectRef> {
    return putObject(bytes, async (hash, chunk) => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const target = path.join(this.directory, hash);
      let handle;
      try { handle = await open(target, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (digest(await readFile(target)) !== hash) throw new CodingxError('OBJECT_ERROR', 'Existing object is damaged.');
        return;
      }
      try { await handle.writeFile(chunk); await handle.sync(); } finally { await handle.close(); }
    });
  }
  async get(ref: ObjectRef): Promise<Buffer> {
    return getObject(ref, async (hash) => {
      const target = path.join(this.directory, hash);
      if ((await stat(target)).size > OBJECT_CHUNK_BYTES) throw new CodingxError('OBJECT_ERROR', 'Oversized object chunk.');
      return readFile(target);
    });
  }
}
/** Discover only object references, never arbitrary filesystem paths from events. */
export function referencedObjects(value: unknown): ObjectRef[] {
  if (!value || typeof value !== 'object') return [];
  if ('sha256' in value && 'chunks' in value && 'size' in value) { validateObjectRef(value as ObjectRef); return [value as ObjectRef]; }
  return Object.values(value).flatMap(referencedObjects);
}
