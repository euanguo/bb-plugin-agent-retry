#!/usr/bin/env node
// Gate G10: prove the retry chain against a running BB.
//
// Unit tests prove the decisions; only a live server proves the wiring — that
// a real `turn.failed` reaches the handler, that core accepts the queued retry,
// that the attempt counter grows, and that cancelling drops it.
//
// It creates its own hidden thread on a project it discovers, drives a
// deterministic failure, and deletes everything it made. The plugin's settings
// it touches are snapshotted and restored, so a failure here cannot leave the
// operator's policy changed.
import { spawnSync } from "node:child_process";

const PLUGIN_ID = "agent-retry";
// A model no provider catalog can resolve, so the failure is a door rejection
// with no structured error info: the case this plugin exists for.
const BOGUS_MODEL = "definitely-not-a-real-model-for-the-live-check";
const WORKSPACE = process.env.BB_LIVE_WORKSPACE ?? process.cwd();

function bb(args, options = {}) {
  const result = spawnSync("bb", args, {
    cwd: WORKSPACE,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ok: result.status === 0,
  };
}

function bbJson(args) {
  const result = bb([...args, "--json"]);
  if (!result.ok) {
    throw new Error(`bb ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Throw rather than exit: the cleanup in the `finally` below must run even
 * when a check fails, or a failed gate would leave the operator's settings
 * changed and its test thread behind.
 */
function fail(message) {
  throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs, intervalMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

const evidence = [];
let threadId = null;
let snapshot = null;
let failure = null;

try {
  // 1. The plugin has to be installed, enabled, and running.
  const installed = bbJson(["plugin", "list"]).plugins?.find(
    (entry) => entry.id === PLUGIN_ID,
  );
  if (installed === undefined) fail(`${PLUGIN_ID} is not installed`);
  if (installed.status !== "running") {
    fail(`${PLUGIN_ID} is ${installed.status}, not running`);
  }
  evidence.push(`plugin running from ${installed.source}`);

  // 2. Shorten the first wait so the chain can be observed in seconds, and
  //    keep the operator's values to put back.
  const config = bbJson(["plugin", "config", PLUGIN_ID]);
  snapshot = config.values;
  if (snapshot.enabled !== true) fail("the plugin is disabled");
  bb(["plugin", "config", PLUGIN_ID, "set", "baseDelayMs", "2000"]);
  bb(["plugin", "config", PLUGIN_ID, "set", "growth", "1.5"]);
  bb(["plugin", "config", PLUGIN_ID, "set", "jitterPct", "0"]);
  bb(["plugin", "config", PLUGIN_ID, "set", "maxAttempts", "6"]);
  bb(["plugin", "config", PLUGIN_ID, "set", "maxDelayMs", "10000"]);
  evidence.push("shortened the backoff for the duration of the check");

  // 3. A project to run on. A hidden thread keeps this out of the sidebar.
  const projects = bbJson(["project", "list"]);
  const list = Array.isArray(projects) ? projects : (projects.projects ?? []);
  if (list.length === 0) fail("no project to run the check on");
  const preferred =
    process.env.BB_LIVE_PROJECT ?? process.env.BB_PROJECT_ID ?? null;
  const projectId =
    preferred !== null && list.some((project) => project.id === preferred)
      ? preferred
      : list[0].id;

  const created = bbJson([
    "thread",
    "spawn",
    "--project",
    projectId,
    "--prompt",
    "Reply with the single word: ok",
    "--provider",
    "pi",
    "--model",
    BOGUS_MODEL,
    "--title",
    "agent-retry live check",
    "--visibility",
    "hidden",
  ]);
  threadId = created.id;
  if (typeof threadId !== "string") fail("spawn returned no thread id");
  evidence.push(`spawned hidden thread ${threadId}`);

  // 4. The failure reaches the plugin, which queues the next attempt.
  const decision = await waitFor(
    "a retry decision for the new thread",
    () => {
      const rows = bbJson(["agent-retry", "log", "--limit", "200"]).decisions;
      return rows.find((row) => row.threadId === threadId && row.action === "retry");
    },
    90_000,
  );
  if (decision.rule !== "defaults") {
    fail(`expected the default rule, got ${decision.rule}`);
  }
  if (typeof decision.queuedMessageId !== "string") {
    fail("the decision recorded no queued message id");
  }
  evidence.push(
    `queued attempt ${decision.attempt + 1} for ${threadId} via [${decision.rule}]: ${decision.reason}`,
  );

  // 5. Core really holds the row, and the plugin reports it as pending.
  const queued = bbJson(["thread", "queue", "list", threadId]);
  const rows = Array.isArray(queued) ? queued : (queued.queuedMessages ?? []);
  if (!rows.some((row) => row.id === decision.queuedMessageId)) {
    fail("core's queue does not hold the retry the plugin recorded");
  }
  const pending = bbJson(["agent-retry", "status"]).pending;
  if (!pending.some((entry) => entry.threadId === threadId)) {
    fail("status does not list the pending retry");
  }
  evidence.push("core holds the row and status lists it as pending");

  // 6. The chain advances: the retry fails the same way and the counter grows.
  const grown = await waitFor(
    "a later attempt on the same thread",
    () => {
      const all = bbJson(["agent-retry", "log", "--limit", "200"]).decisions;
      const mine = all.filter(
        (row) => row.threadId === threadId && row.action === "retry",
      );
      return mine.length >= 3 ? mine[0] : undefined;
    },
    120_000,
  );
  if (grown.attempt < 3) fail(`expected at least attempt 3, saw ${grown.attempt}`);
  evidence.push(
    `chain grew to attempt ${grown.attempt + 1} (${grown.reason}), waits: ${bbJson([
      "agent-retry",
      "log",
      "--limit",
      "200",
    ])
      .decisions.filter((row) => row.threadId === threadId)
      .map((row) => `${row.attempt}->${Math.round(row.delayMs / 1000)}s`)
      .reverse()
      .join(", ")}`,
  );

  // 7. Cancelling drops it, and nothing is left pending.
  let cancelled = false;
  for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
    const result = bb(["agent-retry", "cancel", threadId]);
    cancelled = result.ok;
    if (!cancelled) await sleep(3_000);
  }
  if (!cancelled) fail("could not cancel the queued retry");
  const after = bbJson(["agent-retry", "status"]).pending;
  if (after.some((entry) => entry.threadId === threadId)) {
    fail("status still lists the cancelled retry");
  }
  evidence.push("cancelled the queued retry; nothing is pending");

  // 8. The master switch. Re-dispatch the same failing turn with the plugin
  //    disabled: the failure must leave no decision and no queue row behind.
  const decisionsFor = () =>
    bbJson(["agent-retry", "log", "--limit", "200"]).decisions.filter(
      (row) => row.threadId === threadId,
    );

  // A failure lands as `provider/error` when it happens inside a turn and as
  // `system/error` when the provider refused the request at the door. This
  // check drives the second kind, and neither shape produces `turn/completed`.
  const failureEvents = () => {
    const events = bbJson(["thread", "log", threadId, "--all"]);
    return (Array.isArray(events) ? events : []).filter(
      (event) => event.type === "provider/error" || event.type === "system/error",
    ).length;
  };

  const decisionsBefore = decisionsFor().length;
  const failuresBefore = failureEvents();
  bb(["plugin", "config", PLUGIN_ID, "set", "enabled", "false"]);
  const redispatched = bb(["thread", "retry", threadId]);
  if (!redispatched.ok) {
    fail(`could not re-dispatch the failed turn: ${redispatched.stderr}`);
  }
  await waitFor(
    "the re-dispatched turn to fail",
    () => failureEvents() > failuresBefore,
    90_000,
  );
  if (decisionsFor().length !== decisionsBefore) {
    fail("a decision was recorded while the plugin was disabled");
  }
  const stillQueued = bbJson(["thread", "queue", "list", threadId]);
  const queuedRows = Array.isArray(stillQueued)
    ? stillQueued
    : (stillQueued.queuedMessages ?? []);
  if (queuedRows.length > 0) fail("a retry was queued while the plugin was disabled");
  evidence.push("the master switch left a fresh failure completely alone");

} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  if (threadId !== null) {
    bb(["thread", "delete", threadId, "--yes"]);
  }
  if (snapshot !== null) {
    for (const [key, value] of Object.entries(snapshot)) {
      bb([
        "plugin",
        "config",
        PLUGIN_ID,
        "set",
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]);
    }
  }
}

if (failure !== null) {
  process.stderr.write(`live check failed: ${failure.message}\n`);
  process.exit(1);
}
for (const line of evidence) process.stdout.write(`  - ${line}\n`);
process.stdout.write("live retry chain verified\n");
