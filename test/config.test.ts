// Configuration-layer scenarios: both layers parse, validate, merge, and
// reject what they must. These run through the real settings descriptors and
// the real fake-host settings save, so a schema that stops rejecting bad input
// fails here rather than in the field.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  DEFAULT_SKIP_CATEGORIES,
  compilePattern,
  defineSettings,
  parseAdvancedJson,
  parseList,
  parsePatternLines,
  resolvePolicy,
} from "../config.js";
import { decideRetry, type DecisionInput } from "../policy.js";

async function resolve(settings: Record<string, string | number | boolean> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "agent-retry", settings });
  const handle = defineSettings(bb);
  const resolved = await resolvePolicy(handle);
  return { resolved, handle, harness, bb };
}

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    threadId: "thr_1",
    projectId: "proj_1",
    providerId: "pi",
    requestId: "req_1",
    turnId: null,
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

describe("resolved defaults", () => {
  it("matches the documented policy out of the box", async () => {
    const { resolved } = await resolve();
    expect(resolved.policy.defaults).toEqual({
      strategy: "exponential",
      baseDelayMs: 30_000,
      growth: 1.6,
      maxDelayMs: 900_000,
      jitterPct: 15,
      maxAttempts: 50,
    });
    expect(resolved.policy.skipCategories).toEqual(
      DEFAULT_SKIP_CATEGORIES.split(","),
    );
    expect(resolved.policy.retryWhenUnknown).toBe(true);
    expect(resolved.policy.honorRateLimitReset).toBe(true);
    expect(resolved.policy.resetPadMs).toBe(15_000);
    expect(resolved.policy.maxTotalSpanMs).toBe(0);
    expect(resolved.policy.maxWaitMs).toBe(0);
    expect(resolved.policy.categoryRules).toEqual({});
    expect(resolved.policy.messageRules).toEqual([]);
    expect(resolved.dryRun).toBe(false);
    expect(resolved.logDecisions).toBe(true);
    expect(resolved.policy.scope).toEqual({
      projects: [],
      excludeProjects: [],
      providers: [],
      excludeProviders: [],
      excludeThreads: [],
      threadPatterns: [],
      retryHidden: true,
      retryChild: true,
      inputAccepted: "either",
    });
    expect(resolved.enabled).toBe(true);
  });

  it("treats an empty or whitespace advancedJson as no override", async () => {
    for (const value of ["", "   ", "\n", "{}"]) {
      const { resolved } = await resolve({ advancedJson: value });
      expect(resolved.policy.categoryRules).toEqual({});
      expect(resolved.policy.messageRules).toEqual([]);
    }
  });
});

