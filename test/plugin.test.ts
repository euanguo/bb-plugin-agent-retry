import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeQueueEntry,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { MAX_DECISION_ROWS, openStore } from "../store.js";

interface RetryArgs {
  threadId: string;
  turnRequestId?: string;
  sendAt?: number;
  reason?: string;
}

interface QueuedRow {
  id: string;
  payload: { kind: string; reason?: string };
}

function makeHost(options: {
  settings?: Record<string, string | number | boolean>;
  thread?: Parameters<typeof makeThreadResponse>[0];
  queued?: QueuedRow[];
  events?: unknown[];
  retryResult?: Record<string, unknown>;
  getThrows?: boolean;
  eventsThrow?: boolean;
  /** Extra threads for isolation tests, keyed by thread id. */
  threads?: Record<string, Parameters<typeof makeThreadResponse>[0]>;
} = {}) {
  const queued = options.queued ?? [];
  return createFakePluginHost({
    pluginId: "agent-retry",
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    sdk: {
      threads: {
        get: async (args) => {
          if (options.getThrows === true) {
            throw new Error("thread not found");
          }
          const extra = options.threads?.[args.threadId];
          return makeThreadResponse({
            id: args.threadId,
            projectId: "proj_1",
            providerId: "pi",
            status: "error",
            ...options.thread,
            ...extra,
          });
        },
        events: {
          list: async () => {
            if (options.eventsThrow === true) throw new Error("events unavailable");
            return options.events ?? [];
          },
        },
        retry: async (args) =>
          options.retryResult ?? {
            ok: true,
            delivery: "queued",
            turnRequestId: args.turnRequestId ?? "req_1",
            attempt: 2,
            queuedMessageId: "q_1",
            waitingOn: { kind: "thread-busy" },
            sendAt: args.sendAt ?? null,
          },
        queuedMessages: {
          list: async () => queued,
          delete: async () => ({ ok: true }),
        },
      },
    },
  });
}

function retryCalls(harness: ReturnType<typeof makeHost>["harness"]): RetryArgs[] {
  return harness.inspection.sdk.callsTo("threads.retry").map(
    (args) => args[0] as RetryArgs,
  );
}

function parseStdout<T>(result: { stdout?: string }): T {
  return JSON.parse(result.stdout ?? "null") as T;
}

async function decisions(
  harness: ReturnType<typeof makeHost>["harness"],
): Promise<
  {
    action: string;
    rule: string;
    reason: string;
    attempt: number;
    threadId: string;
    errorText: string | null;
    sendAt: number | null;
    delayMs: number | null;
    queuedMessageId: string | null;
  }[]
> {
  const result = await harness.behavior.runCli(["log", "--json", "--limit", "200"]);
  return parseStdout<{ decisions: never[] }>(result).decisions;
}

async function fail(
  harness: ReturnType<typeof makeHost>["harness"],
  overrides: Parameters<typeof makeTurnFailedEvent>[0] = {},
) {
  return harness.behavior.emitThreadEvent(
    "turn.failed",
    makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1, ...overrides }),
  );
}

