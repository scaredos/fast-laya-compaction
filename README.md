# fast-laya-compaction

Claude Code plugin that replaces the compaction summary with **Laya** decisions:
every tool call and result is scored, stale ones are dropped or truncated,
everything kept stays verbatim. Also usable as an npm library.

> Fork of [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction).
> The only change is the scorer: instead of the paid TypeSafe/Jev API, it calls
> a **local Laya model** ([NandhaKishorM/laya](https://github.com/NandhaKishorM/laya))
> over `http://127.0.0.1:8756`. No API key, no per-input cost. Because Laya and
> Jev share a wire format (`{state, questions} -> {answers}`), the compaction
> logic is untouched — see [`server/`](server/) for the swap.
>
> Laya truncates every request at **1024 tokens** (measured: `laya` 0.3.4
> reports `input_tokens: 1024` for anything larger, on the English checkpoint
> too) versus Jev's 32k, so instead of showing the judge the whole conversation
> this fork judges **each call with its own small state**: the call, the head
> of its output, and what happened after it. See [Context window](#context-window).

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against a cut that starts at `keepThreshold`:
   - `keepResult ≥ cut` → keep call and result;
   - else `keepCall ≥ cut` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.

   Laya's absolute probabilities bunch up (on a real 650k-token session, 268
   of 278 results scored between 0.5 and 0.9, so a fixed 0.5 cut removed 6%),
   but its ranking is informative. The cut therefore rises through the
   scores, lowest first, until `targetReduction` of the characters is gone
   (60% on that session) or only the top score is left. `npm run replay --
   <session.jsonl>` prints the score histogram and the reduction per cut for
   any Claude Code transcript.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Quick start (local Laya)

```sh
pip install laya                      # the scoring model
python server/laya_server.py          # loads once, serves on 127.0.0.1:8756
```

The server prefers CUDA and falls back to CPU automatically (override with
`LAYA_DEVICE=cpu`, port with `LAYA_PORT`). Keep it running while you use Claude
Code. Then install the plugin (see [Claude Code plugin](#claude-code-plugin)).

## Install and usage (npm library)

```sh
npm install fast-laya-compaction      # then run the Laya server above
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-laya-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method — the name is kept from upstream) and call `compact(messages, asker, options)`;
`buildJevRequest` and `parseJevResponse` give you the HTTP request body and
response validation. The building blocks (`collectToolCalls`, `fitState`,
`batchCalls`, `decideCall`, `applyDecisions`) are exported too.

`baseUrl` defaults to the local Laya server; no `apiKey` is needed.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `stateMode` | `local` | `local`: one small state per call; `whole`: upstream's shared whole-conversation state |
| `concurrency` | `8` | Requests in flight at once in `local` mode |
| `rules` | `true` | Settle mechanically stale calls without the judge (see [Rules](#rules-first)) |
| `baseUrl` | `http://127.0.0.1:8756/predict` | Local Laya server endpoint |
| `model` | `router` | Laya checkpoint: `router` (auto), `english`, `multilingual`, `typed-decisions` |
| `apiKey` | none | Unused for local Laya; sent as a Bearer header only if set |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Items scoring below this are always removed |
| `targetReduction` | `0.6` | Raise the cut, lowest scores first, until this share of characters is removed; `0` keeps the fixed cut |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `500` | Estimated-token ceiling for one state (per call in `local` mode) |
| `maxRequestTokens` | `620` | Estimated-token ceiling for one state plus its questions (~1000 real at Laya) |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Rules first

Some staleness is mechanical, and the judge is not asked about it:

- an **identical later call** (same tool, same input — a test re-run, a
  re-read of the same file) replaces this call's output;
- a **later `Edit`/`Write`/`MultiEdit`/`NotebookEdit` of the file this call
  read** (`file_path`/`notebook_path`) changes what a re-run would return.

Such a call keeps its line and the first `truncateHeadChars` of its output
(reason `superseded`, with the id of the later call), costs no request, and
Laya judges only the rest. `rules: false` turns this off. Bash commands that
modify files are invisible to the rules.

On the bundled ~38k-token session (`npm run demo:oversized`), Laya alone kept
the stale reads of edited files and an off-limits file at 0.6–0.7 while
dropping the one current read; with the rules the stale ones are settled
mechanically and Laya only sees the genuinely ambiguous calls.

## Context window

Upstream sends the *whole* conversation as one shared state with every
request, sized to Jev's 32k context. Laya's window is **1024 tokens**: the
installed package truncates every request there, silently, and reports the
count in `usage.input_tokens` (the README's "8192 with RoPE" is not what
`laya` 0.3.4 does). Anything past 1024 is simply never seen, which with a
whole-conversation state means the questions or the newest history. So this
fork defaults to `stateMode: 'local'`: every candidate call gets its own state,
fitted to `maxStateTokens` (500 estimated tokens, leaving room for the two
questions under the `maxRequestTokens` 620 request ceiling). The budgets are in
this library's tokenizer-free *estimate*, and Laya's tokenizer counts 1.5–1.75×
more than the estimate on code-heavy content (`npm run calibrate` measured
est 610 → 948 real, est 828 → truncated), which is why 620 estimated is the
ceiling for a ~1000-real-token request. The ratio is content-dependent (a
data-heavy transcript measured 104 of 123 requests hitting the cap at these
defaults), so the estimate is only a starting point: when Laya reports
`usage.input_tokens` at the cap the call is re-asked with a 40% smaller state,
and that shrink is shared with the rest of the run. The toast shows it as
`N re-asked after truncation`. Each state holds:

- `goal` — the last user prompts;
- `call` — the call's input and the head of its output, shrunk in steps
  (300/500 → 100/150 → 60/0 chars) until this must-have part fits;
- `after` — what happened later: one line per later tool call
  (`t14 Edit file_path=src/a.ts … → ok 40ch`) and later messages abridged.
  Lines are budgeted by priority — later calls touching the same path or
  command as this call (the strongest staleness signal: a Read followed by an
  Edit of that file, a test re-run) and later user prompts first, then the
  rest chronologically — and rendered oldest first.

One request per call (its state plus its two `noul` questions), `concurrency`
(8) in flight at once. Laya answers in ~33 ms per request on a GPU and the
server serializes them, so 50 calls is well under two seconds.

`stateMode: 'whole'` keeps upstream's shared-state behaviour for a
large-context judge; raise `maxStateTokens`/`maxRequestTokens` with it only if
a future `laya` release lifts the 1024 cap (check `usage.input_tokens`).

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Laya sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/`, calls
the local Laya server, and falls back to Claude Code's built-in summary on
errors or insufficient reduction. See [`hooks/README.md`](hooks/README.md) for
configuration and the Claude Code 2.1.274 type reference.

### Install in Claude Code

First, have the Laya server running (`python server/laya_server.py`).

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Then add this repository as a plugin marketplace and install the plugin
(replace `scaredos` with your fork's owner):

```sh
claude plugin marketplace add scaredos/fast-laya-compaction
claude plugin install fast-laya-compaction@fast-laya-compaction
```

The install prompts for the plugin options (server URL, thresholds,
`truncateHeadChars`, …); leave them at their defaults to use the local Laya
server. Set `LAYA_URL` in your settings `env` to point at a different host/port.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Laya: the toast reads
`fast-laya-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary; `pruned N/M messages for the built-in summary (…)`
when Laya removed less than `minReductionRatio` (the summarizer then reads the
pruned transcript instead of the whole one); or `fallback to built-in summary (…)`
when the server failed or was unreachable. The last 20 outcomes are kept in the
plugin store, and the server logs one line per request to
`server/laya_server.log` when started with `server/start.ps1`.

An installed plugin runs from a cached copy, not the checkout. After editing
the checkout, bump `version` in `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json`, then run
`claude plugin update fast-laya-compaction@fast-laya-compaction` and
`/reload-plugins`.

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
python server/laya_server.py &   # then, with the server up:
npm run demo                     # small live compaction
npm run demo:oversized           # ~38k-token transcript, prints every decision
npm run calibrate                # fit the token estimate to the installed laya's count
```

The unit tests use a fake asker and never hit the network. `npm run demo` is the
live check — it needs the local Laya server running (`pip install laya` first).

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
