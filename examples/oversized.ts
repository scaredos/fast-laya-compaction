// Live check against the local Laya server with a transcript far over Laya's
// 1024-token window: ~25 tool calls, multi-KB file reads, a Read → Edit →
// re-Read of the same file, repeated test runs, an error then a fix, and a
// goal change. Prints every decision, then shows what `whole` mode does with
// the same budget.
//
//   python server/laya_server.py   (in another terminal)
//   npm run demo:oversized

import { compactMessages, estimateTokens, reductionRatio, type Message } from '../src/index.js';

let n = 0;
function call(tool: string, input: Record<string, unknown>, output: string, isError = false): Message[] {
  const tool_use_id = `toolu_${++n}`;
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id, tool, input, text: output, isError }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id, text: output, isError }] },
  ];
}
const user = (text: string): Message => ({ role: 'user', text, toolUses: [] });
const assistant = (text: string): Message => ({ role: 'assistant', text, toolUses: [] });
const file = (name: string, lines: number, body: string): string =>
  `// ${name}\n${body.repeat(lines)}`;

const cartV1 = file('cart.ts', 90, 'export function addItem(cart, item, cb) { cb(null, [...cart, item]); }\n');
const paymentV1 = file('payment.ts', 110, 'export function charge(amount, cb) { gateway.charge(amount, (err, r) => cb(err, r)); }\n');
const paymentV2 = file('payment.ts', 110, 'export async function charge(amount) { return gateway.charge(amount); }\n');
const paymentV3 = file('payment.ts', 120, 'export async function charge(amount) { return retry(() => gateway.charge(amount)); }\n');
const legacy = file('legacy/gateway.ts', 80, 'module.exports.charge = function (amount, cb) { /* legacy, do not touch */ };\n');
const backoffDocs = 'Exponential backoff: wait base * 2^attempt with jitter; cap attempts; retry only idempotent operations.\n'.repeat(45);

const messages: Message[] = [
  user('Migrate the checkout service from callbacks to async/await. Keep the public API stable. Do not touch src/legacy/.'),
  assistant('I will map the callback call sites first, then convert cart and payment.'),
  ...call('Glob', { pattern: 'src/**/*.ts' }, ['src/checkout/cart.ts', 'src/checkout/payment.ts', 'src/checkout/index.ts', 'src/legacy/gateway.ts', 'src/checkout/cart.test.ts', 'src/checkout/payment.test.ts'].join('\n')),
  ...call('Read', { file_path: 'src/checkout/cart.ts' }, cartV1),
  ...call('Read', { file_path: 'src/checkout/payment.ts' }, paymentV1),
  ...call('Read', { file_path: 'src/legacy/gateway.ts' }, legacy),
  assistant('The legacy gateway is off limits and unrelated; converting payment.ts first.'),
  ...call('Grep', { pattern: 'callback|cb\\)', path: 'src/checkout' }, Array.from({ length: 20 }, (_, i) => `src/checkout/payment.ts:${10 + i}: cb(err, r)`).join('\n')),
  ...call('Bash', { command: 'npm test' }, 'FAIL src/checkout/payment.test.ts\n  charge > resolves with the receipt\n    TypeError: charge(...).then is not a function\n    at src/checkout/payment.test.ts:14:22', true),
  ...call('Edit', { file_path: 'src/checkout/payment.ts', old_string: 'export function charge(amount, cb) {', new_string: 'export async function charge(amount) {' }, 'The file src/checkout/payment.ts has been updated.'),
  ...call('Read', { file_path: 'src/checkout/payment.ts' }, paymentV2),
  ...call('Bash', { command: 'npm test' }, 'PASS src/checkout/payment.test.ts\nFAIL src/checkout/cart.test.ts\n  addItem > returns the new cart\n    expected a promise', true),
  ...call('Bash', { command: 'npm run lint' }, 'src/checkout/cart.ts:12:3 warning no-unused-vars cb\nsrc/checkout/cart.ts:40:3 warning no-unused-vars cb\n2 warnings'),
  ...call('Edit', { file_path: 'src/checkout/cart.ts', old_string: 'export function addItem(cart, item, cb) {', new_string: 'export async function addItem(cart, item) {' }, 'The file src/checkout/cart.ts has been updated.'),
  ...call('Bash', { command: 'npm test' }, 'PASS src/checkout/payment.test.ts\nPASS src/checkout/cart.test.ts\nTest Suites: 2 passed, 2 total'),
  assistant('Both modules are async now, the public API is unchanged, and the suite passes.'),
  user('Now add retry logic to payment.charge with exponential backoff.'),
  ...call('Read', { file_path: 'src/checkout/payment.ts' }, paymentV2),
  ...call('WebFetch', { url: 'https://example.com/docs/backoff' }, backoffDocs),
  ...call('Edit', { file_path: 'src/checkout/payment.ts', old_string: 'return gateway.charge(amount);', new_string: 'return retry(() => gateway.charge(amount), { base: 100, attempts: 5 });' }, 'The file src/checkout/payment.ts has been updated.'),
  ...call('Read', { file_path: 'src/checkout/payment.ts' }, paymentV3),
  ...call('Bash', { command: 'npm test' }, 'PASS src/checkout/payment.test.ts\nPASS src/checkout/cart.test.ts\nTest Suites: 2 passed, 2 total'),
  ...call('Bash', { command: 'npm run build' }, 'tsc: 0 errors'),
  assistant('Retry with exponential backoff is in place and everything passes.'),
  user('Great. Write the changelog entry.'),
];