describe("turn.failed handling", () => {
  it("queues a retry for a failure with no structured error info", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    const before = Date.now();

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId: "thr_1",
        requestId: "req_1",
        errorInfo: null,
        attemptNumber: 1,
      }),
    );

    const calls = retryCalls(harness);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.threadId).toBe("thr_1");
    expect(calls[0]?.turnRequestId).toBe("req_1");
    expect(calls[0]?.reason).toBe("Agent retry 2/50 — unclassified failure");
    // 30s base with 15% jitter.
    expect(calls[0]?.sendAt).toBeGreaterThanOrEqual(before + 25_000);
    expect(calls[0]?.sendAt).toBeLessThanOrEqual(Date.now() + 35_000);

    const log = parseStdout<{ decisions: { action: string; queuedMessageId: string | null }[] }>(
      await harness.behavior.runCli(["log", "--json"]),
    );
    expect(log.decisions[0]?.action).toBe("retry");
    expect(log.decisions[0]?.queuedMessageId).toBe("q_1");

    await harness.lifecycle.dispose();
  });

  it("declines a category that cannot succeed on retry", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId: "thr_1",
        errorInfo: { category: "billing", providerCode: null, httpStatusCode: 402 },
        attemptNumber: 1,
      }),
    );

    expect(retryCalls(harness)).toHaveLength(0);
    const log = parseStdout<{ decisions: { action: string; reason: string }[] }>(
      await harness.behavior.runCli(["log", "--json"]),
    );
    expect(log.decisions[0]?.action).toBe("skip");
    expect(log.decisions[0]?.reason).toContain("billing");

    await harness.lifecycle.dispose();
  });

  it("stops at the configured attempt cap", async () => {
    const { bb, harness } = makeHost({ settings: { maxAttempts: 2 } });
    await plugin(bb);

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 2 }),
    );

    expect(retryCalls(harness)).toHaveLength(0);
    const log = parseStdout<{ decisions: { reason: string }[] }>(
      await harness.behavior.runCli(["log", "--json"]),
    );
    expect(log.decisions[0]?.reason).toContain("attempts exhausted (2/2)");

    await harness.lifecycle.dispose();
  });

  it("records the decision without queueing when dry run is on", async () => {
    const { bb, harness } = makeHost({ settings: { dryRun: true } });
    await plugin(bb);

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );

    expect(retryCalls(harness)).toHaveLength(0);
    const log = parseStdout<{ decisions: { action: string }[] }>(
      await harness.behavior.runCli(["log", "--json"]),
    );
    expect(log.decisions[0]?.action).toBe("dry-run");

    await harness.lifecycle.dispose();
  });

  it("honours scope: a hidden thread is left alone when retryHidden is off", async () => {
    const { bb, harness } = makeHost({
      settings: { retryHidden: false },
      thread: { visibility: "hidden" },
    });
    await plugin(bb);

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );

    expect(retryCalls(harness)).toHaveLength(0);
    const log = parseStdout<{ decisions: { rule: string }[] }>(
      await harness.behavior.runCli(["log", "--json"]),
    );
    expect(log.decisions[0]?.rule).toBe("scope");

    await harness.lifecycle.dispose();
  });

  it("reads a door rejection's text from system/error so message rules can match", async () => {
    const { bb, harness } = makeHost({
      settings: {
        advancedJson: JSON.stringify({
          messageRules: [
            {
              pattern: "Failed to resolve",
              flags: "i",
              action: "skip",
              reason: "the model does not exist",
            },
          ],
        }),
      },
      events: [
        {
          id: "evt_1",
          seq: 15,
          threadId: "thr_1",
          scope: { kind: "thread" },
          createdAt: 1,
          type: "system/error",
          data: {
            code: "thread_command_failed",
            message: "Command thread.start failed",
            detail: 'Failed to resolve Pi model "definitely-not-a-real-model"',
          },
        },
      ],
    });
    await plugin(bb);

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1, inputAccepted: false }),
    );

    expect(retryCalls(harness)).toHaveLength(0);
    const log = parseStdout<{
      decisions: { action: string; rule: string; reason: string; errorText: string | null }[];
    }>(await harness.behavior.runCli(["log", "--json"]));
    expect(log.decisions[0]?.action).toBe("skip");
    expect(log.decisions[0]?.rule).toBe("message:Failed to resolve/i");
    expect(log.decisions[0]?.errorText).toContain("Failed to resolve Pi model");
    expect(log.decisions[0]?.errorText).toContain("thread_command_failed");

    await harness.lifecycle.dispose();
  });

  it("keeps a chain's span clock across attempts and clears it when the thread goes idle", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 2 }),
    );
    expect(retryCalls(harness)).toHaveLength(2);

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1", status: "idle" }),
      lastAssistantText: "done",
    });
    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );
    expect(retryCalls(harness)).toHaveLength(3);

    await harness.lifecycle.dispose();
  });

  it("records an error instead of throwing when core refuses the retry", async () => {
    const { bb, harness } = makeHost();
    harness.inspection.sdk.stub("threads.retry", async () => {
      throw new Error("Turn req_1 already has a retry waiting on thread thr_1.");
    });
    await plugin(bb);

    const result = await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );
    expect(result.errors).toHaveLength(0);

    const log = parseStdout<{ decisions: { action: string; reason: string }[] }>(
      await harness.behavior.runCli(["log", "--json"]),
    );
    expect(log.decisions[0]?.action).toBe("error");
    expect(log.decisions[0]?.reason).toContain("already has a retry waiting");

    await harness.lifecycle.dispose();
  });
});

