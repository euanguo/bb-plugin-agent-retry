// agent-retry — the `bb agent-retry` command.
//
// Everything an operator needs to trust or tune the policy: what it is doing
// right now, what it decided in the past, what it would decide for a failure
// shape you describe by hand, and the two escape hatches (cancel a queued
// retry, retry a thread now).
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { resolvePolicy, type RetrySettings } from "./config.js";
import {
  computeDelayMs,
  decideRetry,
  type DecisionInput,
  type RetryPolicy,
} from "./policy.js";
import type { DecisionAction, DecisionRow, Store } from "./store.js";

/** The categories a failure can carry, plus `none` for an unclassified one. */
const CATEGORY_VALUES = [
  "none",
  "active-turn-not-steerable",
  "bad-request",
  "connection-failed",
  "context-window-exceeded",
  "billing",
  "budget-exceeded",
  "internal",
  "max-output-tokens",
  "max-turns",
  "overloaded",
  "policy",
  "rate-limit",
  "sandbox",
  "stream-disconnected",
  "structured-output-retries",
  "thread-rollback-failed",
  "too-many-failed-attempts",
  "unauthorized",
  "unknown",
] as const;

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Number(hours.toFixed(1))}h`;
  return `${Number((hours / 24).toFixed(1))}d`;
}

export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function policyLines(
  policy: RetryPolicy,
  dryRun: boolean,
  enabled = true,
): string[] {
  const { defaults } = policy;
  const lines = [
    `enabled:         ${enabled}`,
    `attempts:        ${defaults.maxAttempts} (original dispatch counts as 1)`,
    `backoff:         ${defaults.strategy} base ${formatDuration(defaults.baseDelayMs)} ` +
      `growth ${defaults.growth} cap ${formatDuration(defaults.maxDelayMs)} ` +
      `jitter ${defaults.jitterPct}%`,
    `dry run:         ${dryRun}`,
    `unclassified:    ${policy.retryWhenUnknown ? "retried" : "declined"}`,
    `skip categories: ${policy.skipCategories.length > 0 ? policy.skipCategories.join(", ") : "(none)"}`,
    `chain span cap:  ${policy.maxTotalSpanMs > 0 ? formatDuration(policy.maxTotalSpanMs) : "unlimited"}`,
    `single wait cap: ${policy.maxWaitMs > 0 ? formatDuration(policy.maxWaitMs) : "unlimited"}`,
    `rate-limit wait: ${policy.honorRateLimitReset ? `honoured (+${formatDuration(policy.resetPadMs)})` : "ignored"}`,
    `category rules:  ${Object.keys(policy.categoryRules).length}`,
    `message rules:   ${policy.messageRules.map((rule) => rule.source).join(", ") || "(none)"}`,
    `scope projects:  ${listOrAll(policy.scope.projects, policy.scope.excludeProjects, "project")}`,
    `scope providers: ${listOrAll(policy.scope.providers, policy.scope.excludeProviders, "provider")}`,
    `scope threads:   ${policy.scope.excludeThreads.length} excluded, ` +
      `${policy.scope.threadPatterns.length} patterns` +
      `${policy.scope.retryHidden ? "" : ", hidden skipped"}` +
      `${policy.scope.retryChild ? "" : ", children skipped"}`,
  ];
  return lines;
}

function listOrAll(
  allow: readonly string[],
  deny: readonly string[],
  noun: string,
): string {
  const parts: string[] = [];
  parts.push(allow.length === 0 ? `all ${noun}s` : allow.join(", "));
  if (deny.length > 0) parts.push(`minus ${deny.join(", ")}`);
  return parts.join(" ");
}

function decisionLine(row: DecisionRow): string {
  const when = formatTimestamp(row.at);
  const attempt = `${row.attempt}`;
  const timing =
    row.sendAt === null
      ? ""
      : ` → in ${formatDuration(Math.max(0, row.sendAt - row.at))}`;
  return (
    `${when}  ${row.action.padEnd(7)} #${attempt.padStart(2)}  ${row.threadId}  ` +
    `[${row.rule}] ${row.reason}${timing}`
  );
}

function scheduleLines(policy: RetryPolicy, count: number): string[] {
  const lines: string[] = [];
  const limit = Math.min(count, policy.defaults.maxAttempts - 1);
  for (let attempt = 1; attempt <= limit; attempt++) {
    lines.push(
      `  attempt ${String(attempt + 1).padStart(3)}: +${formatDuration(
        computeDelayMs(policy.defaults, attempt),
      )}`,
    );
  }
  return lines;
}