describe("advancedJson", () => {
  it("overrides the flat numbers it names and leaves the rest alone", async () => {
    const { resolved } = await resolve({
      maxAttempts: 10,
      jitterPct: 5,
      advancedJson: JSON.stringify({ defaults: { maxAttempts: 77, baseDelayMs: 1_000 } }),
    });
    expect(resolved.policy.defaults.maxAttempts).toBe(77);
    expect(resolved.policy.defaults.baseDelayMs).toBe(1_000);
    // Untouched by the advanced layer, so the flat value stands.
    expect(resolved.policy.defaults.jitterPct).toBe(5);
    expect(resolved.policy.defaults.growth).toBe(1.6);
  });

  it("lowercases category rule keys and keeps the catch-all", async () => {
    const { resolved } = await resolve({
      advancedJson: JSON.stringify({
        categoryRules: { Overloaded: { action: "retry" }, "*": { action: "retry" } },
      }),
    });
    expect(Object.keys(resolved.policy.categoryRules).sort()).toEqual(["*", "overloaded"]);
  });

  it("compiles message rules and records their flags in the source label", async () => {
    const { resolved } = await resolve({
      advancedJson: JSON.stringify({
        messageRules: [
          { pattern: "Please Retry", flags: "i" },
          { pattern: "plain" },
        ],
      }),
    });
    expect(resolved.policy.messageRules.map((rule) => rule.source)).toEqual([
      "Please Retry/i",
      "plain",
    ]);
    expect(resolved.policy.messageRules[0]?.pattern.test("PLEASE RETRY")).toBe(true);
  });

  it("strips stateful flags so a rule matches every time, not every other time", async () => {
    const { resolved } = await resolve({
      advancedJson: JSON.stringify({
        scope: { threadPatterns: ["^thr_1$"] },
        messageRules: [{ pattern: "boom", flags: "gi" }],
      }),
    });
    const rule = resolved.policy.messageRules[0];
    expect(rule?.pattern.test("boom")).toBe(true);
    expect(rule?.pattern.test("boom")).toBe(true);
    // The same hazard in the scope layer: `g` would make the second call fail.
    expect(decideRetry(input(), resolved.policy).action).toBe("retry");
    expect(decideRetry(input(), resolved.policy).action).toBe("retry");
  });

  it("rejects an unknown top-level key", async () => {
    const { harness, handle } = await resolve();
    await expect(
      harness.behavior.setSettings({
        advancedJson: JSON.stringify({ defaultz: {} }),
      }),
    ).rejects.toThrow(/defaultz|Unrecognized/u);
    expect((await handle.get()).advancedJson).toBe("{}");
  });

  it("rejects an unknown field inside a rule, so a typo cannot be silently ignored", async () => {
    const { harness } = await resolve();
    await expect(
      harness.behavior.setSettings({
        advancedJson: JSON.stringify({ categoryRules: { billing: { maxAttemps: 3 } } }),
      }),
    ).rejects.toThrow(/maxAttemps|Unrecognized/u);
    await expect(
      harness.behavior.setSettings({
        advancedJson: JSON.stringify({ messageRules: [{ pattern: "x", flag: "i" }] }),
      }),
    ).rejects.toThrow(/flag|Unrecognized/u);
  });

  it("rejects a wrong type", async () => {
    const { harness } = await resolve();
    await expect(
      harness.behavior.setSettings({
        advancedJson: JSON.stringify({ defaults: { maxAttempts: "50" } }),
      }),
    ).rejects.toThrow();
    await expect(
      harness.behavior.setSettings({
        advancedJson: JSON.stringify({ messageRules: "nope" }),
      }),
    ).rejects.toThrow();
  });

  it("rejects malformed JSON with a message naming the problem", async () => {
    const { harness } = await resolve();
    await expect(
      harness.behavior.setSettings({ advancedJson: "{ oops" }),
    ).rejects.toThrow(/Invalid JSON/u);
  });

  it("rejects a message rule whose pattern is not a valid regular expression", async () => {
    const { harness } = await resolve();
    await expect(
      harness.behavior.setSettings({
        advancedJson: JSON.stringify({ messageRules: [{ pattern: "a(", flags: "i" }] }),
      }),
    ).rejects.toThrow(/regular expression/u);
  });

  it("rejects a bad flag as well as a bad pattern", async () => {
    const { harness } = await resolve();
    await expect(
      harness.behavior.setSettings({
        advancedJson: JSON.stringify({ messageRules: [{ pattern: "a", flags: "zz" }] }),
      }),
    ).rejects.toThrow(/regular expression/u);
  });

  it("rejects an out-of-range number in a rule", async () => {
    const { harness } = await resolve();
    for (const bad of [
      { maxAttempts: 0 },
      { maxAttempts: 1001 },
      { growth: 0.5 },
      { growth: 11 },
      { jitterPct: 101 },
      { baseDelayMs: -1 },
    ]) {
      await expect(
        harness.behavior.setSettings({
          advancedJson: JSON.stringify({ categoryRules: { overloaded: bad } }),
        }),
      ).rejects.toThrow();
    }
  });

  it("falls back to the flat layer when a stored value predates the schema", async () => {
    // Seeded straight into storage, the way an old value survives a schema change.
    const { resolved } = await resolve({ advancedJson: "{ legacy", maxAttempts: 7 });
    expect(resolved.policy.defaults.maxAttempts).toBe(7);
    expect(resolved.policy.messageRules).toEqual([]);
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]).toMatch(/advancedJson/u);
  });
});

describe("scope merging", () => {
  it("uses the flat lists when the advanced layer is silent", async () => {
    const { resolved } = await resolve({
      scopeProjects: "proj_a, proj_b",
      excludeProviders: "codex",
      retryHidden: false,
    });
    expect(resolved.policy.scope.projects).toEqual(["proj_a", "proj_b"]);
    expect(resolved.policy.scope.excludeProviders).toEqual(["codex"]);
    expect(resolved.policy.scope.retryHidden).toBe(false);
  });

  it("lets a non-empty advanced list replace the flat one, field by field", async () => {
    const { resolved } = await resolve({
      scopeProjects: "proj_flat",
      excludeProviders: "codex",
      advancedJson: JSON.stringify({
        scope: { projects: ["proj_advanced"], retryChild: false },
      }),
    });
    expect(resolved.policy.scope.projects).toEqual(["proj_advanced"]);
    // Not named by the advanced layer, so the flat value survives.
    expect(resolved.policy.scope.excludeProviders).toEqual(["codex"]);
    expect(resolved.policy.scope.retryChild).toBe(false);
  });

  it("treats an empty advanced list as silent rather than as a wipe", async () => {
    const { resolved } = await resolve({
      scopeProjects: "proj_flat",
      advancedJson: JSON.stringify({ scope: { projects: [] } }),
    });
    expect(resolved.policy.scope.projects).toEqual(["proj_flat"]);
  });

  it("compiles thread patterns from lines, skipping comments and blanks", async () => {
    const { resolved } = await resolve({
      threadPatterns: "# keep these\n^thr_keep\n\n  ^thr_also  \n",
    });
    expect(resolved.policy.scope.threadPatterns.map((p) => p.source)).toEqual([
      "^thr_keep",
      "^thr_also",
    ]);
  });

  it("rejects an invalid thread pattern at save time", async () => {
    const { harness } = await resolve();
    await expect(
      harness.behavior.setSettings({ threadPatterns: "^thr_ok\n([unclosed\n" }),
    ).rejects.toThrow(/regular expression/u);
  });
});

