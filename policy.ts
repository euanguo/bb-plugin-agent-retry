// agent-retry — the decision engine.
//
// Pure functions over plain data: no BB imports, no clock, no randomness of
// its own. Everything time- or luck-dependent arrives in `DecisionInput`, so
// the whole policy is unit-testable and `bb agent-retry simulate` can replay
// a failure shape without waiting for one.

export type BackoffStrategy = "exponential" | "linear" | "fixed";

/** The backoff knobs one layer (defaults or a rule) can set. */
export interface BackoffSettings {
  strategy: BackoffStrategy;
  /** Delay before the first retry, before growth and jitter. */
  baseDelayMs: number;
  /**
   * Growth per attempt. Exponential multiplies by it; linear treats
   * `growth - 1` as the fraction added per attempt. `1` means flat.
   */
  growth: number;
  /** Ceiling for one wait, applied before jitter. */
  maxDelayMs: number;
  /** Symmetric jitter, as a percentage of the computed delay. */
  jitterPct: number;
}

/**
 * One override layer. Every field is optional so a rule can name only what it
 * changes; anything it omits falls through to the resolved defaults.
 */
export interface RetryRule extends Partial<BackoffSettings> {
  /** Absent means "retry" — a rule exists to say something, and skip is louder. */
  action?: "retry" | "skip";
  /** Total attempts this rule allows, counting the original dispatch as 1. */
  maxAttempts?: number;
  /** Replaces the reason shown on the queued row. */
  reason?: string;
  /** Label for the log line; defaults to the rule's key. */
  label?: string;
}

export interface CompiledMessageRule extends RetryRule {
  pattern: RegExp;
  /** The pattern as written, for logs and `explain`. */
  source: string;
}

export interface ScopeSettings {
  /** Allowlists: empty means "every project". */
  projects: string[];
  excludeProjects: string[];
  providers: string[];
  excludeProviders: string[];
  excludeThreads: string[];
  /** When non-empty, a thread id must match at least one. */
  threadPatterns: RegExp[];
  retryHidden: boolean;
  retryChild: boolean;
  /**
   * Which half of the failure space to retry, by whether the provider had
   * taken the input. A request refused at the door is usually a configuration
   * error that fails identically forever, and it is the one distinction that
   * does not need the provider's error text — which a failure may not have.
   */
  inputAccepted: "either" | "accepted" | "rejected";
}

export interface RetryPolicy {
  defaults: BackoffSettings & { maxAttempts: number };
  /** Categories that fail the same way every time, matched case-insensitively. */
  skipCategories: string[];
  /** Retry a failure that carried no structured classification. */
  retryWhenUnknown: boolean;
  /** Give up once a chain has been retrying this long. 0 disables. */
  maxTotalSpanMs: number;
  /** Give up when the next attempt is further away than this. 0 disables. */
  maxWaitMs: number;
  /** Floor the wait at a reported rate-limit reset. */
  honorRateLimitReset: boolean;
  /** Padding added after that reset, for clock skew. */
  resetPadMs: number;
  scope: ScopeSettings;
  /** Keyed by error category, plus `"*"` as the catch-all. */
  categoryRules: Record<string, RetryRule>;
  /** Tried in order against the failure's error text; first match wins. */
  messageRules: CompiledMessageRule[];
}

export interface DecisionInput {
  threadId: string;
  projectId: string | null;
  providerId: string | null;
  requestId: string;
  turnId: string | null;
  /** The attempt that just failed: 1 is the original dispatch. */
  attemptNumber: number;
  errorInfo: {
    category: string;
    providerCode?: string | null;
    httpStatusCode?: number | null;
  } | null;
  inputAccepted: boolean;
  rateLimits: {
    status: string;
    kind?: string;
    windows?: readonly { status: string; resetsAtMs: number | null }[];
  } | null;
  /** The provider's own words, when we could read them. */
  errorText: string | null;
  visibility: string | null;
  parentThreadId: string | null;
  /** When this retry chain's first failure was seen, if we have it. */
  chainStartedAt: number | null;
  now: number;
  /** Uniform sample in [0, 1); 0.5 means no jitter. */
  random: number;
}

export interface RetryDecision {
  action: "retry";
  /** Milliseconds from `now` to the next attempt, after jitter and floors. */
  delayMs: number;
  sendAt: number;
  /** Shown verbatim on the queued row; keep it under 200 characters. */
  reason: string;
  /** Which layer decided, for the log and for `bb agent-retry log`. */
  rule: string;
  maxAttempts: number;
}

export interface SkipDecision {
  action: "skip";
  reason: string;
  rule: string;
}

export type Decision = RetryDecision | SkipDecision;

export const REASON_MAX_LENGTH = 200;

