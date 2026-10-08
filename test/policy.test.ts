import { describe, expect, it } from "vitest";
import { DEFAULT_SKIP_CATEGORIES } from "../config.js";
import {
  applyJitter,
  clampReason,
  computeDelayMs,
  decideRetry,
  previewSchedule,
  REASON_MAX_LENGTH,
  type DecisionInput,
  type RetryPolicy,
} from "../policy.js";

function defaultPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    defaults: {
      strategy: "exponential",
      baseDelayMs: 30_000,
      growth: 1.6,
      maxDelayMs: 900_000,
      jitterPct: 0,
      maxAttempts: 50,
    },
    skipCategories: DEFAULT_SKIP_CATEGORIES.split(","),
    retryWhenUnknown: true,
    maxTotalSpanMs: 0,
    maxWaitMs: 0,
    honorRateLimitReset: true,
    resetPadMs: 15_000,
    scope: {
      projects: [],
      excludeProjects: [],
      providers: [],
      excludeProviders: [],
      excludeThreads: [],
      threadPatterns: [],
      retryHidden: true,
      retryChild: true,
      inputAccepted: "either",
    },
    categoryRules: {},
    messageRules: [],
    ...overrides,
  };
}

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    threadId: "thr_vw76j3963s",
    projectId: "proj_n3m2etzs9m",
    providerId: "pi",
    requestId: "req_1",
    turnId: "turn_1",
    attemptNumber: 1,
    errorInfo: null,
    inputAccepted: true,
    rateLimits: null,
    errorText: null,
    visibility: "visible",
    parentThreadId: null,
    chainStartedAt: null,
    now: 1_800_000_000_000,
    random: 0.5,
    ...overrides,
  };
}

describe("backoff", () => {
  it("grows exponentially and stops at the cap", () => {
    const settings = {
      strategy: "exponential" as const,
      baseDelayMs: 30_000,
      growth: 1.6,
      maxDelayMs: 900_000,
      jitterPct: 0,
    };
    expect(computeDelayMs(settings, 1)).toBe(30_000);
    expect(computeDelayMs(settings, 2)).toBe(48_000);
    expect(computeDelayMs(settings, 3)).toBe(76_800);
    // 1.6^20 is astronomically past the cap.
    expect(computeDelayMs(settings, 20)).toBe(900_000);
  });

  it("adds a fixed fraction of the base per attempt when linear", () => {
    const settings = {
      strategy: "linear" as const,
      baseDelayMs: 10_000,
      growth: 2,
      maxDelayMs: 900_000,
      jitterPct: 0,
    };
    expect(computeDelayMs(settings, 1)).toBe(10_000);
    expect(computeDelayMs(settings, 2)).toBe(20_000);
    expect(computeDelayMs(settings, 3)).toBe(30_000);
  });

  it("repeats the base when fixed", () => {
    const settings = {
      strategy: "fixed" as const,
      baseDelayMs: 10_000,
      growth: 4,
      maxDelayMs: 900_000,
      jitterPct: 0,
    };
    expect(computeDelayMs(settings, 1)).toBe(10_000);
    expect(computeDelayMs(settings, 9)).toBe(10_000);
  });

  it("jitters symmetrically around the computed delay", () => {
    expect(applyJitter(60_000, 25, 0.5)).toBe(60_000);
    expect(applyJitter(60_000, 25, 0)).toBe(45_000);
    expect(applyJitter(60_000, 25, 1)).toBe(75_000);
    expect(applyJitter(60_000, 0, 0)).toBe(60_000);
  });

  it("previews the waits a policy would use", () => {
    const schedule = previewSchedule(defaultPolicy(), 3);
    expect(schedule).toEqual([
      { attempt: 2, delayMs: 30_000 },
      { attempt: 3, delayMs: 48_000 },
    ]);
  });
});