describe("cli", () => {
  it("status reports the effective policy", async () => {
    const { bb, harness } = makeHost({ settings: { maxAttempts: 12, baseDelayMs: 5_000 } });
    await plugin(bb);

    const status = parseStdout<{
      policy: { defaults: { maxAttempts: number; baseDelayMs: number } };
      dryRun: boolean;
      pending: unknown[];
    }>(await harness.behavior.runCli(["status", "--json"]));

    expect(status.policy.defaults.maxAttempts).toBe(12);
    expect(status.policy.defaults.baseDelayMs).toBe(5_000);
    expect(status.dryRun).toBe(false);
    expect(status.pending).toEqual([]);

    await harness.lifecycle.dispose();
  });

  it("simulate explains the decision for a failure shape", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);

    const human = await harness.behavior.runCli([
      "simulate",
      "--message",
      "The service is temporarily unavailable. Please retry later.",
      "--category",
      "none",
    ]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("action:    retry");
    expect(human.stdout).toContain("rule:      defaults");

    const declined = await harness.behavior.runCli([
      "simulate",
      "--category",
      "unauthorized",
    ]);
    expect(declined.stdout).toContain("action:    skip");

    const simulated = parseStdout<{ decision: { action: string } }>(
      await harness.behavior.runCli(["simulate", "--json", "--attempt", "9"]),
    );
    expect(simulated.decision.action).toBe("retry");

    await harness.lifecycle.dispose();
  });

  it("simulate honours advanced message rules", async () => {
    const { bb, harness } = makeHost({
      settings: {
        advancedJson: JSON.stringify({
          messageRules: [
            {
              pattern: "temporarily unavailable",
              flags: "i",
              action: "retry",
              maxAttempts: 20,
              baseDelayMs: 1_000,
              growth: 1,
            },
          ],
        }),
      },
    });
    await plugin(bb);

    const result = parseStdout<{
      decision: { action: string; rule: string; delayMs: number; maxAttempts: number };
    }>(
      await harness.behavior.runCli([
        "simulate",
        "--json",
        "--message",
        "The service is temporarily unavailable. Please retry later.",
      ]),
    );
    expect(result.decision.action).toBe("retry");
    expect(result.decision.rule).toBe("message:temporarily unavailable/i");
    expect(result.decision.maxAttempts).toBe(20);
    expect(result.decision.delayMs).toBe(1_000);

    await harness.lifecycle.dispose();
  });

  it("cancel deletes the retry this plugin queued", async () => {
    const { bb, harness } = makeHost({
      queued: [{ id: "q_1", payload: { kind: "retry" } }],
    });
    await plugin(bb);

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "thr_1", attemptNumber: 1 }),
    );

    const result = await harness.behavior.runCli(["cancel", "thr_1", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(parseStdout<{ ok: boolean; queuedMessageId: string }>(result).queuedMessageId).toBe(
      "q_1",
    );
    const deleted = harness.inspection.sdk.callsTo("threads.queuedMessages.delete");
    expect(deleted).toHaveLength(1);

    await harness.lifecycle.dispose();
  });

  it("cancel fails loudly when there is nothing to cancel", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);

    const result = await harness.behavior.runCli(["cancel", "thr_none"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no queued retry recorded");

    await harness.lifecycle.dispose();
  });

  it("retry re-submits a failed thread on demand, and records it so cancel can drop it", async () => {
    const { bb, harness } = makeHost({
      queued: [{ id: "q_1", payload: { kind: "retry" } }],
    });
    await plugin(bb);

    const result = await harness.behavior.runCli(["retry", "thr_1", "--send-at", "30m"]);
    expect(result.exitCode).toBe(0);
    const calls = retryCalls(harness);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.threadId).toBe("thr_1");
    expect(calls[0]?.reason).toContain("Manual retry");
    expect(calls[0]?.sendAt).toBeGreaterThan(Date.now() + 29 * 60_000);

    const log = parseStdout<{ decisions: { action: string; rule: string }[] }>(
      await harness.behavior.runCli(["log", "--json"]),
    );
    expect(log.decisions[0]?.action).toBe("retry");
    expect(log.decisions[0]?.rule).toBe("manual");

    const cancelled = await harness.behavior.runCli(["cancel", "thr_1"]);
    expect(cancelled.exitCode).toBe(0);
    expect(harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(1);

    await harness.lifecycle.dispose();
  });
});

