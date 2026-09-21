import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState, localState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  // `local`: one small state per call, so Laya's 1024-token window holds the
  // call, its output head and what happened after it. `whole` is upstream's
  // shared whole-conversation state; only useful with a 32k-class judge.
  stateMode: 'local',
  concurrency: 8,
  rules: true,
  goal: '',
  keepThreshold: 0.5,
  targetReduction: 0.6,
  preserveRecentMessages: 6,
  // Ceiling is Laya's window, not Jev's 32k: laya 0.3.4 silently truncates
  // every request at 1024 tokens (it reports the count in usage.input_tokens).
  // These are *estimated* tokens, and Laya's tokenizer counts 1.5-1.75x more
  // than the estimate on code-heavy content (examples/calibrate.ts measured
  // est 610 -> 948 real, est 828 -> truncated), so 620 estimated for a whole
  // request lands at ~1000 real.
  // ponytail: constant safety factor; a real tokenizer if it wastes too much.
  maxStateTokens: 500,
  maxRequestTokens: 620,
  truncateHeadChars: 300,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;
/** Laya silently truncates its input here; `usage.input_tokens` lands exactly on it when it did. */
export const LAYA_MAX_INPUT_TOKENS = 1024;
const RETRY_SHRINK = 0.6;
const MIN_BUDGET_TOKENS = 120;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    stateMode: options.stateMode === 'whole' ? 'whole' : 'local',
    concurrency: Math.max(1, Math.floor(finite(options.concurrency, DEFAULT_OPTIONS.concurrency))),
    rules: options.rules ?? DEFAULT_OPTIONS.rules,
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    targetReduction: Math.min(1, Math.max(0, finite(options.targetReduction, DEFAULT_OPTIONS.targetReduction))),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      // Tried explicit true/false `criteria` here: Laya's probabilities collapsed
      // to ~0.5 and the extra text cost a third of the state budget. Plain
      // instructions discriminate better (examples/oversized.ts).
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATH_KEYS = ['file_path', 'notebook_path'] as const;

function pathOf(call: Pick<ToolCall, 'input'>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = call.input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Mechanical staleness, settled without the judge: an identical later call
 * (same tool, same input) replaces this one's output, and a later Edit/Write
 * of the file this call read changes what a re-run would return. Returns the
 * oldest such later call.
 */
// ponytail: O(n²) over calls and file_path/notebook_path only (a Bash `sed`
// is invisible); index by path/input if sessions get huge.
export function supersededBy(call: ToolCall, calls: readonly ToolCall[]): ToolCall | undefined {
  const input = JSON.stringify(call.input);
  const path = pathOf(call);
  return calls.find(
    (later) =>
      later.callIndex > call.callIndex &&
      ((later.tool === call.tool && JSON.stringify(later.input) === input) ||
        (path !== undefined && WRITERS.has(later.tool) && pathOf(later) === path)),
  );
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep item order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** One call, one request: its own small state plus its two questions. */
async function askLocal(
  asker: JevAsker,
  messages: readonly Message[],
  calls: readonly ToolCall[],
  call: ToolCall,
  options: ResolvedCompactOptions,
  calibration: { scale: number },
): Promise<{ answer: CallAnswer; tokens: number; retries: number }> {
  const questions = questionsFor(call);
  const base = Math.min(
    options.maxStateTokens,
    options.maxRequestTokens - estimateTokens(JSON.stringify(questions)) - REQUEST_OVERHEAD_TOKENS,
  );
  let budget = Math.floor(base * calibration.scale);
  // The estimator undercounts Laya's tokenizer by a content-dependent factor
  // (1.5x on code, more on data-heavy transcripts). Laya reports the cap in
  // `usage` when it truncated, so shrink and ask again rather than judge on a
  // cut-off state; the shrink is shared so later calls in the run start there.
  let retries = 0;
  for (;;) {
    const { state, tokens } = localState(messages, calls, call, options, budget);
    const { answers, usage } = await asker.ask(state, questions);
    const truncated = (usage?.input_tokens ?? 0) >= LAYA_MAX_INPUT_TOKENS;
    if (!truncated || budget <= MIN_BUDGET_TOKENS) {
      return {
        answer: {
          keepCall: noulAnswer(answers, `call_${call.id}`),
          keepResult: noulAnswer(answers, `result_${call.id}`),
        },
        tokens,
        retries,
      };
    }
    budget = Math.max(MIN_BUDGET_TOKENS, Math.floor(budget * RETRY_SHRINK));
    calibration.scale = Math.min(calibration.scale, budget / base);
    retries += 1;
  }
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking the judge, for every tool call outside the
 * pinned first and newest messages, whether the call and whether its result
 * must stay. In `local` mode each call gets its own small state (the call, its
 * output head, what happened after) and one request. In `whole` mode the whole
 * history (results omitted, fitted into `maxStateTokens`) is sent with every
 * batch of questions. Throws when the judge fails or the history cannot be
 * fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  // Rules first: what is stale by construction never reaches the judge.
  const ruled = new Map<string, CallDecision>();
  if (resolved.rules) {
    for (const call of calls) {
      if (call.pinned) continue;
      const by = supersededBy(call, calls);
      if (by) {
        ruled.set(call.id, {
          id: call.id,
          tool: call.tool,
          keepCall: 1,
          keepResult: 0,
          action: 'drop_result',
          reason: 'superseded',
          supersededBy: by.id,
        });
      }
    }
  }
  const candidates = calls.filter((call) => !call.pinned && !ruled.has(call.id));

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let requests = 0;
  let truncatedRetries = 0;
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0 && resolved.stateMode === 'local') {
    const calibration = { scale: 1 };
    const asked = await mapLimit(candidates, resolved.concurrency, (call) =>
      askLocal(asker, messages, calls, call, resolved, calibration),
    );
    asked.forEach((a, index) => answers.set(candidates[index]!.id, a.answer));
    fitted = { tokens: Math.max(...asked.map((a) => a.tokens)), stage: 'local' };
    truncatedRetries = asked.reduce((sum, a) => sum + a.retries, 0);
    requests = candidates.length + truncatedRetries;
  } else if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    const batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await Promise.all(
      batches.map((batch) => askBatch(asker, state.state, batch)),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
    requests = batches.length;
  }

  const decide = (threshold: number) => {
    const decisions = calls.map(
      (call) =>
        ruled.get(call.id) ??
        decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, { keepThreshold: threshold }),
    );
    const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
    return { decisions, kept, charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0) };
  };
  // Laya's probabilities bunch up in 0.5-0.9, so a fixed cut keeps nearly
  // everything; walk the cut up its ranking until the target is saved.
  let threshold = resolved.keepThreshold;
  let applied = decide(threshold);
  const cuts = [...new Set([...answers.values()].flatMap((a) => [a.keepCall, a.keepResult]))]
    .filter((cut) => cut > threshold)
    .sort((a, b) => a - b);
  for (const cut of cuts) {
    if (charsBefore - applied.charsAfter >= resolved.targetReduction * charsBefore) break;
    threshold = cut;
    applied = decide(threshold);
  }
  const { decisions, kept, charsAfter } = applied;
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter,
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      superseded: count(decisions, 'superseded'),
      truncatedRetries,
      pinned: count(decisions, 'pinned'),
      threshold,
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests,
      ms: Date.now() - started,
    },
  };
}