/** Backoff for the wait after attempt `attemptNumber`, before jitter. */
export function computeDelayMs(
  settings: BackoffSettings,
  attemptNumber: number,
): number {
  // A counter that is not a finite number is read as "the first attempt"
  // rather than as the largest exponent: an unparseable value should give the
  // shortest wait, never the longest.
  const step = Number.isFinite(attemptNumber)
    ? Math.max(1, Math.floor(attemptNumber))
    : 1;
  let raw: number;
  switch (settings.strategy) {
    case "fixed":
      raw = settings.baseDelayMs;
      break;
    case "linear":
      raw = settings.baseDelayMs * (1 + (step - 1) * (settings.growth - 1));
      break;
    case "exponential":
    default:
      raw = settings.baseDelayMs * Math.pow(settings.growth, step - 1);
      break;
  }
  if (!Number.isFinite(raw)) return settings.maxDelayMs;
  return Math.max(0, Math.round(Math.min(raw, settings.maxDelayMs)));
}

/** Symmetric jitter around `delayMs`; `random` of 0.5 returns it unchanged. */
export function applyJitter(
  delayMs: number,
  jitterPct: number,
  random: number,
): number {
  if (jitterPct <= 0) return Math.round(delayMs);
  const sample = Math.min(1, Math.max(0, random));
  const factor = 1 + (sample * 2 - 1) * (jitterPct / 100);
  return Math.max(0, Math.round(delayMs * factor));
}

/**
 * The wait before each attempt for the first `count` attempts, for
 * `explain`/`status` so a policy can be read at a glance instead of inferred.
 * Uses a mid-sample random, so the numbers are the un-jittered centre.
 */
export function previewSchedule(
  policy: RetryPolicy,
  count: number,
): { attempt: number; delayMs: number }[] {
  const attempts = Math.max(0, Math.min(count, policy.defaults.maxAttempts));
  const rows: { attempt: number; delayMs: number }[] = [];
  for (let attempt = 1; attempt < attempts; attempt++) {
    rows.push({
      attempt: attempt + 1,
      delayMs: computeDelayMs(policy.defaults, attempt),
    });
  }
  return rows;
}

function mergeSettings(
  defaults: BackoffSettings & { maxAttempts: number },
  rule: RetryRule | null,
): BackoffSettings & { maxAttempts: number } {
  if (rule === null) return defaults;
  return {
    strategy: rule.strategy ?? defaults.strategy,
    baseDelayMs: rule.baseDelayMs ?? defaults.baseDelayMs,
    growth: rule.growth ?? defaults.growth,
    maxDelayMs: rule.maxDelayMs ?? defaults.maxDelayMs,
    jitterPct: rule.jitterPct ?? defaults.jitterPct,
    maxAttempts: rule.maxAttempts ?? defaults.maxAttempts,
  };
}

function checkScope(input: DecisionInput, scope: ScopeSettings): string | null {
  if (
    scope.projects.length > 0 &&
    (input.projectId === null || !scope.projects.includes(input.projectId))
  ) {
    return `project ${input.projectId ?? "(unknown)"} is not in scopeProjects`;
  }
  if (input.projectId !== null && scope.excludeProjects.includes(input.projectId)) {
    return `project ${input.projectId} is excluded`;
  }
  if (
    scope.providers.length > 0 &&
    (input.providerId === null || !scope.providers.includes(input.providerId))
  ) {
    return `provider ${input.providerId ?? "(unknown)"} is not in scopeProviders`;
  }
  if (
    input.providerId !== null &&
    scope.excludeProviders.includes(input.providerId)
  ) {
    return `provider ${input.providerId} is excluded`;
  }
  if (scope.excludeThreads.includes(input.threadId)) {
    return "thread is excluded";
  }
  if (
    scope.threadPatterns.length > 0 &&
    !scope.threadPatterns.some((pattern) => pattern.test(input.threadId))
  ) {
    return "thread id matches no threadPatterns entry";
  }
  if (!scope.retryHidden && input.visibility === "hidden") {
    return "hidden thread and retryHidden is off";
  }
  if (!scope.retryChild && input.parentThreadId !== null) {
    return "child thread and retryChild is off";
  }
  if (scope.inputAccepted === "accepted" && !input.inputAccepted) {
    return "the provider never took the input, and scope.inputAccepted is accepted";
  }
  if (scope.inputAccepted === "rejected" && input.inputAccepted) {
    return "the provider took the input, and scope.inputAccepted is rejected";
  }
  return null;
}

interface ResolvedRule {
  rule: RetryRule | null;
  key: string;
}

/**
 * First match wins: message rules (the provider's own words) beat category
 * rules, a specific category beats the `"*"` catch-all, and no rule at all
 * leaves the defaults and the default skip list in charge.
 */