export function registerCli(
  bb: BbPluginApi,
  settings: RetrySettings,
  store: Store,
): void {
  bb.cli.register(
    defineCli({
      name: "agent-retry",
      summary: "Inspect and control automatic retries of failed turns",
      description:
        "Retries a failed turn with a growing backoff, for any failure the " +
        "provider reports — including ones with no structured error info. " +
        "Configure it under Settings → Installed plugins, or with " +
        "`bb plugin config agent-retry`.",
      // A bad invocation is a usage error, and every other `bb` command says
      // so with exit 2.
      usageErrorExitCode: 2,
      commands: {
        status: cliCommand({
          summary: "Show the effective policy, recent activity, and pending retries",
          options: { json: JSON_OPTION },
          async run(input) {
            const { policy, dryRun, enabled, problems } =
              await resolvePolicy(settings);
            const since = Date.now() - 24 * 60 * 60 * 1000;
            const counts = store.countsSince(since);
            const pending = await listPendingRetries(bb, store);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  {
                    enabled,
                    policy: serialisePolicy(policy),
                    dryRun,
                    counts,
                    pending,
                    problems,
                  },
                  null,
                  2,
                ),
              };
            }
            const lines = [
              ...policyLines(policy, dryRun, enabled),
              ...problems.map((problem) => `problem:         ${problem}`),
              "",
              `last 24h:        ${counts.retry} queued, ${counts.skip} declined, ` +
                `${counts.error} failed to queue` +
                (counts["dry-run"] > 0 ? `, ${counts["dry-run"]} dry-run` : ""),
            ];
            if (pending.length === 0) {
              lines.push("pending retries: none");
            } else {
              lines.push(`pending retries: ${pending.length}`);
              for (const entry of pending) {
                lines.push(
                  `  ${entry.threadId}  attempt ${entry.attempt + 1}  ` +
                    `in ${formatDuration(Math.max(0, (entry.sendAt ?? 0) - Date.now()))}  ` +
                    `${entry.reason}`,
                );
              }
            }
            lines.push("", "next waits:", ...scheduleLines(policy, 6));
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),

        log: cliCommand({
          summary: "Show the decision log",
          options: {
            limit: {
              type: "integer",
              min: 1,
              max: 200,
              default: 20,
              description: "How many decisions to show",
            },
            thread: {
              type: "string",
              description: "Only this thread id",
            },
            action: {
              type: "enum",
              values: ["retry", "skip", "dry-run", "error"],
              description: "Only this decision action",
            },
            json: JSON_OPTION,
          },
          async run(input) {
            const rows = store.list({
              limit: input.options.limit,
              threadId: input.options.thread,
              action: input.options.action as DecisionAction | undefined,
            });
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ decisions: rows }, null, 2) };
            }
            if (rows.length === 0) {
              return { exitCode: 0, stdout: "No decisions recorded." };
            }
            return { exitCode: 0, stdout: rows.map(decisionLine).join("\n") };
          },
        }),

        explain: cliCommand({
          summary: "Print the fully resolved policy, after both config layers",
          options: { json: JSON_OPTION },
          async run(input) {
            const resolved = await resolvePolicy(settings);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  {
                    enabled: resolved.enabled,
                    policy: serialisePolicy(resolved.policy),
                    dryRun: resolved.dryRun,
                    logDecisions: resolved.logDecisions,
                    advanced: resolved.advanced,
                    problems: resolved.problems,
                  },
                  null,
                  2,
                ),
              };
            }
            const lines = [
              ...policyLines(
                resolved.policy,
                resolved.dryRun,
                resolved.enabled,
              ),
              ...resolved.problems.map((problem) => `problem:         ${problem}`),
              "",
              `decision log:    ${resolved.logDecisions ? "on" : "off"}`,
              "",
              "waits this policy would use:",
              ...scheduleLines(resolved.policy, 12),
              "",
              "category rules:",
              ...Object.entries(resolved.policy.categoryRules).map(
                ([key, rule]) => `  ${key}: ${JSON.stringify(rule)}`,
              ),
              ...(Object.keys(resolved.policy.categoryRules).length === 0
                ? ["  (none)"]
                : []),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),

        simulate: cliCommand({
          summary: "Show what the policy would decide for a failure you describe",
          description:
            "Replay a failure shape without waiting for one. Handy for tuning: " +
            "the decision, the rule that made it, and the resulting wait.",
          options: {
            category: {
              type: "enum",
              values: CATEGORY_VALUES,
              default: "none",
              description: "The failure's structured category; none = no error info",
            },
            message: {
              type: "string",
              default: "",
              description: "The provider's error text, for message rules",
            },
            attempt: {
              type: "integer",
              min: 1,
              max: 1000,
              default: 1,
              description: "The attempt that just failed; 1 is the original",
            },
            provider: {
              type: "string",
              default: "",
              description: "Provider id, for scope checks",
            },
            project: {
              type: "string",
              default: "",
              description: "Project id, for scope checks",
            },
            thread: {
              type: "string",
              default: "thr_simulated",
              description: "Thread id, for scope checks",
            },
            visibility: {
              type: "enum",
              values: ["visible", "hidden"],
              default: "visible",
              description: "Thread visibility, for scope checks",
            },
            parent: {
              type: "string",
              default: "",
              description: "Parent thread id, to simulate a child thread",
            },
            "input-accepted": {
              type: "boolean",
              description: "The provider had taken the input before failing",
            },
            "rate-limit-status": {
              type: "enum",
              values: ["allowed", "warning", "blocked", "unknown"],
              default: "blocked",
              description: "Rate-limit state to assume",
            },
            "rate-limit-reset": {
              type: "duration",
              defaultUnit: "m",
              min: 0,
              default: 0,
              description: "When the rate limit resets, from now; 0 = no reset time",
            },
            "chain-age": {
              type: "duration",
              defaultUnit: "m",
              min: 0,
              default: 0,
              description: "How long this chain has been retrying",
            },
            "jitter-sample": {
              type: "integer",
              min: 0,
              max: 1000,
              default: 500,
              description: "Jitter sample, 0-1000; 500 is the un-jittered centre",
            },
            json: JSON_OPTION,
          },
          async run(input) {
            const { policy, dryRun, enabled } = await resolvePolicy(settings);
            const now = Date.now();
            const category =
              input.options.category === "none" ? null : input.options.category;
            const resetMs = input.options["rate-limit-reset"];
            const decisionInput: DecisionInput = {
              threadId: input.options.thread,
              projectId: input.options.project === "" ? null : input.options.project,
              providerId:
                input.options.provider === "" ? null : input.options.provider,
              requestId: "req_simulated",
              turnId: null,
              attemptNumber: input.options.attempt,
              errorInfo:
                category === null
                  ? null
                  : { category, providerCode: null, httpStatusCode: null },
              inputAccepted: input.options["input-accepted"],
              rateLimits:
                resetMs > 0
                  ? {
                      status: input.options["rate-limit-status"],
                      kind: "subscription-window",
                      windows: [
                        {
                          status: input.options["rate-limit-status"],
                          resetsAtMs: now + resetMs,
                        },
                      ],
                    }
                  : null,
              errorText: input.options.message === "" ? null : input.options.message,
              visibility: input.options.visibility,
              parentThreadId:
                input.options.parent === "" ? null : input.options.parent,
              chainStartedAt:
                input.options["chain-age"] > 0 ? now - input.options["chain-age"] : null,
              now,
              random: input.options["jitter-sample"] / 1000,
            };
            const decision = decideRetry(decisionInput, policy);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  { decision, input: decisionInput, dryRun, enabled },
                  null,
                  2,
                ),
              };
            }
            const suppressed =
              decision.action === "retry" && dryRun
                ? " (suppressed by dry run)"
                : decision.action === "retry" && !enabled
                  ? " (ignored: the plugin is disabled)"
                  : "";
            const lines = [
              `action:    ${decision.action}${suppressed}`,
              `rule:      ${decision.rule}`,
              `reason:    ${decision.reason}`,
            ];
            if (decision.action === "retry") {
              lines.push(
                `wait:      ${formatDuration(decision.delayMs)}`,
                `send at:   ${formatTimestamp(decision.sendAt)}`,
                `attempts:  ${input.options.attempt + 1}/${decision.maxAttempts}`,
              );
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),

        cancel: cliCommand({
          summary: "Cancel the retry this plugin queued for a thread",
          positionals: [
            { name: "thread-id", description: "Thread whose retry to cancel", required: true },
          ],
          options: { json: JSON_OPTION },
          async run(input) {
            const threadId = input.positionals["thread-id"];
            const recorded = store.latestQueuedRetry(threadId);
            if (recorded === null) {
              throw new PluginCliError(
                `no queued retry recorded for ${threadId}`,
                {
                  code: "no_queued_retry",
                  hint: "Run `bb agent-retry status` for threads with a pending retry.",
                },
              );
            }
            const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
            const row = rows.find(
              (entry) =>
                entry.id === recorded.queuedMessageId &&
                entry.payload.kind === "retry",
            );
            if (row === undefined) {
              throw new PluginCliError(
                `retry ${recorded.queuedMessageId} is no longer queued on ${threadId}`,
                {
                  code: "retry_not_queued",
                  hint: "It may have dispatched or been removed already.",
                },
              );
            }
            await bb.sdk.threads.queuedMessages.delete({
              threadId,
              queuedMessageId: row.id,
            });
            await store.clearChain(threadId);
            return input.options.json
              ? {
                  exitCode: 0,
                  stdout: JSON.stringify({ ok: true, threadId, queuedMessageId: row.id }, null, 2),
                }
              : { exitCode: 0, stdout: `Cancelled the retry queued on ${threadId}.\n` };
          },
        }),

        retry: cliCommand({
          summary: "Retry a failed thread now, ignoring the policy's clock",
          positionals: [
            { name: "thread-id", description: "Thread whose failed turn to retry", required: true },
          ],
          options: {
            "send-at": {
              type: "duration",
              defaultUnit: "m",
              min: 0,
              description: "Dispatch after this long instead of immediately",
            },
            reason: {
              type: "string",
              default: "Manual retry (bb agent-retry retry)",
              description: "Shown verbatim on the queued row",
            },
            json: JSON_OPTION,
          },
          async run(input) {
            const threadId = input.positionals["thread-id"];
            const reason = input.options.reason;
            const sendAt =
              input.options["send-at"] === undefined
                ? null
                : Date.now() + input.options["send-at"];
            let result: Awaited<ReturnType<typeof bb.sdk.threads.retry>>;
            try {
              result = await bb.sdk.threads.retry({
                threadId,
                reason,
                ...(sendAt === null ? {} : { sendAt }),
              });
            } catch (error) {
              // Core refuses a retry for a thread that is not in `error`, or
              // when another retry for the same turn is already waiting. Both
              // are the operator's to fix, so they are usage errors with a
              // hint rather than a stack trace.
              throw new PluginCliError(
                error instanceof Error ? error.message : String(error),
                {
                  code: "retry_refused",
                  hint:
                    "The thread must be in error with a failed turn, and it " +
                    "may already hold one queued retry. Check `bb thread show " +
                    `${threadId}", and \`bb agent-retry status\`.`,
                },
              );
            }
            // A queued manual retry is an ordinary pending retry, so record it:
            // `status` should list it and `cancel` should be able to drop it.
            if (result.delivery === "queued") {
              const thread = await readThread(bb, threadId);
              store.record({
                at: Date.now(),
                threadId,
                projectId: thread?.projectId ?? null,
                providerId: thread?.providerId ?? null,
                requestId: result.turnRequestId,
                attempt: Math.max(1, result.attempt - 1),
                action: "retry",
                reason,
                rule: "manual",
                category: null,
                providerCode: null,
                httpStatus: null,
                inputAccepted: true,
                errorText: null,
                delayMs: sendAt === null ? 0 : sendAt - Date.now(),
                sendAt: result.sendAt ?? sendAt,
                queuedMessageId: result.queuedMessageId,
              });
            }
            return input.options.json
              ? { exitCode: 0, stdout: JSON.stringify(result, null, 2) }
              : {
                  exitCode: 0,
                  stdout: `${result.delivery === "queued" ? "Queued" : "Sent"} retry on ${threadId} (attempt ${result.attempt}).\n`,
                };
          },
        }),
      },
    }),
  );
}