describe("failure paths and degraded inputs", () => {
  it("still retries when the thread cannot be read, using the failure's own facts", async () => {
    const { bb, harness } = makeHost({ getThrows: true });
    await plugin(bb);
    await fail(harness);

    const calls = retryCalls(harness);
    expect(calls).toHaveLength(1);
    const rows = await decisions(harness);
    expect(rows[0]?.action).toBe("retry");
    // No project or provider, so nothing scope-related could be evaluated —
    // but the failure itself was enough to decide.
    expect(rows[0]?.reason).toContain("Agent retry");
    await harness.lifecycle.dispose();
  });

  it("still retries when the error text cannot be read", async () => {
    const { bb, harness } = makeHost({ eventsThrow: true });
    await plugin(bb);
    await fail(harness);

    expect(retryCalls(harness)).toHaveLength(1);
    const rows = await decisions(harness);
    expect(rows[0]?.errorText).toBeNull();
    expect(rows[0]?.action).toBe("retry");
    await harness.lifecycle.dispose();
  });

  it("queues the retry even when the decision log cannot be written", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    // Break the log the way a corrupted or read-only database would.
    bb.storage.database().exec("DROP TABLE retry_decisions");

    const result = await fail(harness);
    expect(result.errors).toHaveLength(0);
    expect(retryCalls(harness)).toHaveLength(1);
    expect(
      harness.inspection.logEntries.some((entry) =>
        entry.message.includes("could not record decision"),
      ),
    ).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("records an immediate retry that core sent rather than queued", async () => {
    const { bb, harness } = makeHost({
      retryResult: { ok: true, delivery: "sent", turnRequestId: "req_1", attempt: 2 },
    });
    await plugin(bb);
    await fail(harness);

    const rows = await decisions(harness);
    expect(rows[0]?.action).toBe("retry");
    expect(rows[0]?.queuedMessageId).toBeNull();
    // Nothing is pending, because nothing was queued.
    const status = parseStdout<{ pending: unknown[] }>(
      await harness.behavior.runCli(["status", "--json"]),
    );
    expect(status.pending).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("floors the wait at a reported rate-limit reset", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    const now = Date.now();
    await fail(harness, {
      errorInfo: { category: "rate-limit", providerCode: null, httpStatusCode: 429 },
      rateLimits: {
        providerId: "pi",
        status: "blocked",
        kind: "subscription-window",
        windows: [
          { providerKey: null, label: "5h", status: "blocked", resetsAtMs: now + 600_000 },
        ],
        reachedReason: null,
        overageStatus: null,
        overageReason: null,
      },
    });

    const calls = retryCalls(harness);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sendAt).toBeGreaterThanOrEqual(now + 600_000 + 15_000);
    const rows = await decisions(harness);
    expect(rows[0]?.rule).toContain("rate-limit-reset");
    await harness.lifecycle.dispose();
  });

  it("keeps two threads' chains apart", async () => {
    const { bb, harness } = makeHost({
      threads: { thr_2: { id: "thr_2", projectId: "proj_2" } },
    });
    await plugin(bb);

    await fail(harness, { threadId: "thr_1", requestId: "req_1" });
    await fail(harness, { threadId: "thr_2", requestId: "req_2", attemptNumber: 1 });
    await fail(harness, { threadId: "thr_1", requestId: "req_3", attemptNumber: 2 });

    const rows = await decisions(harness);
    // `log` returns newest first.
    expect(rows.map((row) => row.threadId)).toEqual(["thr_1", "thr_2", "thr_1"]);
    expect(rows[0]?.attempt).toBe(2);
    expect(rows[2]?.attempt).toBe(1);
    await harness.lifecycle.dispose();
  });
});

describe("chain lifecycle", () => {
  it("stops a chain that has outlived maxTotalSpanMs", async () => {
    const { bb, harness } = makeHost({ settings: { maxTotalSpanMs: 1 } });
    await plugin(bb);

    await fail(harness, { attemptNumber: 1 });
    // The first failure writes the span clock; a millisecond later the second
    // is already past a one-millisecond budget.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fail(harness, { attemptNumber: 2 });

    expect(retryCalls(harness)).toHaveLength(1);
    const rows = await decisions(harness);
    expect(rows[0]?.action).toBe("skip");
    expect(rows[0]?.reason).toContain("maxTotalSpanMs");
    await harness.lifecycle.dispose();
  });

  it("clears a chain when the user cancels the retry this plugin queued", async () => {
    // The span cap is the observable: if the chain survived, the second
    // failure is declined.
    const { bb, harness } = makeHost({ settings: { maxTotalSpanMs: 1 } });
    await plugin(bb);
    await fail(harness, { attemptNumber: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await harness.behavior.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({
        id: "q_1",
        threadId: "thr_1",
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req_1",
          attempt: 2,
          reason: "Agent retry",
        },
      }),
    });
    await fail(harness, { attemptNumber: 2 });

    // A fresh chain, so a fresh budget: the retry goes out.
    expect(retryCalls(harness)).toHaveLength(2);
    await harness.lifecycle.dispose();
  });

  it("keeps its chain when some other retrier's row is cancelled", async () => {
    const { bb, harness } = makeHost({ settings: { maxTotalSpanMs: 1 } });
    await plugin(bb);
    await fail(harness, { attemptNumber: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await harness.behavior.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({
        id: "q_someone_else",
        threadId: "thr_1",
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req_1",
          attempt: 2,
          reason: "Rate limited",
        },
      }),
    });
    await fail(harness, { attemptNumber: 2 });

    // The span clock survived, so the second failure is declined.
    expect(retryCalls(harness)).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("ignores the cancellation of a queued message that is not a retry", async () => {
    const { bb, harness } = makeHost({ settings: { maxTotalSpanMs: 1 } });
    await plugin(bb);
    await fail(harness, { attemptNumber: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await harness.behavior.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_1", payload: { kind: "inline" } }),
    });
    await fail(harness, { attemptNumber: 2 });
    // The chain survived, so the span cap still applies.
    const rows = await decisions(harness);
    expect(rows[0]?.action).toBe("skip");
    await harness.lifecycle.dispose();
  });

  it("clears a chain when the thread is archived or deleted", async () => {
    for (const event of ["thread.archived", "thread.deleted"] as const) {
      const { bb, harness } = makeHost({ settings: { maxTotalSpanMs: 1 } });
      await plugin(bb);
      await fail(harness, { attemptNumber: 1 });
      await harness.behavior.emitThreadEvent(event, {
        thread: makeThreadResponse({ id: "thr_1" }),
      });
      await fail(harness, { attemptNumber: 2 });
      const rows = await decisions(harness);
      expect(rows[0]?.action).toBe("retry");
      await harness.lifecycle.dispose();
    }
  });
});

describe("settings that change behaviour", () => {
  it("records nothing at all while the plugin is disabled", async () => {
    const { bb, harness } = makeHost({ settings: { enabled: false } });
    await plugin(bb);
    await fail(harness);

    expect(retryCalls(harness)).toHaveLength(0);
    expect(await decisions(harness)).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("records nothing but still decides while the decision log is off", async () => {
    const { bb, harness } = makeHost({ settings: { logDecisions: false } });
    await plugin(bb);
    await fail(harness);

    expect(retryCalls(harness)).toHaveLength(1);
    expect(await decisions(harness)).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("applies a settings change to the next failure, without a reload", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    await fail(harness, { attemptNumber: 1 });
    expect(retryCalls(harness)).toHaveLength(1);

    await harness.behavior.setSettings({ maxAttempts: 2 });
    await fail(harness, { attemptNumber: 2 });
    expect(retryCalls(harness)).toHaveLength(1);

    const rows = await decisions(harness);
    expect(rows[0]?.reason).toContain("attempts exhausted (2/2)");
    await harness.lifecycle.dispose();
  });

  it("retries only what scope allows", async () => {
    const { bb, harness } = makeHost({
      settings: { scopeProjects: "proj_other" },
    });
    await plugin(bb);
    await fail(harness);

    expect(retryCalls(harness)).toHaveLength(0);
    const rows = await decisions(harness);
    expect(rows[0]?.rule).toBe("scope");
    await harness.lifecycle.dispose();
  });

  it("can refuse a request the provider never took", async () => {
    const { bb, harness } = makeHost({ settings: { inputAccepted: "accepted" } });
    await plugin(bb);
    await fail(harness, { inputAccepted: false });

    expect(retryCalls(harness)).toHaveLength(0);
    const rows = await decisions(harness);
    expect(rows[0]?.reason).toContain("never took the input");
    await harness.lifecycle.dispose();
  });

  it("carries an unclassified failure's provider codes into the log", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    await fail(harness, {
      errorInfo: { category: "overloaded", providerCode: "server_busy", httpStatusCode: 503 },
    });

    const rows = await decisions(harness);
    expect(rows[0]?.action).toBe("retry");
    await harness.lifecycle.dispose();
  });
});

describe("reload", () => {
  it("re-registers and keeps working, and its migrations re-run cleanly", async () => {
    const first = makeHost();
    await plugin(first.bb);
    await fail(first.harness, { attemptNumber: 1 });
    expect(retryCalls(first.harness)).toHaveLength(1);

    // `reload` builds a new host against the same persisted state and disposes
    // the old one, so everything after this point must use the replacement.
    const second = await first.harness.lifecycle.reload(plugin);
    expect(retryCalls(second.harness)).toHaveLength(0);

    await fail(second.harness, { attemptNumber: 2 });
    expect(retryCalls(second.harness)).toHaveLength(1);

    // The decision log survived the reload, so the new generation appended to
    // the same table rather than starting a fresh one.
    const rows = await decisions(second.harness);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.attempt).toBe(2);

    await second.harness.lifecycle.dispose();
  });

  it("keeps a chain's span clock across a reload", async () => {
    const first = makeHost({ settings: { maxTotalSpanMs: 1 } });
    await plugin(first.bb);
    await fail(first.harness, { attemptNumber: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await first.harness.lifecycle.reload(plugin);
    await fail(second.harness, { attemptNumber: 2 });

    // The clock lives in kv, which a reload preserves, so the replacement
    // declines the second attempt without ever calling core.
    expect(retryCalls(second.harness)).toHaveLength(0);
    const rows = await decisions(second.harness);
    expect(rows[0]?.action).toBe("skip");
    expect(rows[0]?.reason).toContain("maxTotalSpanMs");

    await second.harness.lifecycle.dispose();
  });
});

describe("housekeeping", () => {
  it("registers a daily sweep", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    expect(harness.registrations.schedules.map((entry) => entry.name)).toContain("sweep");
    await harness.lifecycle.dispose();
  });

  it("sweeps chain state nothing will ask about again, and keeps a live chain", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    await fail(harness, { attemptNumber: 1 });
    // A leftover from a thread that settled while the plugin was unloaded.
    await bb.storage.kv.set("chain:thr_abandoned", {
      originalRequestId: "req_old",
      startedAt: 1,
      attempts: 3,
      updatedAt: 1,
    });
    // And one that is merely old, but not older than the sweep's horizon.
    const recent = Date.now() - 60_000;
    await bb.storage.kv.set("chain:thr_recent", {
      originalRequestId: "req_recent",
      startedAt: recent,
      attempts: 2,
      updatedAt: recent,
    });

    await harness.behavior.runSchedule("sweep");

    expect((await bb.storage.kv.list("chain:")).sort()).toEqual([
      "chain:thr_1",
      "chain:thr_recent",
    ]);
    await harness.lifecycle.dispose();
  });

  it("bounds the decision log instead of growing forever", async () => {
    const { bb, harness } = makeHost();
    const store = openStore(bb);
    const base = {
      at: Date.now(),
      threadId: "thr_1",
      projectId: "proj_1",
      providerId: "pi",
      requestId: "req_1",
      attempt: 1,
      action: "retry" as const,
      reason: "r",
      rule: "defaults",
      category: null,
      providerCode: null,
      httpStatus: null,
      inputAccepted: true,
      errorText: null,
      delayMs: 1_000,
      sendAt: null,
      queuedMessageId: null,
    };
    for (let index = 0; index < MAX_DECISION_ROWS + 250; index += 1) {
      store.record({ ...base, at: base.at + index });
    }

    const count = (
      bb.storage.database().prepare("SELECT COUNT(*) AS count FROM retry_decisions").get() as {
        count: number;
      }
    ).count;
    expect(count).toBe(MAX_DECISION_ROWS);

    // And the newest row is the one that survived, not an arbitrary window.
    const rows = store.list({ limit: 1 });
    expect(rows[0]?.at).toBe(base.at + MAX_DECISION_ROWS + 249);

    // An explicit prune reports what it dropped.
    expect(store.pruneDecisions(10)).toBe(MAX_DECISION_ROWS - 10);
    await harness.lifecycle.dispose();
  });
});