describe("flat field parsing", () => {
  it("parses comma lists, trimming and dropping empties", () => {
    expect(parseList(" a , b ,, c ")).toEqual(["a", "b", "c"]);
    expect(parseList("")).toEqual([]);
    expect(parseList("   ")).toEqual([]);
    expect(parseList(",,")).toEqual([]);
  });

  it("parses pattern lines, skipping comments and blanks", () => {
    expect(parsePatternLines("a\n# b\n\n  c  ")).toEqual(["a", "c"]);
    expect(parsePatternLines("")).toEqual([]);
  });

  it("an empty skip list means nothing is skipped by category", async () => {
    const { resolved } = await resolve({ skipCategories: "" });
    expect(resolved.policy.skipCategories).toEqual([]);
    // billing is normally declined; with an empty list it is retried.
    const decision = decideRetry(
      input({ errorInfo: { category: "billing" } }),
      resolved.policy,
    );
    expect(decision.action).toBe("retry");
  });

  it("matches a skip category regardless of case on either side", async () => {
    const { resolved } = await resolve({ skipCategories: "Billing, UNAUTHORIZED" });
    expect(decideRetry(input({ errorInfo: { category: "billing" } }), resolved.policy).action).toBe("skip");
    expect(decideRetry(input({ errorInfo: { category: "Unauthorized" } }), resolved.policy).action).toBe("skip");
  });

  it("rejects an out-of-range flat number", async () => {
    const { harness } = await resolve();
    await expect(harness.behavior.setSettings({ maxAttempts: 0 })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ maxAttempts: 1001 })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ jitterPct: 101 })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ growth: 0.5 })).rejects.toThrow();
    await expect(harness.behavior.setSettings({ baseDelayMs: -1 })).rejects.toThrow();
  });

  it("accepts the boundaries of every numeric range", async () => {
    const { harness, handle } = await resolve();
    await harness.behavior.setSettings({
      maxAttempts: 1000,
      growth: 10,
      jitterPct: 100,
      baseDelayMs: 3_600_000,
      maxDelayMs: 86_400_000,
      resetPadMs: 0,
      maxTotalSpanMs: 0,
      maxWaitMs: 0,
    });
    const values = await handle.get();
    expect(values.maxAttempts).toBe(1000);
    expect(values.jitterPct).toBe(100);
  });

  it("rejects a non-integer maxAttempts", async () => {
    const { harness } = await resolve();
    await expect(harness.behavior.setSettings({ maxAttempts: 2.5 })).rejects.toThrow();
  });

  it("rejects an unknown setting key", async () => {
    const { harness } = await resolve();
    await expect(harness.behavior.setSettings({ nope: 1 })).rejects.toThrow();
  });
});

describe("compilePattern", () => {
  it("keeps the flags it can and drops the stateful ones", () => {
    expect(compilePattern("a", "gi").flags).toBe("i");
    expect(compilePattern("a", "y").flags).toBe("");
    expect(compilePattern("a", "m").flags).toBe("m");
  });

  it("reports the offending pattern", () => {
    expect(() => compilePattern("a(", "i")).toThrow(/invalid regular expression \/a\(\/i/u);
  });
});

describe("parseAdvancedJson", () => {
  it("returns an empty policy for empty input", () => {
    expect(parseAdvancedJson("  ")).toEqual({});
  });

  it("throws on malformed JSON and on a schema violation", () => {
    expect(() => parseAdvancedJson("{")).toThrow();
    expect(() => parseAdvancedJson(JSON.stringify({ nope: 1 }))).toThrow();
  });

  it("accepts a rule that only names an action", () => {
    const parsed = parseAdvancedJson(
      JSON.stringify({ categoryRules: { sandbox: { action: "skip" } } }),
    );
    expect(parsed.categoryRules?.sandbox).toEqual({ action: "skip" });
  });
});