describe("decideRetry", () => {
  it("retries the unclassified gateway failure that started this plugin", () => {
    // The exact shape of thr_vw76j3963s: an error with no errorInfo at all.
    const decision = decideRetry(
      input({
        errorText: "Provider error — The service is temporarily unavailable. Please retry later.",
      }),
      defaultPolicy(),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.rule).toBe("defaults");
    expect(decision.delayMs).toBe(30_000);
    expect(decision.sendAt).toBe(1_800_000_000_000 + 30_000);
    expect(decision.reason).toBe("Agent retry 2/50 — unclassified failure");
    expect(decision.maxAttempts).toBe(50);
  });

  it("retries a structured transient category", () => {
    const decision = decideRetry(
      input({ errorInfo: { category: "stream-disconnected" } }),
      defaultPolicy(),
    );
    expect(decision.action).toBe("retry");
  });

  it("declines categories that fail the same way every time", () => {
    for (const category of ["billing", "unauthorized", "context-window-exceeded"]) {
      const decision = decideRetry(
        input({ errorInfo: { category } }),
        defaultPolicy(),
      );
      expect(decision.action).toBe("skip");
      if (decision.action !== "skip") continue;
      expect(decision.reason).toContain(category);
    }
  });

  it("declines an unclassified failure when asked to", () => {
    const decision = decideRetry(
      input(),
      defaultPolicy({ retryWhenUnknown: false }),
    );
    expect(decision.action).toBe("skip");
  });

  it("stops at maxAttempts, counting the original dispatch as 1", () => {
    const policy = defaultPolicy({
      defaults: { ...defaultPolicy().defaults, maxAttempts: 3 },
    });
    expect(decideRetry(input({ attemptNumber: 2 }), policy).action).toBe("retry");
    const exhausted = decideRetry(input({ attemptNumber: 3 }), policy);
    expect(exhausted.action).toBe("skip");
    if (exhausted.action !== "skip") return;
    expect(exhausted.reason).toContain("attempts exhausted (3/3)");
  });

  it("lets a message rule force a retry past the skip list", () => {
    const policy = defaultPolicy({
      messageRules: [
        {
          source: "please retry",
          pattern: /please retry/iu,
          action: "retry",
          maxAttempts: 20,
          baseDelayMs: 5_000,
        },
      ],
    });
    const decision = decideRetry(
      input({
        errorInfo: { category: "bad-request" },
        errorText: "bad request — please retry with a smaller payload",
      }),
      policy,
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.rule).toBe("message:please retry");
    expect(decision.delayMs).toBe(5_000);
    expect(decision.maxAttempts).toBe(20);
  });

  it("lets a message rule decline something the defaults would retry", () => {
    const policy = defaultPolicy({
      messageRules: [
        {
          source: "invalid api key",
          pattern: /invalid api key/iu,
          action: "skip",
          reason: "the provider key is wrong",
        },
      ],
    });
    const decision = decideRetry(
      input({ errorText: "Invalid API key supplied" }),
      policy,
    );
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") return;
    expect(decision.reason).toBe("the provider key is wrong");
    expect(decision.rule).toBe("message:invalid api key");
  });

  it("prefers a category rule over the default skip list", () => {
    const policy = defaultPolicy({
      categoryRules: {
        billing: { action: "retry", maxAttempts: 4, baseDelayMs: 60_000 },
      },
    });
    const decision = decideRetry(
      input({ errorInfo: { category: "billing" } }),
      policy,
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.maxAttempts).toBe(4);
    expect(decision.delayMs).toBe(60_000);
  });

  it("falls back to the * catch-all category rule", () => {
    const policy = defaultPolicy({
      categoryRules: { "*": { maxAttempts: 7, strategy: "fixed", baseDelayMs: 1_000 } },
    });
    const decision = decideRetry(
      input({ errorInfo: { category: "internal" }, attemptNumber: 4 }),
      policy,
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.rule).toBe("category:*");
    expect(decision.maxAttempts).toBe(7);
    expect(decision.delayMs).toBe(1_000);
  });

  it("waits for a rate-limit reset instead of the backoff", () => {
    const resetAt = 1_800_000_000_000 + 10 * 60_000;
    const decision = decideRetry(
      input({
        errorInfo: { category: "rate-limit" },
        rateLimits: {
          status: "blocked",
          kind: "subscription-window",
          windows: [{ status: "blocked", resetsAtMs: resetAt }],
        },
      }),
      defaultPolicy(),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.sendAt).toBe(resetAt + 15_000);
    expect(decision.rule).toContain("rate-limit-reset");
  });

  it("keeps the backoff when it is already past the reset", () => {
    const resetAt = 1_800_000_000_000 + 1_000;
    const decision = decideRetry(
      input({
        errorInfo: { category: "rate-limit" },
        rateLimits: {
          status: "blocked",
          windows: [{ status: "blocked", resetsAtMs: resetAt }],
        },
      }),
      defaultPolicy(),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.sendAt).toBe(1_800_000_000_000 + 30_000);
  });

  it("declines when the next attempt is beyond maxWaitMs", () => {
    const decision = decideRetry(
      input({ attemptNumber: 10 }),
      defaultPolicy({ maxWaitMs: 60_000 }),
    );
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") return;
    expect(decision.reason).toContain("maxWaitMs");
  });

  it("declines once a chain is older than maxTotalSpanMs", () => {
    const decision = decideRetry(
      input({ chainStartedAt: 1_800_000_000_000 - 3_600_000 }),
      defaultPolicy({ maxTotalSpanMs: 60_000 }),
    );
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") return;
    expect(decision.reason).toContain("maxTotalSpanMs");
  });

  it("applies jitter", () => {
    const decision = decideRetry(input({ random: 1 }), defaultPolicy({
      defaults: { ...defaultPolicy().defaults, jitterPct: 20 },
    }));
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.delayMs).toBe(36_000);
  });
});

