import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { ContentBlock, ImageBlock, Message } from '../providers/types.js';
import type { SessionHandle } from '../session/types.js';
import { CodingxError } from '../util/errors.js';
import { resolveWorkspacePath } from '../tools/paths.js';
import type { ToolContext } from '../tools/types.js';
import { fileVersion, sameVersion } from '../tools/read-tracker.js';
import { approvalRequestFor } from '../policy/index.js';
import { expandHome } from '../util/paths.js';

export interface FileAttachment { type: 'file'; path: string; start: number; end: number; text: string; truncated: boolean; version: import('../tools/read-tracker.js').FileVersion }
export type StoredAttachment = FileAttachment | ImageBlock;
interface Draft { path: string; start?: number; end?: number; imageOnly?: boolean }
export function imageType(bytes: Buffer): ImageBlock['mediaType'] | undefined {
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  return undefined;
}
export function attachmentBlocks(attachments: readonly StoredAttachment[]): ContentBlock[] {
  return attachments.map(a => a.type === 'image' ? a : { type: 'text', text: '[File attachment: ' + a.path + ':' + a.start + ':' + a.end + (a.truncated ? '; truncated' : '') + ']\n' + a.text });
}
export async function hydrateImages(messages: readonly Message[], session: SessionHandle): Promise<Message[]> {
  return Promise.all(messages.map(async m => ({ ...m, content: await Promise.all(m.content.map(async block => {
    if (block.type !== 'image') return block;
    if (!session.getObject) throw new CodingxError('ATTACHMENT_ERROR', 'Image object storage is unavailable.');
    const bytes = await session.getObject(block.object);
    if (imageType(bytes) !== block.mediaType) throw new CodingxError('ATTACHMENT_ERROR', 'Image snapshot is damaged: ' + block.name);
    return { ...block, data: bytes.toString('base64') };
  })) })));
}
export async function validateImageSnapshots(messages: readonly Message[], session: SessionHandle): Promise<void> {
  for (const message of messages) for (const block of message.content) {
    if (block.type !== 'image') continue;
    if (!session.getObject) throw new CodingxError('ATTACHMENT_ERROR', 'Image object storage unavailable.');
    const bytes = await session.getObject(block.object);
    if (imageType(bytes) !== block.mediaType) throw new CodingxError('ATTACHMENT_ERROR', 'Image snapshot damaged: ' + block.name);
  }
}
export class Attachments {
  private drafts: Draft[] = [];
  constructor(private readonly session: SessionHandle) {}
  get count(): number { return this.drafts.length; }
  clear(): void { this.drafts = []; }
  add(input: string, imageOnly = false): string {
    if (!imageOnly && input.trim() === '--clear') { this.clear(); return 'Pending attachments cleared.'; }
    const match = /^(.*?)(?:\s+(\d+):(\d+))?$/.exec(input.trim());
    let target = match?.[1] ?? '';
    if (target.startsWith('"') && target.endsWith('"')) {
      try { target = JSON.parse(target) as string; } catch { target = target.slice(1,-1); }
    } else if (target.startsWith("'") && target.endsWith("'")) target = target.slice(1,-1);
    if (!target) throw new CodingxError('ATTACHMENT_ERROR', 'Usage: /attach <path> [start:end]');
    const start = match?.[2] ? Number(match[2]) : undefined;
    const end = match?.[3] ? Number(match[3]) : undefined;
    if (start !== undefined && (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end! < start)) throw new CodingxError('ATTACHMENT_ERROR', 'Invalid line range.');
    this.drafts.push({ path: target, start, end, imageOnly });
    return 'Attached ' + target + (start ? ':' + start + ':' + end : '') + ' (read and validated when sent).';
  }
  async prepare(ctx: ToolContext): Promise<StoredAttachment[]> {
    const attachments: StoredAttachment[] = [];
    let remaining = 30_000; let images = 0;
    for (const draft of this.drafts) {
      if (ctx.policy) {
        const decision = await ctx.policy.evaluate('Read', { path: draft.path });
        if (decision.verdict === 'deny') throw new CodingxError('ATTACHMENT_ERROR', decision.reason ?? 'Read denied.');
        if (decision.verdict === 'ask') {
          const answer = await ctx.approve?.(approvalRequestFor(decision), ctx.signal);
          if (answer?.decision !== 'allow') throw new CodingxError('ATTACHMENT_ERROR', 'Attachment read was not approved.');
        }
      }
      const resolved = await resolveWorkspacePath(ctx, draft.path, { mustExist: true, access: 'read' });
      const info = await stat(resolved.absolute);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new CodingxError('ATTACHMENT_ERROR', 'Attachment must be a regular file at most 10 MiB.');
      const accessPath = path.resolve(ctx.cwd, expandHome(draft.path));
      const version = fileVersion(accessPath);
      const bytes = await readFile(resolved.absolute);
      if (!sameVersion(version, fileVersion(accessPath, bytes)) || !sameVersion(version, fileVersion(accessPath))) throw new CodingxError('FILE_CHANGED', 'Attachment changed while reading.');
      const mediaType = imageType(bytes);
      if (mediaType) {
        if (draft.start || bytes.length > 5 * 1024 * 1024 || ++images > 4) throw new CodingxError('ATTACHMENT_ERROR', 'Images allow no line range, at most 5 MiB each and 4 per message.');
        if (!this.session.putObject) throw new CodingxError('OBJECT_ERROR', 'Attachment object storage unavailable.');
        attachments.push({ type: 'image', mediaType, name: path.basename(draft.path), object: await this.session.putObject(bytes) });
        continue;
      }
      if (draft.imageOnly || /\.(png|jpe?g|webp)$/i.test(draft.path)) throw new CodingxError('ATTACHMENT_ERROR', 'Invalid PNG/JPEG/WebP signature: ' + draft.path);
      if (bytes.includes(0)) throw new CodingxError('ATTACHMENT_ERROR', 'Binary attachment rejected.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const lines = text.split('\n'); if (text.endsWith('\n')) lines.pop();
      const start = draft.start ?? 1;
      const end = Math.min(draft.end ?? start + 199, start + 199, lines.length);
      const selected = lines.slice(start - 1, Math.max(start - 1, end)).join('\n');
      const body = selected.slice(0, Math.max(0, remaining)); remaining -= body.length;
      ctx.readTracker.markRead(path.resolve(ctx.cwd, expandHome(draft.path)), version);
      attachments.push({ type: 'file', path: path.relative(ctx.cwd, accessPath), start, end, text: body, truncated: body.length < selected.length || end < (draft.end ?? lines.length), version });
    }
    return attachments;
  }
}