/** Regexes and other non-JSON values need a readable projection. */
function serialisePolicy(policy: RetryPolicy): unknown {
  return {
    ...policy,
    scope: {
      ...policy.scope,
      threadPatterns: policy.scope.threadPatterns.map(
        (pattern) => pattern.source,
      ),
    },
    messageRules: policy.messageRules.map((rule) => ({
      ...rule,
      pattern: rule.source,
    })),
  };
}

/** Best-effort thread facts for a decision this command records by hand. */
async function readThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<{ projectId: string; providerId: string } | null> {
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    return { projectId: thread.projectId, providerId: thread.providerId };
  } catch {
    return null;
  }
}

interface PendingRetry {
  threadId: string;
  attempt: number;
  sendAt: number | null;
  reason: string;
}

/**
 * Threads that still hold a retry this plugin queued. The plugin database
 * knows which rows it wrote; the thread's own queue is the authority on
 * whether they are still there.
 */
async function listPendingRetries(
  bb: BbPluginApi,
  store: Store,
): Promise<PendingRetry[]> {
  const recent = store.list({ action: "retry", limit: 200 });
  const seen = new Set<string>();
  const pending: PendingRetry[] = [];
  for (const row of recent) {
    if (seen.has(row.threadId)) continue;
    seen.add(row.threadId);
    if (seen.size > 20) break;
    const recorded = store.latestQueuedRetry(row.threadId);
    if (recorded?.queuedMessageId == null) continue;
    try {
      const rows = await bb.sdk.threads.queuedMessages.list({
        threadId: row.threadId,
      });
      const stillQueued = rows.some(
        (entry) =>
          entry.id === recorded.queuedMessageId && entry.payload.kind === "retry",
      );
      if (!stillQueued) continue;
      pending.push({
        threadId: row.threadId,
        attempt: recorded.attempt,
        sendAt: recorded.sendAt,
        reason: recorded.reason,
      });
    } catch {
      // A thread we cannot read is not a pending retry.
    }
  }
  return pending;
}
