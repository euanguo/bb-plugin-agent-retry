// agent-retry — configuration surface.
//
// Two layers, because they answer different questions:
//
//   1. Flat settings (Settings → Installed plugins, `bb plugin config`) are
//      the base policy: one set of numbers that applies to every failure.
//   2. `advancedJson` is the override layer: per-category rules, per-message
//      rules, and scope. It wins over the flat layer wherever it speaks, and
//      every decision records which layer decided, so a surprising outcome is
//      always attributable.
//
// `advancedJson` defaults to `{}`, so the two layers only disagree once the
// operator opts in.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  type BackoffStrategy,
  type CompiledMessageRule,
  type RetryPolicy,
  type RetryRule,
  type ScopeSettings,
} from "./policy.js";

/**
 * Categories that fail identically on every attempt without a human changing
 * something. Retrying them burns the budget and delays the real fix, so they
 * are declined by default. An explicit category rule or message rule can put
 * any of them back in.
 */
export const DEFAULT_SKIP_CATEGORIES = [
  "billing",
  "budget-exceeded",
  "unauthorized",
  "policy",
  "bad-request",
  "context-window-exceeded",
  "too-many-failed-attempts",
  "active-turn-not-steerable",
].join(",");

const backoffStrategySchema = z.enum(["exponential", "linear", "fixed"]);

const ruleSchema = z
  .object({
    action: z.enum(["retry", "skip"]).optional(),
    maxAttempts: z.number().int().min(1).max(1000).optional(),
    strategy: backoffStrategySchema.optional(),
    baseDelayMs: z.number().min(0).max(86_400_000).optional(),
    growth: z.number().min(1).max(10).optional(),
    maxDelayMs: z.number().min(0).max(86_400_000).optional(),
    jitterPct: z.number().min(0).max(100).optional(),
    reason: z.string().max(200).optional(),
    label: z.string().max(120).optional(),
  })
  .strict();

const messageRuleSchema = ruleSchema.extend({
  pattern: z.string().min(1).max(500),
  flags: z.string().max(8).optional(),
});

const scopeSchema = z
  .object({
    projects: z.array(z.string().min(1)).max(500).optional(),
    excludeProjects: z.array(z.string().min(1)).max(500).optional(),
    providers: z.array(z.string().min(1)).max(500).optional(),
    excludeProviders: z.array(z.string().min(1)).max(500).optional(),
    excludeThreads: z.array(z.string().min(1)).max(500).optional(),
    threadPatterns: z.array(z.string().min(1)).max(200).optional(),
    retryHidden: z.boolean().optional(),
    retryChild: z.boolean().optional(),
    inputAccepted: z.enum(["either", "accepted", "rejected"]).optional(),
  })
  .strict();

export const advancedPolicySchema = z
  .object({
    defaults: ruleSchema.optional(),
    categoryRules: z.record(z.string().min(1), ruleSchema).optional(),
    messageRules: z.array(messageRuleSchema).max(200).optional(),
    scope: scopeSchema.optional(),
  })
  .strict();

export type AdvancedPolicy = z.infer<typeof advancedPolicySchema>;

