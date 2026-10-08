// CLI surface scenarios: every command answers, filters, and fails the way an
// operator or an agent needs. The parser is the SDK's, so these mostly pin the
// declarations and the formatting around them.
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

interface QueuedRow {
  id: string;
  payload: { kind: string; reason?: string };
  sendAt?: number | null;
}

function makeHost(options: {
  settings?: Record<string, string | number | boolean>;
  queued?: QueuedRow[];
} = {}) {
  const queued = options.queued ?? [];
  return createFakePluginHost({
    pluginId: "agent-retry",
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "thr_1", projectId: "proj_1", providerId: "pi", status: "error" }),
        events: { list: async () => [] },
        retry: async (args) => ({
          ok: true,
          delivery: "queued",
          turnRequestId: args.turnRequestId ?? "req_1",
          attempt: 2,
          queuedMessageId: "q_1",
          waitingOn: { kind: "thread-busy" },
          sendAt: args.sendAt ?? null,
        }),
        queuedMessages: {
          list: async () => queued,
          delete: async () => ({ ok: true }),
        },
      },
    },
  });
}

async function ready(options: Parameters<typeof makeHost>[0] = {}) {
  const host = makeHost(options);
  await plugin(host.bb);
  return host;
}

function parse<T>(result: { stdout?: string }): T {
  return JSON.parse(result.stdout ?? "null") as T;
}

describe("registration", () => {
  it("registers one command named agent-retry with every subcommand documented", async () => {
    const { harness } = await ready();
    const cli = harness.registrations.cli;
    expect(cli).not.toBeNull();
    expect(cli?.name).toBe("agent-retry");
    expect(cli?.summary).toMatch(/retr/iu);
    const names = (cli?.commands ?? []).map((command) => command.name);
    for (const expected of ["status", "log", "explain", "simulate", "cancel", "retry"]) {
      expect(names).toContain(expected);
    }
    // Every command carries a usage line, which is what the generated
    // `plugin-commands` skill shows an agent.
    for (const command of cli?.commands ?? []) {
      expect(command.usage).toMatch(/^bb agent-retry /u);
    }
    await harness.lifecycle.dispose();
  });
});