describe("scope", () => {
  const policy = defaultPolicy({
    scope: {
      projects: ["proj_keep"],
      excludeProjects: [],
      providers: [],
      excludeProviders: ["codex"],
      excludeThreads: ["thr_skip"],
      threadPatterns: [/^thr_keep/u],
      retryHidden: false,
      retryChild: false,
      inputAccepted: "either",
    },
  });

  it("retries an in-scope thread", () => {
    expect(
      decideRetry(
        input({ projectId: "proj_keep", threadId: "thr_keep_1" }),
        policy,
      ).action,
    ).toBe("retry");
  });

  it("declines a project outside the allowlist", () => {
    const decision = decideRetry(
      input({ projectId: "proj_other", threadId: "thr_keep_1" }),
      policy,
    );
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") return;
    expect(decision.rule).toBe("scope");
    expect(decision.reason).toContain("scopeProjects");
  });

  it("declines an excluded provider", () => {
    const decision = decideRetry(
      input({ providerId: "codex", threadId: "thr_keep_1" }),
      policy,
    );
    expect(decision.action).toBe("skip");
  });

  it("declines an excluded thread id", () => {
    expect(decideRetry(input({ threadId: "thr_skip" }), policy).action).toBe("skip");
  });

  it("declines a thread id that matches no pattern", () => {
    expect(decideRetry(input({ threadId: "thr_other" }), policy).action).toBe("skip");
  });

  it("declines hidden and child threads when told to", () => {
    expect(
      decideRetry(
        input({ threadId: "thr_keep_1", visibility: "hidden" }),
        policy,
      ).action,
    ).toBe("skip");
    expect(
      decideRetry(
        input({ threadId: "thr_keep_1", parentThreadId: "thr_parent" }),
        policy,
      ).action,
    ).toBe("skip");
  });
});