const totalChars = messages.reduce((sum, m) => sum + m.text.length + (m.toolResults ?? []).reduce((s, r) => s + r.text.length, 0), 0);
console.log(`transcript: ${messages.length} messages, ${totalChars} chars, ~${estimateTokens(JSON.stringify(messages))} tokens (Laya window: 1024)\n`);

const started = Date.now();
const result = await compactMessages(messages, { preserveRecentMessages: 4 });
console.log(`local mode, rules on: ${Date.now() - started} ms\n`);
console.log('id   tool      input                                     action       reason               call  result');
for (const d of result.decisions) {
  const call = messages.flatMap((m) => m.toolUses).find((t) => t.tool_use_id === `toolu_${d.id.slice(1)}`);
  const input = JSON.stringify(call?.input ?? {}).slice(0, 40).padEnd(41);
  const reason = `${d.reason}${d.supersededBy ? ` by ${d.supersededBy}` : ''}`.padEnd(20);
  console.log(`${d.id.padEnd(4)} ${d.tool.padEnd(9)} ${input} ${d.action.padEnd(12)} ${reason} ${d.keepCall.toFixed(2)}  ${d.keepResult.toFixed(2)}`);
}
console.log('');
console.log('stats:', JSON.stringify(result.stats));
console.log(`chars saved: ${(reductionRatio(result) * 100).toFixed(1)}%; messages ${result.stats.messagesBefore} → ${result.stats.messagesAfter}`);

const pure = await compactMessages(messages, { preserveRecentMessages: 4, rules: false });
console.log(`\npure Laya (rules off): ${pure.stats.requests} requests, ${(reductionRatio(pure) * 100).toFixed(1)}% saved, ${pure.stats.kept} kept / ${pure.stats.resultsDropped} results truncated / ${pure.stats.callsDropped} calls dropped`);

console.log('\nwhole mode with the same budget:');
try {
  const whole = await compactMessages(messages, { stateMode: 'whole', preserveRecentMessages: 4 });
  console.log('stats:', JSON.stringify(whole.stats));
  console.log(whole.decisions.map((d) => `${d.id}:${d.action}/${d.keepCall.toFixed(2)}/${d.keepResult.toFixed(2)}`).join(' '));
} catch (error) {
  console.log(`threw: ${error instanceof Error ? error.message : String(error)}`);
}