describe("help and parser errors", () => {
  it("answers --help at the top level and per command with exit 0", async () => {
    const { harness } = await ready();
    for (const argv of [["--help"], ["help"], ["status", "--help"], ["simulate", "--help"]]) {
      const result = await harness.behavior.runCli(argv);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("bb agent-retry");
    }
    await harness.lifecycle.dispose();
  });

  it("rejects an unknown command and an unknown option with the usage exit code", async () => {
    const { harness } = await ready();
    const unknownCommand = await harness.behavior.runCli(["nope"]);
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stderr).toMatch(/nope/u);

    const unknownOption = await harness.behavior.runCli(["status", "--nope"]);
    expect(unknownOption.exitCode).toBe(2);
    await harness.lifecycle.dispose();
  });

  it("reports every missing required value in one error", async () => {
    const { harness } = await ready();
    const result = await harness.behavior.runCli(["cancel"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("thread-id");
    await harness.lifecycle.dispose();
  });

  it("rejects a value outside an enum and an integer outside its range", async () => {
    const { harness } = await ready();
    const badEnum = await harness.behavior.runCli(["simulate", "--category", "nope"]);
    expect(badEnum.exitCode).toBe(2);

    const badRange = await harness.behavior.runCli(["simulate", "--attempt", "0"]);
    expect(badRange.exitCode).toBe(2);

    const badJitter = await harness.behavior.runCli(["simulate", "--jitter-sample", "1001"]);
    expect(badJitter.exitCode).toBe(2);
    await harness.lifecycle.dispose();
  });

  it("emits the JSON error envelope when a command fails with --json", async () => {
    const { harness } = await ready();
    const result = await harness.behavior.runCli(["cancel", "thr_none", "--json"]);
    expect(result.exitCode).not.toBe(0);
    const envelope = parse<{ ok: boolean; error: { code: string; message: string } }>(result);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("no_queued_retry");
    await harness.lifecycle.dispose();
  });
});

describe("status", () => {
  it("summarises the policy, the recent counts, and nothing pending", async () => {
    const { harness } = await ready();
    const human = await harness.behavior.runCli(["status"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("attempts:        50");
    expect(human.stdout).toContain("pending retries: none");
    expect(human.stdout).toContain("next waits:");
    expect(human.stdout).not.toMatch(/undefined|NaN/u);

    const json = parse<{
      enabled: boolean;
      dryRun: boolean;
      counts: Record<string, number>;
      pending: unknown[];
      policy: { defaults: { maxAttempts: number } };
    }>(await harness.behavior.runCli(["status", "--json"]));
    expect(json.enabled).toBe(true);
    expect(json.policy.defaults.maxAttempts).toBe(50);
    expect(json.counts).toEqual({ retry: 0, skip: 0, "dry-run": 0, error: 0 });
    await harness.lifecycle.dispose();
  });

  it("lists a retry that is still queued, and drops it once the row is gone", async () => {
    const queued: QueuedRow[] = [{ id: "q_1", payload: { kind: "retry" }, sendAt: Date.now() + 60_000 }];
    const { harness } = await ready({ queued });
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );

    const pending = parse<{ pending: { threadId: string; attempt: number }[] }>(
      await harness.behavior.runCli(["status", "--json"]),
    );
    expect(pending.pending).toHaveLength(1);
    expect(pending.pending[0]?.threadId).toBe("thr_1");

    // The row dispatches: the plugin's log still names it, the thread's queue
    // does not, so it is no longer pending.
    queued.length = 0;
    const after = parse<{ pending: unknown[] }>(
      await harness.behavior.runCli(["status", "--json"]),
    );
    expect(after.pending).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("reports the master switch and the dry-run flag", async () => {
    const { harness } = await ready({ settings: { enabled: false, dryRun: true } });
    const json = parse<{ enabled: boolean; dryRun: boolean }>(
      await harness.behavior.runCli(["status", "--json"]),
    );
    expect(json.enabled).toBe(false);
    expect(json.dryRun).toBe(true);
    await harness.lifecycle.dispose();
  });
});

describe("log", () => {
  it("says so plainly when there is nothing recorded", async () => {
    const { harness } = await ready();
    const human = await harness.behavior.runCli(["log"]);
    expect(human.stdout).toContain("No decisions recorded");
    expect(parse<{ decisions: unknown[] }>(await harness.behavior.runCli(["log", "--json"])).decisions).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("filters by thread, by action, and by limit", async () => {
    const { harness } = await ready();
    for (const [threadId, attemptNumber] of [
      ["thr_a", 1],
      ["thr_b", 1],
      ["thr_a", 2],
    ] as const) {
      await harness.behavior.emitThreadEvent(
        "turn.failed",
        makeTurnFailedEvent({ threadId, attemptNumber }),
      );
    }
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_c", attemptNumber: 1, errorInfo: { category: "billing", providerCode: null, httpStatusCode: null } }),
    );

    const all = parse<{ decisions: unknown[] }>(
      await harness.behavior.runCli(["log", "--json"]),
    );
    expect(all.decisions).toHaveLength(4);

    const byThread = parse<{ decisions: { threadId: string }[] }>(
      await harness.behavior.runCli(["log", "--json", "--thread", "thr_a"]),
    );
    expect(byThread.decisions.map((row) => row.threadId)).toEqual(["thr_a", "thr_a"]);

    const byAction = parse<{ decisions: { action: string }[] }>(
      await harness.behavior.runCli(["log", "--json", "--action", "skip"]),
    );
    expect(byAction.decisions).toHaveLength(1);
    expect(byAction.decisions[0]?.action).toBe("skip");

    const limited = parse<{ decisions: unknown[] }>(
      await harness.behavior.runCli(["log", "--json", "--limit", "2"]),
    );
    expect(limited.decisions).toHaveLength(2);

    // `log` is newest first, so one row is the most recent decision: the
    // billing failure, which the default skip list declined.
    const human = await harness.behavior.runCli(["log", "--limit", "1"]);
    expect(human.stdout.trim().split("\n")).toHaveLength(1);
    expect(human.stdout).toMatch(/skip\s+#\s*1\s+thr_c/u);
    await harness.lifecycle.dispose();
  });

  it("renders the send time as a wait from the decision", async () => {
    const { harness } = await ready();
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );
    const human = await harness.behavior.runCli(["log"]);
    expect(human.stdout).toMatch(/→ in \d+s/u);
    await harness.lifecycle.dispose();
  });
});

describe("explain", () => {
  it("prints the resolved policy and the waits it would use", async () => {
    const { harness } = await ready({ settings: { maxAttempts: 4, strategy: "linear", growth: 2 } });
    const human = await harness.behavior.runCli(["explain"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("attempts:        4");
    expect(human.stdout).toContain("backoff:         linear");
    expect(human.stdout).toContain("attempt   2: +30s");
    expect(human.stdout).toContain("attempt   3: +1m");

    const json = parse<{ policy: { defaults: { strategy: string } }; enabled: boolean }>(
      await harness.behavior.runCli(["explain", "--json"]),
    );
    expect(json.policy.defaults.strategy).toBe("linear");
    await harness.lifecycle.dispose();
  });

  it("serialises regexes instead of failing on them", async () => {
    const { harness } = await ready({
      settings: {
        threadPatterns: "^thr_keep",
        advancedJson: JSON.stringify({ messageRules: [{ pattern: "boom", flags: "i" }] }),
      },
    });
    const json = parse<{
      policy: { scope: { threadPatterns: string[] }; messageRules: { pattern: string }[] };
    }>(await harness.behavior.runCli(["explain", "--json"]));
    expect(json.policy.scope.threadPatterns).toEqual(["^thr_keep"]);
    expect(json.policy.messageRules[0]?.pattern).toBe("boom/i");
    await harness.lifecycle.dispose();
  });

  it("surfaces a configuration problem it had to work around", async () => {
    const { harness } = await ready({ settings: { advancedJson: "{ legacy" } });
    const json = parse<{ problems: string[] }>(
      await harness.behavior.runCli(["explain", "--json"]),
    );
    expect(json.problems[0]).toMatch(/advancedJson was ignored/u);
    const human = await harness.behavior.runCli(["explain"]);
    expect(human.stdout).toContain("problem:         advancedJson was ignored");
    await harness.lifecycle.dispose();
  });
});

describe("simulate", () => {
  it("answers for an unclassified failure and for a skipped category", async () => {
    const { harness } = await ready();
    const retry = await harness.behavior.runCli(["simulate", "--category", "none"]);
    expect(retry.stdout).toContain("action:    retry");
    expect(retry.stdout).toContain("attempts:  2/50");

    const skip = await harness.behavior.runCli(["simulate", "--category", "billing"]);
    expect(skip.stdout).toContain("action:    skip");
    expect(skip.stdout).not.toContain("send at:");
    await harness.lifecycle.dispose();
  });

  it("takes a category from the provider's own vocabulary", async () => {
    const { harness } = await ready();
    for (const category of ["overloaded", "rate-limit", "stream-disconnected", "unknown"]) {
      const result = await harness.behavior.runCli(["simulate", "--category", category, "--json"]);
      expect(result.exitCode).toBe(0);
    }
    await harness.lifecycle.dispose();
  });

  it("models a rate-limit reset and a chain age", async () => {
    const { harness } = await ready({ settings: { maxTotalSpanMs: 3_600_000 } });
    const json = parse<{ decision: { action: string; rule: string; delayMs: number } }>(
      await harness.behavior.runCli([
        "simulate",
        "--json",
        "--category",
        "rate-limit",
        "--rate-limit-reset",
        "10m",
      ]),
    );
    expect(json.decision.action).toBe("retry");
    expect(json.decision.rule).toContain("rate-limit-reset");
    expect(json.decision.delayMs).toBeGreaterThanOrEqual(10 * 60_000);

    const aged = parse<{ decision: { action: string; reason: string } }>(
      await harness.behavior.runCli([
        "simulate",
        "--json",
        "--chain-age",
        "120m",
      ]),
    );
    expect(aged.decision.action).toBe("skip");
    expect(aged.decision.reason).toContain("maxTotalSpanMs");
    await harness.lifecycle.dispose();
  });

  it("models scope inputs", async () => {
    const { harness } = await ready({ settings: { scopeProjects: "proj_keep" } });
    const outside = parse<{ decision: { action: string; rule: string } }>(
      await harness.behavior.runCli(["simulate", "--json", "--project", "proj_other"]),
    );
    expect(outside.decision.action).toBe("skip");
    expect(outside.decision.rule).toBe("scope");

    const hidden = parse<{ decision: { action: string } }>(
      await harness.behavior.runCli(["simulate", "--json", "--project", "proj_keep", "--visibility", "hidden"]),
    );
    expect(hidden.decision.action).toBe("retry");

    const child = parse<{ decision: { action: string } }>(
      await harness.behavior.runCli(["simulate", "--json", "--project", "proj_keep", "--parent", "thr_p"]),
    );
    expect(child.decision.action).toBe("retry");
    await harness.lifecycle.dispose();
  });

  it("models the input-accepted half of the failure space", async () => {
    const { harness } = await ready({ settings: { inputAccepted: "accepted" } });
    const accepted = parse<{ decision: { action: string } }>(
      await harness.behavior.runCli(["simulate", "--json", "--input-accepted"]),
    );
    expect(accepted.decision.action).toBe("retry");
    const rejected = parse<{ decision: { action: string } }>(
      await harness.behavior.runCli(["simulate", "--json"]),
    );
    expect(rejected.decision.action).toBe("skip");
    await harness.lifecycle.dispose();
  });

  it("is deterministic at the jitter centre and moves with the sample", async () => {
    const { harness } = await ready();
    const centre = parse<{ decision: { delayMs: number } }>(
      await harness.behavior.runCli(["simulate", "--json", "--jitter-sample", "500"]),
    );
    expect(centre.decision.delayMs).toBe(30_000);
    const low = parse<{ decision: { delayMs: number } }>(
      await harness.behavior.runCli(["simulate", "--json", "--jitter-sample", "0"]),
    );
    expect(low.decision.delayMs).toBe(25_500);
    const high = parse<{ decision: { delayMs: number } }>(
      await harness.behavior.runCli(["simulate", "--json", "--jitter-sample", "1000"]),
    );
    expect(high.decision.delayMs).toBe(34_500);
    await harness.lifecycle.dispose();
  });

  it("matches a message rule against the text it is given", async () => {
    const { harness } = await ready({
      settings: {
        advancedJson: JSON.stringify({
          messageRules: [{ pattern: "unavailable", flags: "i", action: "skip", reason: "provider is down" }],
        }),
      },
    });
    const matched = await harness.behavior.runCli([
      "simulate",
      "--message",
      "The service is temporarily UNAVAILABLE.",
    ]);
    expect(matched.stdout).toContain("action:    skip");
    expect(matched.stdout).toContain("provider is down");

    const unmatched = await harness.behavior.runCli(["simulate", "--message", "something else"]);
    expect(unmatched.stdout).toContain("action:    retry");
    await harness.lifecycle.dispose();
  });

  it("marks a retry that the dry run would suppress", async () => {
    const { harness } = await ready({ settings: { dryRun: true } });
    const human = await harness.behavior.runCli(["simulate"]);
    expect(human.stdout).toContain("suppressed by dry run");
    await harness.lifecycle.dispose();
  });

  it("marks a retry the master switch would ignore", async () => {
    const { harness } = await ready({ settings: { enabled: false } });
    const human = await harness.behavior.runCli(["simulate"]);
    expect(human.stdout).toContain("ignored: the plugin is disabled");
    await harness.lifecycle.dispose();
  });
});

describe("cancel", () => {
  it("drops the recorded retry and clears the chain", async () => {
    const { harness } = await ready({ queued: [{ id: "q_1", payload: { kind: "retry" } }] });
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );
    const result = await harness.behavior.runCli(["cancel", "thr_1"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cancelled");
    expect(harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("explains itself when the row has already dispatched", async () => {
    const { harness } = await ready();
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );
    // The plugin recorded a queued retry, but the thread's queue is empty now.
    const result = await harness.behavior.runCli(["cancel", "thr_1"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no longer queued");
    await harness.lifecycle.dispose();
  });

  it("refuses to cancel a queued row that is not a retry", async () => {
    const { harness } = await ready({ queued: [{ id: "q_1", payload: { kind: "inline" } }] });
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );
    const result = await harness.behavior.runCli(["cancel", "thr_1"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no longer queued");
    await harness.lifecycle.dispose();
  });
});

describe("retry", () => {
  it("sends immediately when no send-at is given", async () => {
    const { harness } = await ready();
    const result = await harness.behavior.runCli(["retry", "thr_1"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("attempt 2");
    const args = harness.inspection.sdk.callsTo("threads.retry")[0]?.[0] as { sendAt?: number };
    expect(args.sendAt).toBeUndefined();
    await harness.lifecycle.dispose();
  });

  it("schedules when send-at is given, and records it as pending", async () => {
    const { harness } = await ready({ queued: [{ id: "q_1", payload: { kind: "retry" } }] });
    const result = await harness.behavior.runCli(["retry", "thr_1", "--send-at", "30m", "--reason", "because"]);
    expect(result.exitCode).toBe(0);
    const args = harness.inspection.sdk.callsTo("threads.retry")[0]?.[0] as {
      sendAt?: number;
      reason?: string;
    };
    expect(args.sendAt).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(args.reason).toBe("because");

    const json = parse<{ decisions: { rule: string; reason: string }[] }>(
      await harness.behavior.runCli(["log", "--json"]),
    );
    expect(json.decisions[0]?.rule).toBe("manual");
    expect(json.decisions[0]?.reason).toBe("because");
    await harness.lifecycle.dispose();
  });

  it("turns a core refusal into a usage error rather than a crash", async () => {
    const { harness } = await ready();
    harness.inspection.sdk.stub("threads.retry", async () => {
      throw new Error("Thread thr_1 has no failed turn to retry: it is idle.");
    });
    const result = await harness.behavior.runCli(["retry", "thr_1", "--json"]);
    expect(result.exitCode).not.toBe(0);
    const envelope = parse<{ ok: boolean; error: { message: string } }>(result);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toMatch(/no failed turn/u);
    await harness.lifecycle.dispose();
  });
});
