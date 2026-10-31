import { readFile } from 'node:fs/promises';
import { calculateCost, calculateTurnCost } from './cost.mjs';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new Error('Input exceeds limit.');
}
const context = JSON.parse(input);
if (context.version !== 1) throw new Error('Unsupported protocol.');
const pricing = JSON.parse(await readFile(new URL('./pricing.json', import.meta.url), 'utf8'));
process.stdout.write(JSON.stringify(context.turn ? calculateTurnCost(context, pricing) : calculateCost(context, pricing)) + '\n');
