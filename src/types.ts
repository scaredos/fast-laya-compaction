export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  keepCall: number;
  /** Jev's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped' | 'superseded';
  /** Id of the later call that made this one's output stale (`superseded` only). */
  supersededBy?: string;
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

/**
 * The state for one call in `local` mode: sized to a small judge window,
 * so it holds only the call, the head of its output, and what happened later.
 */
export interface LocalState {
  context: string;
  goal: string;
  call: {
    id: string;
    tool: string;
    input: string;
    status: 'ok' | 'error';
    chars: number;
    /** Head of the tool output, so the judge knows what kind of content it is. */
    result: string;
  };
  /** Later calls (one line each) and later messages (abridged), oldest first. */
  after: string[];
}

export type StateMode = 'local' | 'whole';

export interface CompactOptions {
  /**
   * `local` (default): one small state per call, fitted to the judge's window.
   * `whole`: the whole conversation as one shared state (needs a 32k-class judge).
   */
  stateMode?: StateMode;
  /** Requests in flight at once in `local` mode. Default 8. */
  concurrency?: number;
  /**
   * Settle mechanically stale calls without the judge: an identical later call
   * or a later Edit/Write of the file this call read. Default true.
   */
  rules?: boolean;
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /** Items scoring below this are always removed. Default 0.5. */
  keepThreshold?: number;
  /**
   * Character reduction to aim for: the cut rises above `keepThreshold`,
   * lowest-scored items first, until this much is saved or only the top score
   * is left. Laya's absolute probabilities cluster in 0.5-0.9, so only its
   * ranking is informative. 0 keeps the fixed threshold. Default 0.6.
   */
  targetReduction?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 25000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 30000. */
  maxRequestTokens?: number;
  /** Characters of a dropped tool result to retain. Default 300. */
  truncateHeadChars?: number;
}

export interface ResolvedCompactOptions {
  stateMode: StateMode;
  concurrency: number;
  rules: boolean;
  goal: string;
  keepThreshold: number;
  targetReduction: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    /** Results truncated by the rules, without a judge request. */
    superseded: number;
    /** Requests Laya truncated at its input cap and that were re-asked with a smaller state. */
    truncatedRetries: number;
    pinned: number;
    /** The keep cut actually applied (`keepThreshold`, raised toward `targetReduction`). */
    threshold: number;
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string;
    requests: number;
    ms: number;
  };
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}
