// bb-plugin-agent-retry — backend entry.
//
// Watches `turn.failed` and, when the policy says so, queues another attempt
// at a later time. The decision itself lives in `policy.ts`; this file only
// gathers the facts that decision needs and acts on it.
//
// Why a BB plugin rather than Pi's own retry: Pi's retryable-error list is a
// hard-coded set of provider messages, so a failure whose text is not on it —
// or one that carries no structured error info at all — never retries. Core's
// `turn.failed` event, by contrast, is fired for every failed turn and carries
// a durable attempt counter, which is what a long backoff needs.
import type {
  BbPluginApi,
  PluginBbSdk,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import { defineSettings, resolvePolicy, type RetrySettings } from "./config.js";
import { decideRetry, type DecisionInput } from "./policy.js";
import {
  openStore,
  MAX_DECISION_ROWS,
  type DecisionAction,
  type DecisionRecord,
  type Store,
} from "./store.js";
import { registerCli } from "./cli.js";

type TurnFailedEvent = PluginThreadEventPayloads["turn.failed"];
type ThreadGetResult = Awaited<ReturnType<PluginBbSdk["threads"]["get"]>>;

export default async function plugin(bb: BbPluginApi) {
  const settings = defineSettings(bb);
  const store = openStore(bb);
  registerCli(bb, settings, store);

  // A configuration problem is worth saying once, not on every failure.
  const reportedProblems = new Set<string>();
  const reportProblems = (problems: readonly string[]) => {
    for (const problem of problems) {
      if (reportedProblems.has(problem)) continue;
      reportedProblems.add(problem);
      bb.log.warn(problem);
    }
  };

  bb.events.on("turn.failed", (event) =>
    handleTurnFailed(bb, settings, store, event, reportProblems),
  );

  // A chain ends when the thread stops failing: a successful turn goes idle,
  // and an archived or deleted thread is out of scope entirely. Clearing the
  // chain is what lets a later, unrelated failure start a fresh budget.
  const clearChain = async ({ thread }: { thread: { id: string } }) => {
    await store.clearChain(thread.id);
  };
  bb.events.on("thread.idle", clearChain);
  bb.events.on("thread.archived", clearChain);
  bb.events.on("thread.deleted", clearChain);

  // A user who cancels the queued retry has decided against it, so the chain
  // should not keep counting against `maxTotalSpanMs`. Only a row this plugin
  // queued counts: another retrier's cancellation is not our business, and
  // clearing our chain for it would hand the next failure a fresh budget.
  bb.events.on("message.cancelled", async ({ entry }) => {
    if (entry.payload.kind !== "retry") return;
    const recorded = store.latestQueuedRetry(entry.threadId);
    if (recorded?.queuedMessageId !== entry.id) return;
    await store.clearChain(entry.threadId);
  });

  // Chain state is cleared by the events above, but a thread can go idle or be
  // deleted while this plugin is unloaded, and then nothing clears it. Sweep
  // the leftovers daily; `MAX_CHAIN_AGE_MS` is far longer than any chain the
  // policy can produce, so this never cuts a live one short.
  bb.background.schedule("sweep", "17 4 * * *", async () => {
    const removed = await store.sweepChains(MAX_CHAIN_AGE_MS, Date.now());
    const pruned = store.pruneDecisions(MAX_DECISION_ROWS);
    if (removed > 0 || pruned > 0) {
      bb.log.info(
        `sweep removed ${removed} stale chain(s) and pruned ${pruned} decision row(s)`,
      );
    }
  });

  bb.log.info("loaded");
}

/**
 * How long a chain row may sit untouched before the daily sweep drops it. The
 * longest chain the default policy can build is about eleven hours, so two
 * weeks only ever removes state for threads nothing will ask about again.
 */
export const MAX_CHAIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export async function handleTurnFailed(
  bb: BbPluginApi,
  settings: RetrySettings,
  store: Store,
  event: TurnFailedEvent,
  reportProblems: (problems: readonly string[]) => void = () => {},
): Promise<void> {
  const now = Date.now();
  let logDecisions = true;
  try {
    const resolved = await resolvePolicy(settings);
    const { policy } = resolved;
    logDecisions = resolved.logDecisions;

    // The master switch: off means a failed turn is left exactly as core left
    // it, with no decision recorded and nothing queued.
    if (!resolved.enabled) return;
    reportProblems(resolved.problems);

    const [thread, errorText, chain] = await Promise.all([
      readThread(bb, event.threadId),
      readErrorText(bb, event.threadId),
      store.readChain(event.threadId),
    ]);

    const input: DecisionInput = {
      threadId: event.threadId,
      projectId: thread?.projectId ?? null,
      providerId: thread?.providerId ?? null,
      requestId: event.requestId,
      turnId: event.turnId,
      attemptNumber: event.attemptNumber,
      errorInfo: event.errorInfo,
      inputAccepted: event.inputAccepted,
      rateLimits: event.rateLimits,
      errorText,
      visibility: thread?.visibility ?? null,
      parentThreadId: thread?.parentThreadId ?? null,
      chainStartedAt: chain?.startedAt ?? null,
      now,
      random: Math.random(),
    };

    const decision = decideRetry(input, policy);
    const base: Omit<DecisionRecord, "action"> = {
      at: now,
      threadId: event.threadId,
      projectId: input.projectId,
      providerId: input.providerId,
      requestId: event.requestId,
      attempt: event.attemptNumber,
      reason: decision.reason,
      rule: decision.rule,
      category: event.errorInfo?.category ?? null,
      providerCode: event.errorInfo?.providerCode ?? null,
      httpStatus: event.errorInfo?.httpStatusCode ?? null,
      inputAccepted: event.inputAccepted,
      errorText,
      delayMs: decision.action === "retry" ? decision.delayMs : null,
      sendAt: decision.action === "retry" ? decision.sendAt : null,
      queuedMessageId: null,
    };

    if (decision.action === "skip") {
      record(bb, store, logDecisions, { ...base, action: "skip" });
      bb.log.info(
        `declined ${event.threadId} attempt ${event.attemptNumber} [${decision.rule}]: ${decision.reason}`,
      );
      return;
    }

    if (resolved.dryRun) {
      record(bb, store, logDecisions, { ...base, action: "dry-run" });
      bb.log.info(
        `[dry-run] would retry ${event.threadId} attempt ${event.attemptNumber} ` +
          `in ${Math.round(decision.delayMs / 1000)}s [${decision.rule}]: ${decision.reason}`,
      );
      return;
    }

    const result = await bb.sdk.threads.retry({
      threadId: event.threadId,
      turnRequestId: event.requestId,
      sendAt: decision.sendAt,
      reason: decision.reason,
    });
    const queuedMessageId =
      result.delivery === "queued" ? result.queuedMessageId : null;

    record(bb, store, logDecisions, {
      ...base,
      action: "retry",
      queuedMessageId,
    });

    await store.writeChain(event.threadId, {
      originalRequestId: chain?.originalRequestId ?? event.requestId,
      // The first failure of a chain starts the span clock. Later attempts
      // inherit it, so `maxTotalSpanMs` bounds the whole chain, not one hop.
      startedAt: event.attemptNumber <= 1 || chain === null ? now : chain.startedAt,
      attempts: Math.max(chain?.attempts ?? 0, event.attemptNumber),
      updatedAt: now,
    });

    bb.log.info(
      `queued attempt ${event.attemptNumber + 1}/${decision.maxAttempts} for ` +
        `${event.threadId} in ${Math.round(decision.delayMs / 1000)}s ` +
        `[${decision.rule}] ${result.delivery}`,
    );
  } catch (error) {
    const message = errorMessage(error);
    bb.log.error(`could not retry ${event.threadId}: ${message}`);
    try {
      record(bb, store, logDecisions, {
        at: now,
        threadId: event.threadId,
        projectId: null,
        providerId: null,
        requestId: event.requestId,
        attempt: event.attemptNumber,
        action: "error",
        reason: message,
        rule: "core",
        category: event.errorInfo?.category ?? null,
        providerCode: null,
        httpStatus: null,
        inputAccepted: event.inputAccepted,
        errorText: null,
        delayMs: null,
        sendAt: null,
        queuedMessageId: null,
      });
    } catch {
      // Recording is best-effort; the log line above is the durable record.
    }
  }
}

function record(
  bb: BbPluginApi,
  store: Store,
  enabled: boolean,
  decision: DecisionRecord & { action: DecisionAction },
): void {
  if (!enabled) return;
  try {
    store.record(decision);
  } catch (error) {
    bb.log.warn(`could not record decision: ${errorMessage(error)}`);
  }
}

async function readThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<ThreadGetResult | null> {
  try {
    return await bb.sdk.threads.get({ threadId });
  } catch {
    // A thread we cannot read still gets the failure's own facts, which is
    // enough for the policy to act on.
    return null;
  }
}

/**
 * The provider's own words for the failure. `turn.failed` carries ids and
 * classifications but not text, and message rules match on text, so this is
 * one extra read on the failure path — never on the happy path.
 *
 * Two event types, because a turn can fail in two places: inside a turn the
 * provider reports `provider/error`, while a request the provider refused at
 * the door lands as `system/error` ("Command thread.start failed"). Reading
 * only the first would leave every message rule blind to door rejections.
 */
async function readErrorText(
  bb: BbPluginApi,
  threadId: string,
): Promise<string | null> {
  try {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      types: ["provider/error", "system/error"],
      order: "desc",
      limit: "1",
    });
    const row = rows[0];
    if (row === undefined) return null;
    if (row.type !== "provider/error" && row.type !== "system/error") {
      return null;
    }
    const parts = [row.data.message];
    if (typeof row.data.detail === "string" && row.data.detail.length > 0) {
      parts.push(row.data.detail);
    }
    if (row.type === "system/error" && typeof row.data.code === "string") {
      parts.push(`(${row.data.code})`);
    }
    return parts.join(" — ");
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
