// Replays a Claude Code session transcript (~/.claude/projects/**/*.jsonl)
// through the library against the local Laya server and prints the score
// distribution plus the reduction each keepThreshold would give. The segment
// replayed is the one before the last compact boundary (what /compact saw).
//
//   npm run replay -- path/to/session.jsonl

import { readFileSync } from 'node:fs';
import {
  applyDecisions,
  collectToolCalls,
  compactMessages,
  decideCall,
  messageChars,
  reductionRatio,
  resolveOptions,
  type Message,
} from '../src/index.js';

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Record_ = { type?: string; subtype?: string; message?: { role?: string; content?: string | Block[] } };

const path = process.argv[2];
if (!path) throw new Error('usage: replay <session.jsonl>');
const records: Record_[] = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const boundaries = records.map((r, i) => (r.type === 'system' && r.subtype === 'compact_boundary' ? i : -1)).filter((i) => i >= 0);
const end = boundaries.length ? boundaries[boundaries.length - 1]! : records.length;
const start = boundaries.length >= 2 ? boundaries[boundaries.length - 2]! + 1 : 0;

const text = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: Block) => b.text ?? '').join('') : '';
const messages: Message[] = [];
for (const r of records.slice(start, end)) {
  const m = r.message;
  if (!m || (r.type !== 'user' && r.type !== 'assistant')) continue;
  const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? []);
  const msg: Message = { role: r.type, text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'), toolUses: [] };
  for (const b of blocks) {
    if (b.type === 'tool_use') msg.toolUses.push({ tool_use_id: b.id!, tool: b.name!, input: b.input as Record<string, unknown> });
    if (b.type === 'tool_result') (msg.toolResults ??= []).push({ tool_use_id: b.tool_use_id!, text: text(b.content), isError: b.is_error ?? false });
  }
  messages.push(msg);
}

const options = resolveOptions({});
const result = await compactMessages(messages, {});
const calls = collectToolCalls(messages, options.preserveRecentMessages);
const before = messages.reduce((s, m) => s + messageChars(m), 0);

console.log(`messages ${messages.length}, chars ${before}, candidates ${calls.length}, requests ${result.stats.requests}, truncated retries ${result.stats.truncatedRetries}`);
console.log(`default: ${(reductionRatio(result) * 100).toFixed(1)}% reduction, cut ${result.stats.threshold.toFixed(2)} (keepThreshold ${options.keepThreshold}, targetReduction ${options.targetReduction})`);

const scored = result.decisions.filter((d) => d.reason !== 'pinned' && d.reason !== 'superseded');
const hist = (key: 'keepCall' | 'keepResult') => {
  const bins = new Array(10).fill(0);
  for (const d of scored) bins[Math.min(9, Math.floor(d[key] * 10))]++;
  return bins.map((n, i) => `${(i / 10).toFixed(1)}:${n}`).join(' ');
};
console.log(`keepResult ${hist('keepResult')}`);
console.log(`keepCall   ${hist('keepCall')}`);

console.log('threshold  reduction  kept  drop_result  drop_call');
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  const decisions = result.decisions.map((d) =>
    d.reason === 'pinned' || d.reason === 'superseded' ? d : decideCall({ id: d.id, tool: d.tool, pinned: false }, d, { keepThreshold: t }),
  );
  const after = applyDecisions(messages, decisions, calls, options.truncateHeadChars).reduce((s, m) => s + messageChars(m), 0);
  const n = (a: string) => decisions.filter((d) => d.action === a).length;
  console.log(`${t.toFixed(2).padEnd(10)} ${((1 - after / before) * 100).toFixed(1).padStart(6)}%  ${String(n('keep')).padStart(4)}  ${String(n('drop_result')).padStart(11)}  ${String(n('drop_call')).padStart(9)}`);
}