describe("reason text", () => {
  it("collapses whitespace and clips to the queue's limit", () => {
    expect(clampReason("  a\n b  ")).toBe("a b");
    const long = clampReason("x".repeat(500));
    expect(long.length).toBe(REASON_MAX_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });

  it("leaves a reason exactly at the limit alone", () => {
    const exact = "y".repeat(REASON_MAX_LENGTH);
    expect(clampReason(exact)).toBe(exact);
    expect(clampReason("z".repeat(REASON_MAX_LENGTH + 1)).length).toBe(
      REASON_MAX_LENGTH,
    );
  });

  it("names the category in the default reason when there is one", () => {
    const decision = decideRetry(
      input({ errorInfo: { category: "overloaded" } }),
      defaultPolicy(),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.reason).toBe("Agent retry 2/50 — overloaded");
  });

  it("lets a rule's own reason and label win", () => {
    const policy = defaultPolicy({
      categoryRules: {
        overloaded: { reason: "provider is busy", label: "busy" },
      },
    });
    const decision = decideRetry(
      input({ errorInfo: { category: "overloaded" } }),
      policy,
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.reason).toBe("provider is busy");
    expect(decision.rule).toBe("busy");
  });
});

describe("attempt counter edges", () => {
  it("treats a zero, negative, or fractional attempt as the first", () => {
    for (const attemptNumber of [0, -5, 0.4]) {
      const decision = decideRetry(
        input({ attemptNumber }),
        defaultPolicy(),
      );
      expect(decision.action).toBe("retry");
      if (decision.action !== "retry") continue;
      // The first backoff step, not the zeroth or the negative one.
      expect(decision.delayMs).toBe(30_000);
    }
  });

  it("treats a fractional attempt as its floor", () => {
    const decision = decideRetry(
      input({ attemptNumber: 2.9 }),
      defaultPolicy(),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.delayMs).toBe(48_000);
  });

  it("does not let NaN become an infinite wait", () => {
    const decision = decideRetry(
      input({ attemptNumber: Number.NaN }),
      defaultPolicy(),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(Number.isFinite(decision.delayMs)).toBe(true);
    expect(decision.delayMs).toBe(30_000);
  });

  it("stops one attempt short of the cap when maxAttempts is 1", () => {
    const policy = defaultPolicy({
      defaults: { ...defaultPolicy().defaults, maxAttempts: 1 },
    });
    const decision = decideRetry(input({ attemptNumber: 1 }), policy);
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") return;
    expect(decision.reason).toContain("attempts exhausted (1/1)");
  });

  it("decides identically twice, so nothing is hiding in the engine", () => {
    const policy = defaultPolicy({
      messageRules: [{ source: "boom", pattern: /boom/u, action: "retry" }],
    });
    const one = decideRetry(input({ errorText: "boom" }), policy);
    const two = decideRetry(input({ errorText: "boom" }), policy);
    expect(two).toEqual(one);
  });
});

describe("delay boundaries", () => {
  it("retries immediately when the base and cap are both zero", () => {
    const policy = defaultPolicy({
      defaults: {
        ...defaultPolicy().defaults,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterPct: 50,
      },
    });
    const decision = decideRetry(input({ random: 1 }), policy);
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.delayMs).toBe(0);
    expect(decision.sendAt).toBe(input().now);
  });

  it("holds a flat wait when growth is 1", () => {
    const policy = defaultPolicy({
      defaults: { ...defaultPolicy().defaults, growth: 1 },
    });
    for (const attemptNumber of [1, 2, 9]) {
      const decision = decideRetry(input({ attemptNumber }), policy);
      if (decision.action !== "retry") throw new Error("expected a retry");
      expect(decision.delayMs).toBe(30_000);
    }
  });

  it("clamps a jitter sample outside [0, 1]", () => {
    expect(applyJitter(1_000, 50, -3)).toBe(500);
    expect(applyJitter(1_000, 50, 4)).toBe(1_500);
  });

  it("never lets jitter push a wait below zero", () => {
    expect(applyJitter(1, 100, 0)).toBe(0);
  });
});

describe("wait and span caps, at their boundaries", () => {
  it("retries when the wait exactly equals maxWaitMs", () => {
    const decision = decideRetry(
      input(),
      defaultPolicy({ maxWaitMs: 30_000 }),
    );
    expect(decision.action).toBe("retry");
  });

  it("declines one millisecond past maxWaitMs", () => {
    const decision = decideRetry(
      input(),
      defaultPolicy({ maxWaitMs: 29_999 }),
    );
    expect(decision.action).toBe("skip");
  });

  it("declines when the chain is exactly at maxTotalSpanMs", () => {
    const decision = decideRetry(
      input({ chainStartedAt: input().now - 60_000 }),
      defaultPolicy({ maxTotalSpanMs: 60_000 }),
    );
    expect(decision.action).toBe("skip");
  });

  it("retries when the chain is one millisecond short of it", () => {
    const decision = decideRetry(
      input({ chainStartedAt: input().now - 59_999 }),
      defaultPolicy({ maxTotalSpanMs: 60_000 }),
    );
    expect(decision.action).toBe("retry");
  });

  it("cannot enforce a span it never learned", () => {
    const decision = decideRetry(
      input({ chainStartedAt: null, attemptNumber: 4 }),
      defaultPolicy({ maxTotalSpanMs: 1 }),
    );
    expect(decision.action).toBe("retry");
  });
});

describe("rate-limit windows", () => {
  const blocked = (windows: { status: string; resetsAtMs: number | null }[]) => ({
    status: "blocked",
    kind: "subscription-window",
    windows,
  });

  it("ignores a blocked state with no reset time", () => {
    const decision = decideRetry(
      input({
        errorInfo: { category: "rate-limit" },
        rateLimits: blocked([{ status: "blocked", resetsAtMs: null }]),
      }),
      defaultPolicy(),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.delayMs).toBe(30_000);
    expect(decision.rule).toBe("defaults");
  });

  it("ignores a blocked state with no windows at all", () => {
    const decision = decideRetry(
      input({
        errorInfo: { category: "rate-limit" },
        rateLimits: { status: "blocked", windows: [] },
      }),
      defaultPolicy(),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.delayMs).toBe(30_000);
  });

  it("waits for the furthest reset when several are blocked", () => {
    const far = input().now + 20 * 60_000;
    const decision = decideRetry(
      input({
        errorInfo: { category: "rate-limit" },
        rateLimits: blocked([
          { status: "blocked", resetsAtMs: input().now + 60_000 },
          { status: "blocked", resetsAtMs: far },
        ]),
      }),
      defaultPolicy(),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.sendAt).toBe(far + 15_000);
  });

  it("does not wait when the window is not blocked", () => {
    for (const status of ["allowed", "warning", "unknown"]) {
      const decision = decideRetry(
        input({
          errorInfo: { category: "rate-limit" },
          rateLimits: {
            status,
            windows: [{ status, resetsAtMs: input().now + 60 * 60_000 }],
          },
        }),
        defaultPolicy(),
      );
      expect(decision.action).toBe("retry");
      if (decision.action !== "retry") continue;
      expect(decision.delayMs).toBe(30_000);
    }
  });

  it("ignores the reset entirely when asked to", () => {
    const decision = decideRetry(
      input({
        errorInfo: { category: "rate-limit" },
        rateLimits: blocked([{ status: "blocked", resetsAtMs: input().now + 60_000 }]),
      }),
      defaultPolicy({ honorRateLimitReset: false }),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.delayMs).toBe(30_000);
  });

  it("adds no padding when resetPadMs is zero", () => {
    const resetAt = input().now + 60_000;
    const decision = decideRetry(
      input({
        errorInfo: { category: "rate-limit" },
        rateLimits: blocked([{ status: "blocked", resetsAtMs: resetAt }]),
      }),
      defaultPolicy({ resetPadMs: 0 }),
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.sendAt).toBe(resetAt);
  });

  it("declines when the reset itself is past maxWaitMs", () => {
    const decision = decideRetry(
      input({
        errorInfo: { category: "rate-limit" },
        rateLimits: blocked([{ status: "blocked", resetsAtMs: input().now + 60 * 60_000 }]),
      }),
      defaultPolicy({ maxWaitMs: 60 * 60_000 }),
    );
    expect(decision.action).toBe("skip");
  });
});

describe("rule precedence", () => {
  const policy = defaultPolicy({
    categoryRules: {
      "*": { action: "retry", maxAttempts: 5, baseDelayMs: 1_000 },
      billing: { action: "skip", reason: "billing is terminal" },
      overloaded: { baseDelayMs: 2_000 },
    },
    messageRules: [
      { source: "first", pattern: /first/u, action: "retry", baseDelayMs: 3_000 },
      { source: "second", pattern: /second/u, action: "retry", baseDelayMs: 4_000 },
    ],
  });

  it("takes the first matching message rule, not the best one", () => {
    const decision = decideRetry(input({ errorText: "first and second" }), policy);
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.rule).toBe("message:first");
    expect(decision.delayMs).toBe(3_000);
  });

  it("lets a message rule beat a category rule", () => {
    const decision = decideRetry(
      input({ errorInfo: { category: "billing" }, errorText: "first" }),
      policy,
    );
    expect(decision.action).toBe("retry");
  });

  it("treats the catch-all as a selector, not as a baseline", () => {
    // Documented semantics: `*` answers only for a category with no rule of
    // its own. A specific rule does NOT inherit from it, because the two
    // layers that already apply to everything are the flat settings and
    // `advancedJson.defaults`.
    const decision = decideRetry(
      input({ errorInfo: { category: "overloaded" } }),
      policy,
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.rule).toBe("category:overloaded");
    expect(decision.delayMs).toBe(2_000);
    expect(decision.maxAttempts).toBe(50);
  });

  it("applies the catch-all only when no category rule exists", () => {
    const decision = decideRetry(
      input({ errorInfo: { category: "internal" } }),
      policy,
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.rule).toBe("category:*");
    expect(decision.maxAttempts).toBe(5);
  });

  it("skips a category rule's skip even though the catch-all would retry", () => {
    const decision = decideRetry(
      input({ errorInfo: { category: "billing" } }),
      policy,
    );
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") return;
    expect(decision.reason).toBe("billing is terminal");
  });

  it("uses the catch-all when the category is one the defaults would skip", () => {
    const decision = decideRetry(
      input({ errorInfo: { category: "unauthorized" } }),
      policy,
    );
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.rule).toBe("category:*");
  });

  it("ignores message rules when there is no error text to match", () => {
    const decision = decideRetry(input({ errorText: null }), policy);
    expect(decision.action).toBe("retry");
    if (decision.action !== "retry") return;
    expect(decision.rule).toBe("category:*");
  });

  it("lets a catch-all skip everything it does not name", () => {
    const skipping = defaultPolicy({
      categoryRules: { "*": { action: "skip", reason: "nothing retries" } },
    });
    const decision = decideRetry(input({ errorInfo: { category: "internal" } }), skipping);
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") return;
    expect(decision.reason).toBe("nothing retries");
  });
});

