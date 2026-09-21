// Fits this library's tokenizer-free estimate against what the local Laya
// server actually counts (`usage.input_tokens`), so the state budget can be
// sized to Laya's hard 1024-token truncation. Re-run after a `laya` upgrade
// and set `maxRequestTokens` below the printed safe estimate.
//
//   python server/laya_server.py   (in another terminal)
//   npm run calibrate

import { estimateTokens, LOCAL_CONTEXT } from '../src/index.js';

const LAYA_WINDOW = 1024;
const base = process.env.LAYA_URL?.replace(/\/predict$/, '') ?? 'http://127.0.0.1:8756';
let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  try {
    ready = (await fetch(`${base}/`)).ok;
  } catch {
    /* not up yet */
  }
  if (!ready) await new Promise((resolve) => setTimeout(resolve, 3000));
}
if (!ready) {
  console.log('Laya server not reachable');
  process.exit(1);
}

const questions = {
  call_t1: { type: 'noul', instructions: 'Tool call t1 (Read) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next' },
  result_t1: { type: 'noul', instructions: 'The full output of tool call t1 (Read, 4000 chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do' },
};
const line = 'export async function charge(amount) { return gateway.charge(amount); }\n';
const fitted: [number, number][] = [];
let largestFitting = 0;
let smallestTruncated = Number.POSITIVE_INFINITY;
for (const [reps, afters] of [[2, 2], [5, 4], [8, 6], [11, 8], [14, 10], [17, 12], [20, 14], [24, 16]] as const) {
  const state = {
    context: LOCAL_CONTEXT,
    goal: 'Migrate the checkout service from callbacks to async/await. Keep the public API stable.',
    call: { id: 't1', tool: 'Read', input: JSON.stringify({ file_path: 'src/checkout/payment.ts' }), status: 'ok', chars: 4000, result: line.repeat(reps) },
    after: Array.from({ length: afters }, (_, i) => `t${i + 2} Bash command=npm test → ok 61ch`),
  };
  const est = estimateTokens(JSON.stringify({ state, questions }));
  const res = await fetch(`${base}/predict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'router', state, questions }),
  });
  const json = (await res.json()) as { usage: { input_tokens: number }; routing: { model: string } };
  const real = json.usage.input_tokens;
  const truncated = real >= LAYA_WINDOW;
  if (truncated) smallestTruncated = Math.min(smallestTruncated, est);
  else {
    fitted.push([est, real]);
    largestFitting = Math.max(largestFitting, est);
  }
  console.log(`est ${String(est).padStart(4)} -> laya ${String(real).padStart(4)}  ratio ${(real / est).toFixed(2)}  routing=${json.routing.model}${truncated ? '  TRUNCATED' : ''}`);
}
if (fitted.length >= 2) {
  const n = fitted.length;
  const sx = fitted.reduce((s, [x]) => s + x, 0);
  const sy = fitted.reduce((s, [, y]) => s + y, 0);
  const sxx = fitted.reduce((s, [x]) => s + x * x, 0);
  const sxy = fitted.reduce((s, [x, y]) => s + x * y, 0);
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const b = (sy - a * sx) / n;
  console.log(`\nfit on non-truncated points: laya ≈ ${a.toFixed(2)} × estimate + ${b.toFixed(0)}`);
  console.log(`estimate that keeps Laya at <= ${LAYA_WINDOW}: ${Math.floor((LAYA_WINDOW - b) / a)}; with 5% margin: ${Math.floor((LAYA_WINDOW * 0.95 - b) / a)}`);
}
console.log(`largest estimate that fit: ${largestFitting}; smallest that truncated: ${Number.isFinite(smallestTruncated) ? smallestTruncated : 'none'}`);
console.log('set maxRequestTokens below the largest fitting estimate.');