/** Compile one regular expression, normalising flags so `.test` is stateless. */
export function compilePattern(source: string, flags = ""): RegExp {
  const normalised = flags.replace(/[gy]/gu, "");
  try {
    return new RegExp(source, normalised);
  } catch (error) {
    throw new Error(
      `invalid regular expression /${source}/${flags}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read a list of patterns, one per line. Blank lines and `#` comments are
 * skipped so a long list stays readable in the settings editor.
 */
export function parsePatternLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function parseList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseAdvancedJson(text: string): AdvancedPolicy {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  const parsed: unknown = JSON.parse(trimmed);
  return advancedPolicySchema.parse(parsed);
}

/** Validate the advanced JSON field in the settings editor, with a real message. */
export const advancedJsonFieldSchema = z.string().superRefine((value, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim().length === 0 ? "{}" : value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  const result = advancedPolicySchema.safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({
      code: "custom",
      message: result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    });
    return;
  }
  for (const [index, rule] of (result.data.messageRules ?? []).entries()) {
    try {
      compilePattern(rule.pattern, rule.flags);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: `messageRules[${index}].pattern: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
});

/** Validate the multiline `threadPatterns` field the same way. */
export const threadPatternsFieldSchema = z.string().superRefine((value, ctx) => {
  for (const line of parsePatternLines(value)) {
    try {
      compilePattern(line);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
});

export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Enabled",
      description: "Master switch. Off means a failed turn is left exactly as core left it.",
      default: true,
    },
    dryRun: {
      type: "boolean",
      label: "Dry run",
      description:
        "Decide and log what would be retried, but never queue a retry. Use this " +
        "first when tuning a new policy — `bb agent-retry log` shows the decisions.",
      default: false,
    },
    maxAttempts: {
      type: "number",
      label: "Max attempts",
      description:
        "Total attempts in one retry chain, counting the original dispatch as " +
        "attempt 1. 50 means the original plus 49 retries.",
      experimental_schema: z.number().int().min(1).max(1000),
      default: 50,
    },
    strategy: {
      type: "select",
      label: "Backoff shape",
      description:
        "exponential multiplies each wait by Growth. linear adds (Growth - 1) of " +
        "the base per attempt. fixed repeats Base delay.",
      options: ["exponential", "linear", "fixed"],
      default: "exponential",
    },
    baseDelayMs: {
      type: "number",
      label: "Base delay (ms)",
      description: "Wait before the first retry, before growth and jitter.",
      experimental_schema: z.number().int().min(0).max(3_600_000),
      default: 30_000,
    },
    growth: {
      type: "number",
      label: "Growth",
      description:
        "Per-attempt multiplier for exponential, or the per-attempt fraction " +
        "plus one for linear (1.6 = +60% of the base each attempt). 1 is flat.",
      experimental_schema: z.number().min(1).max(10),
      default: 1.6,
    },
    maxDelayMs: {
      type: "number",
      label: "Max delay (ms)",
      description: "Ceiling for a single wait. 900000 = 15 minutes.",
      experimental_schema: z.number().int().min(0).max(86_400_000),
      default: 900_000,
    },
    jitterPct: {
      type: "number",
      label: "Jitter (%)",
      description:
        "Symmetric random spread around each wait, so many threads that failed " +
        "together do not come back together.",
      experimental_schema: z.number().min(0).max(100),
      default: 15,
    },
    maxTotalSpanMs: {
      type: "number",
      label: "Max chain span (ms)",
      description:
        "Stop retrying once a chain has been going this long, measured from its " +
        "first failure. 0 disables the limit. 0 with 50 attempts and a 15-minute " +
        "cap is roughly 11 hours.",
      experimental_schema: z.number().int().min(0),
      default: 0,
    },
    maxWaitMs: {
      type: "number",
      label: "Max single wait (ms)",
      description:
        "Decline when the next attempt would be further away than this — the " +
        "check a long rate-limit reset runs into. 0 disables the limit.",
      experimental_schema: z.number().int().min(0),
      default: 0,
    },
    retryWhenUnknown: {
      type: "boolean",
      label: "Retry unclassified failures",
      description:
        "Retry a failure that carried no structured error info — a provider " +
        "bridge that reported only a message, a process that died mid-stream. " +
        "This is the case the built-in provider-retry plugin declines.",
      default: true,
    },
    skipCategories: {
      type: "string",
      label: "Never retry categories",
      description:
        "Comma-separated ProviderErrorCategory values that fail the same way " +
        "every time. A category rule or message rule overrides this list.",
      default: DEFAULT_SKIP_CATEGORIES,
    },
    honorRateLimitReset: {
      type: "boolean",
      label: "Wait for rate-limit resets",
      description:
        "When the provider reports a blocked window with a reset time, never " +
        "come back before it.",
      default: true,
    },
    resetPadMs: {
      type: "number",
      label: "Reset padding (ms)",
      description: "Added after a reported reset, for clock skew.",
      experimental_schema: z.number().int().min(0).max(3_600_000),
      default: 15_000,
    },
    scopeProjects: {
      type: "string",
      label: "Only these projects",
      description:
        "Comma-separated proj_* ids. Empty retries every project. Applies to " +
        "every thread the plugin sees, including other projects' threads.",
      default: "",
    },
    inputAccepted: {
      type: "select",
      label: "Retry which failures",
      description:
        "either retries every failure. accepted skips a request the provider " +
        "never took, which is usually a configuration error that fails the " +
        "same way every time. rejected retries only those.",
      options: ["either", "accepted", "rejected"],
      default: "either",
    },
    excludeProjects: {
      type: "string",
      label: "Never these projects",
      description: "Comma-separated proj_* ids to leave alone.",
      default: "",
    },
    scopeProviders: {
      type: "string",
      label: "Only these providers",
      description:
        "Comma-separated provider ids (pi, codex, claude-code, …). Empty retries " +
        "every provider.",
      default: "",
    },
    excludeProviders: {
      type: "string",
      label: "Never these providers",
      description: "Comma-separated provider ids to leave alone.",
      default: "",
    },
    excludeThreads: {
      type: "string",
      label: "Never these threads",
      description: "Comma-separated thr_* ids to leave alone.",
      default: "",
    },
    threadPatterns: {
      type: "string",
      label: "Only matching thread ids",
      description:
        "One regular expression per line, matched against the thread id; a " +
        "thread must match at least one. Blank lines and # comments are ignored.",
      experimental_multiline: true,
      experimental_schema: threadPatternsFieldSchema,
      default: "",
    },
    retryHidden: {
      type: "boolean",
      label: "Retry hidden threads",
      description: "Hidden threads are background workers spawned by plugins.",
      default: true,
    },
    retryChild: {
      type: "boolean",
      label: "Retry child threads",
      description: "Child threads report their turns to a parent thread.",
      default: true,
    },
    logDecisions: {
      type: "boolean",
      label: "Keep a decision log",
      description:
        "Record every retry, skip, and failure in the plugin database for " +
        "`bb agent-retry log`. Off means only the plugin log keeps them.",
      default: true,
    },
    advancedJson: {
      type: "string",
      label: "Advanced policy (JSON)",
      description:
        'Overrides the flat settings above. {"defaults":{…}, "categoryRules":' +
        '{"overloaded":{…},"*":{…}}, "messageRules":[{"pattern":"…","flags":"i",' +
        '"action":"retry","maxAttempts":20}], "scope":{…}}. See the plugin skill.',
      experimental_multiline: true,
      experimental_schema: advancedJsonFieldSchema,
      default: "{}",
    },
  });
}

export type RetrySettings = ReturnType<typeof defineSettings>;

export interface ResolvedPolicy {
  policy: RetryPolicy;
  /** The master switch. Read by the caller, not by `decideRetry`. */
  enabled: boolean;
  /** Read by the caller, not by `decideRetry`. */
  dryRun: boolean;
  logDecisions: boolean;
  /** The advanced layer as parsed, for `explain`. */
  advanced: AdvancedPolicy;
  /**
   * Configuration the plugin could not use. A stored value can outlive the
   * schema that wrote it, and silently ignoring it would make the plugin look
   * like it is obeying a policy it is not, so every caller can surface these.
   */
  problems: string[];
}

function mergeList(
  base: string,
  override: readonly string[] | undefined,
): string[] {
  return override !== undefined && override.length > 0
    ? [...override]
    : parseList(base);
}

function compileScope(
  advanced: AdvancedPolicy,
  flat: {
    scopeProjects: string;
    excludeProjects: string;
    scopeProviders: string;
    excludeProviders: string;
    excludeThreads: string;
    threadPatterns: string;
    retryHidden: boolean;
    retryChild: boolean;
    inputAccepted: string;
  },
): ScopeSettings {
  const scope = advanced.scope ?? {};
  return {
    projects: mergeList(flat.scopeProjects, scope.projects),
    excludeProjects: mergeList(flat.excludeProjects, scope.excludeProjects),
    providers: mergeList(flat.scopeProviders, scope.providers),
    excludeProviders: mergeList(flat.excludeProviders, scope.excludeProviders),
    excludeThreads: mergeList(flat.excludeThreads, scope.excludeThreads),
    threadPatterns:
      scope.threadPatterns !== undefined && scope.threadPatterns.length > 0
        ? scope.threadPatterns.map((pattern) => compilePattern(pattern))
        : parsePatternLines(flat.threadPatterns).map((pattern) =>
            compilePattern(pattern),
          ),
    retryHidden: scope.retryHidden ?? flat.retryHidden,
    retryChild: scope.retryChild ?? flat.retryChild,
    inputAccepted: (scope.inputAccepted ??
      flat.inputAccepted) as ScopeSettings["inputAccepted"],
  };
}

function compileMessageRules(
  advanced: AdvancedPolicy,
): CompiledMessageRule[] {
  return (advanced.messageRules ?? []).map((rule) => ({
    ...rule,
    pattern: compilePattern(rule.pattern, rule.flags),
    source: rule.flags ? `${rule.pattern}/${rule.flags}` : rule.pattern,
  }));
}

function normaliseCategoryRules(
  advanced: AdvancedPolicy,
): Record<string, RetryRule> {
  const rules: Record<string, RetryRule> = {};
  for (const [key, rule] of Object.entries(advanced.categoryRules ?? {})) {
    rules[key === "*" ? "*" : key.toLowerCase()] = rule;
  }
  return rules;
}

/** Build the effective policy from both configuration layers. */
export async function resolvePolicy(
  settings: RetrySettings,
): Promise<ResolvedPolicy> {
  const values = await settings.get();
  const problems: string[] = [];
  let advanced: AdvancedPolicy = {};
  try {
    advanced = parseAdvancedJson(values.advancedJson);
  } catch (error) {
    // The field is schema-validated on save, so this only fires when a stored
    // value predates the current schema. Fall back to the flat layer — losing
    // retries entirely would be worse — but say so, loudly enough that an
    // operator reading `bb agent-retry explain` sees the override is not in
    // force.
    problems.push(
      `advancedJson was ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const defaults = advanced.defaults ?? {};
  let scope: ScopeSettings;
  try {
    scope = compileScope(advanced, values);
  } catch (error) {
    problems.push(
      `scope was ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
    scope = compileScope({}, values);
  }
  let messageRules: CompiledMessageRule[];
  try {
    messageRules = compileMessageRules(advanced);
  } catch (error) {
    problems.push(
      `messageRules were ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
    messageRules = [];
  }
  return {
    enabled: values.enabled,
    dryRun: values.dryRun,
    logDecisions: values.logDecisions,
    advanced,
    problems,
    policy: {
      defaults: {
        strategy: (defaults.strategy ?? values.strategy) as BackoffStrategy,
        baseDelayMs: defaults.baseDelayMs ?? values.baseDelayMs,
        growth: defaults.growth ?? values.growth,
        maxDelayMs: defaults.maxDelayMs ?? values.maxDelayMs,
        jitterPct: defaults.jitterPct ?? values.jitterPct,
        maxAttempts: defaults.maxAttempts ?? values.maxAttempts,
      },
      skipCategories: parseList(values.skipCategories).map((entry) =>
        entry.toLowerCase(),
      ),
      retryWhenUnknown: values.retryWhenUnknown,
      maxTotalSpanMs: values.maxTotalSpanMs,
      maxWaitMs: values.maxWaitMs,
      honorRateLimitReset: values.honorRateLimitReset,
      resetPadMs: values.resetPadMs,
      scope,
      categoryRules: normaliseCategoryRules(advanced),
      messageRules,
    },
  };
}