describe("scope, at the edges", () => {
  it("declines a failure whose project could not be read when a project list is set", () => {
    const policy = defaultPolicy({
      scope: { ...defaultPolicy().scope, projects: ["proj_keep"] },
    });
    expect(decideRetry(input({ projectId: null }), policy).action).toBe("skip");
  });

  it("declines a failure whose provider could not be read when a provider list is set", () => {
    const policy = defaultPolicy({
      scope: { ...defaultPolicy().scope, providers: ["pi"] },
    });
    expect(decideRetry(input({ providerId: null }), policy).action).toBe("skip");
  });

  it("does not decline an unread project against a denylist", () => {
    const policy = defaultPolicy({
      scope: { ...defaultPolicy().scope, excludeProjects: ["proj_noisy"] },
    });
    expect(decideRetry(input({ projectId: null }), policy).action).toBe("retry");
  });

  it("applies an allowlist and a denylist together", () => {
    const policy = defaultPolicy({
      scope: {
        ...defaultPolicy().scope,
        providers: ["pi", "codex"],
        excludeProviders: ["codex"],
      },
    });
    expect(decideRetry(input({ providerId: "pi" }), policy).action).toBe("retry");
    expect(decideRetry(input({ providerId: "codex" }), policy).action).toBe("skip");
    expect(decideRetry(input({ providerId: "claude-code" }), policy).action).toBe("skip");
  });

  it("retries a child thread by default", () => {
    expect(
      decideRetry(input({ parentThreadId: "thr_parent" }), defaultPolicy()).action,
    ).toBe("retry");
  });

  it("retries a hidden thread by default", () => {
    expect(
      decideRetry(input({ visibility: "hidden" }), defaultPolicy()).action,
    ).toBe("retry");
  });

  it("can retry only requests the provider took", () => {
    const policy = defaultPolicy({
      scope: { ...defaultPolicy().scope, inputAccepted: "accepted" },
    });
    expect(decideRetry(input({ inputAccepted: true }), policy).action).toBe("retry");
    const declined = decideRetry(input({ inputAccepted: false }), policy);
    expect(declined.action).toBe("skip");
    if (declined.action !== "skip") return;
    expect(declined.reason).toContain("never took the input");
  });

  it("can retry only requests the provider refused at the door", () => {
    const policy = defaultPolicy({
      scope: { ...defaultPolicy().scope, inputAccepted: "rejected" },
    });
    expect(decideRetry(input({ inputAccepted: false }), policy).action).toBe("retry");
    expect(decideRetry(input({ inputAccepted: true }), policy).action).toBe("skip");
  });
});

describe("previewSchedule", () => {
  it("returns nothing for a zero or one count", () => {
    expect(previewSchedule(defaultPolicy(), 0)).toEqual([]);
    expect(previewSchedule(defaultPolicy(), 1)).toEqual([]);
  });

  it("never previews past the attempt cap", () => {
    const policy = defaultPolicy({
      defaults: { ...defaultPolicy().defaults, maxAttempts: 3 },
    });
    expect(previewSchedule(policy, 99)).toEqual([
      { attempt: 2, delayMs: 30_000 },
      { attempt: 3, delayMs: 48_000 },
    ]);
  });

  it("is finite even when growth is large", () => {
    const policy = defaultPolicy({
      defaults: { ...defaultPolicy().defaults, growth: 10, maxDelayMs: 900_000 },
    });
    for (const row of previewSchedule(policy, 50)) {
      expect(Number.isFinite(row.delayMs)).toBe(true);
      expect(row.delayMs).toBeLessThanOrEqual(900_000);
    }
  });
});