function resolveRule(input: DecisionInput, policy: RetryPolicy): ResolvedRule {
  if (input.errorText !== null) {
    for (const rule of policy.messageRules) {
      if (rule.pattern.test(input.errorText)) {
        return { rule, key: `message:${rule.source}` };
      }
    }
  }
  const category = input.errorInfo?.category;
  if (category !== undefined && category !== null) {
    const exact = policy.categoryRules[category];
    if (exact !== undefined) return { rule: exact, key: `category:${category}` };
    const lowered = category.toLowerCase();
    const loweredRule = policy.categoryRules[lowered];
    if (loweredRule !== undefined) {
      return { rule: loweredRule, key: `category:${lowered}` };
    }
  }
  const catchAll = policy.categoryRules["*"];
  if (catchAll !== undefined) return { rule: catchAll, key: "category:*" };
  return { rule: null, key: "defaults" };
}

function latestResetAt(input: DecisionInput): number | null {
  const windows = input.rateLimits?.windows ?? [];
  const resets = windows
    .map((window) => window.resetsAtMs)
    .filter((value): value is number => typeof value === "number");
  if (resets.length === 0) return null;
  return Math.max(...resets);
}

function defaultReason(input: DecisionInput, maxAttempts: number): string {
  const category = input.errorInfo?.category ?? "unclassified failure";
  return clampReason(
    `Agent retry ${input.attemptNumber + 1}/${maxAttempts} — ${category}`,
  );
}

export function clampReason(reason: string): string {
  const collapsed = reason.replace(/\s+/gu, " ").trim();
  return collapsed.length <= REASON_MAX_LENGTH
    ? collapsed
    : `${collapsed.slice(0, REASON_MAX_LENGTH - 1)}…`;
}

/**
 * Decide what to do with one failed turn. The caller owns `dryRun`: this
 * function always reports the retry it would queue.
 */
export function decideRetry(
  input: DecisionInput,
  policy: RetryPolicy,
): Decision {
  const scopeSkip = checkScope(input, policy.scope);
  if (scopeSkip !== null) {
    return { action: "skip", reason: scopeSkip, rule: "scope" };
  }

  const { rule, key } = resolveRule(input, policy);
  const effective = mergeSettings(policy.defaults, rule);
  const attempt = Number.isFinite(input.attemptNumber)
    ? Math.max(1, Math.floor(input.attemptNumber))
    : 1;

  if (attempt >= effective.maxAttempts) {
    return {
      action: "skip",
      reason: `attempts exhausted (${attempt}/${effective.maxAttempts})`,
      rule: key,
    };
  }

  if (rule?.action === "skip") {
    return {
      action: "skip",
      reason: rule.reason ?? `rule ${key} declines to retry`,
      rule: key,
    };
  }

  // The default skip list only applies when nothing more specific matched, so
  // a category rule or message rule can always force a retry back on.
  if (rule === null) {
    const category = input.errorInfo?.category ?? null;
    if (category === null) {
      if (!policy.retryWhenUnknown) {
        return {
          action: "skip",
          reason: "failure carried no structured error info",
          rule: key,
        };
      }
    } else if (policy.skipCategories.includes(category.toLowerCase())) {
      return {
        action: "skip",
        reason: `category ${category} is in skipCategories`,
        rule: key,
      };
    }
  }

  if (policy.maxTotalSpanMs > 0 && input.chainStartedAt !== null) {
    const elapsed = input.now - input.chainStartedAt;
    if (elapsed >= policy.maxTotalSpanMs) {
      return {
        action: "skip",
        reason: `chain has been retrying for ${Math.round(elapsed / 1000)}s, past maxTotalSpanMs`,
        rule: key,
      };
    }
  }

  let sendAt =
    input.now + applyJitter(computeDelayMs(effective, attempt), effective.jitterPct, input.random);
  let label = key;

  if (
    policy.honorRateLimitReset &&
    input.rateLimits?.status === "blocked"
  ) {
    const resetAt = latestResetAt(input);
    if (resetAt !== null) {
      const floor = resetAt + policy.resetPadMs;
      if (floor > sendAt) {
        sendAt = floor;
        label = `${key}+rate-limit-reset`;
      }
    }
  }

  const waitMs = Math.max(0, sendAt - input.now);
  if (policy.maxWaitMs > 0 && waitMs > policy.maxWaitMs) {
    return {
      action: "skip",
      reason: `next attempt is ${Math.round(waitMs / 1000)}s away, past maxWaitMs`,
      rule: label,
    };
  }

  return {
    action: "retry",
    delayMs: waitMs,
    sendAt,
    reason: clampReason(rule?.reason ?? defaultReason(input, effective.maxAttempts)),
    rule: rule?.label ?? label,
    maxAttempts: effective.maxAttempts,
  };
}
