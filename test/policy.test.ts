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
});
