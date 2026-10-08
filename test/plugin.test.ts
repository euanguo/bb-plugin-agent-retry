import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

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
} = {}) {
  const queued = options.queued ?? [];
  return createFakePluginHost({
    pluginId: "agent-retry",
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({
            id: "thr_1",
            projectId: "proj_1",
            providerId: "pi",
            status: "error",
            ...options.thread,
          }),
        events: { list: async () => options.events ?? [] },
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

function retryCalls(harness: ReturnType<typeof makeHost>["harness"]): RetryArgs[] {
  return harness.inspection.sdk.callsTo("threads.retry").map(
    (args) => args[0] as RetryArgs,
  );
}

function parseStdout<T>(result: { stdout?: string }): T {
  return JSON.parse(result.stdout ?? "null") as T;
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
