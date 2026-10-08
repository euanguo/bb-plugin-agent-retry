// agent-retry — durable state.
//
// Two stores, for two lifetimes:
//
//   * The decision log lives in the plugin's SQLite database. It is
//     append-only history, read by `bb agent-retry log` and `status`.
//   * The retry-chain state lives in kv, one row per thread. It exists only
//     while a chain is in flight, and it is what lets `maxTotalSpanMs` and the
//     "which attempt is this" question survive a plugin reload.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type DecisionAction = "retry" | "skip" | "dry-run" | "error";

export interface DecisionRecord {
  at: number;
  threadId: string;
  projectId: string | null;
  providerId: string | null;
  requestId: string;
  attempt: number;
  action: DecisionAction;
  reason: string;
  rule: string;
  category: string | null;
  providerCode: string | null;
  httpStatus: number | null;
  inputAccepted: boolean;
  errorText: string | null;
  delayMs: number | null;
  sendAt: number | null;
  queuedMessageId: string | null;
}

export interface DecisionRow extends DecisionRecord {
  id: number;
}

export interface DecisionCounts {
  retry: number;
  skip: number;
  "dry-run": number;
  error: number;
}

export interface ChainState {
  /** The original request of the chain, which every attempt re-submits. */
  originalRequestId: string;
  /** When the chain's first failure was seen. */
  startedAt: number;
  /** The highest attempt number seen so far. */
  attempts: number;
  updatedAt: number;
}

const CHAIN_PREFIX = "chain:";

export function chainKey(threadId: string): string {
  return `${CHAIN_PREFIX}${threadId}`;
}

interface RawDecisionRow {
  id: number;
  at: number;
  thread_id: string;
  project_id: string | null;
  provider_id: string | null;
  request_id: string;
  attempt: number;
  action: string;
  reason: string;
  rule: string;
  category: string | null;
  provider_code: string | null;
  http_status: number | null;
  input_accepted: number;
  error_text: string | null;
  delay_ms: number | null;
  send_at: number | null;
  queued_message_id: string | null;
}

function toRow(raw: RawDecisionRow): DecisionRow {
  return {
    id: raw.id,
    at: raw.at,
    threadId: raw.thread_id,
    projectId: raw.project_id,
    providerId: raw.provider_id,
    requestId: raw.request_id,
    attempt: raw.attempt,
    action: raw.action as DecisionAction,
    reason: raw.reason,
    rule: raw.rule,
    category: raw.category,
    providerCode: raw.provider_code,
    httpStatus: raw.http_status,
    inputAccepted: raw.input_accepted === 1,
    errorText: raw.error_text,
    delayMs: raw.delay_ms,
    sendAt: raw.send_at,
    queuedMessageId: raw.queued_message_id,
  };
}

export interface ListDecisionsOptions {
  limit?: number;
  threadId?: string;
  action?: DecisionAction;
}

export interface Store {
  record(decision: DecisionRecord): void;
  list(options?: ListDecisionsOptions): DecisionRow[];
  countsSince(since: number): DecisionCounts;
  /** The newest queued retry this plugin asked for on a thread, if any. */
  latestQueuedRetry(threadId: string): DecisionRow | null;
  readChain(threadId: string): Promise<ChainState | null>;
  writeChain(threadId: string, state: ChainState): Promise<void>;
  clearChain(threadId: string): Promise<void>;
  /** Drop chain state for threads that stopped failing long ago. */
  sweepChains(maxAgeMs: number, now: number): Promise<number>;
  /** Keep the decision log bounded. Returns how many rows were dropped. */
  pruneDecisions(maxRows: number): number;
}

/**
 * Rows kept in the decision log. It is a debugging aid, not a ledger: the
 * plugin log and the thread's own history are the durable record, and an
 * unbounded table in a plugin database is a leak that only shows up months in.
 */
export const MAX_DECISION_ROWS = 5_000;

/**
 * Open the plugin's own database and its kv-backed chain state. Statement
 * order is the migration id, so it is append-only: add new statements, never
 * edit a shipped one.
 */
export function openStore(bb: BbPluginApi): Store {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS retry_decisions (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       at INTEGER NOT NULL,
       thread_id TEXT NOT NULL,
       project_id TEXT,
       provider_id TEXT,
       request_id TEXT NOT NULL,
       attempt INTEGER NOT NULL,
       action TEXT NOT NULL,
       reason TEXT NOT NULL,
       rule TEXT NOT NULL,
       category TEXT,
       provider_code TEXT,
       http_status INTEGER,
       input_accepted INTEGER NOT NULL,
       error_text TEXT,
       delay_ms INTEGER,
       send_at INTEGER,
       queued_message_id TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS retry_decisions_thread
       ON retry_decisions (thread_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS retry_decisions_at
       ON retry_decisions (at DESC)`,
  ]);

  const insert = db.prepare(
    `INSERT INTO retry_decisions (
       at, thread_id, project_id, provider_id, request_id, attempt, action,
       reason, rule, category, provider_code, http_status, input_accepted,
       error_text, delay_ms, send_at, queued_message_id
     ) VALUES (
       @at, @threadId, @projectId, @providerId, @requestId, @attempt, @action,
       @reason, @rule, @category, @providerCode, @httpStatus, @inputAccepted,
       @errorText, @delayMs, @sendAt, @queuedMessageId
     )`,
  );
  const prune = db.prepare(
    `DELETE FROM retry_decisions WHERE id <= (
       SELECT MAX(id) FROM retry_decisions
     ) - @maxRows`,
  );
  return {
    record(decision) {
      insert.run({
        at: decision.at,
        threadId: decision.threadId,
        projectId: decision.projectId,
        providerId: decision.providerId,
        requestId: decision.requestId,
        attempt: decision.attempt,
        action: decision.action,
        reason: decision.reason,
        rule: decision.rule,
        category: decision.category,
        providerCode: decision.providerCode,
        httpStatus: decision.httpStatus,
        inputAccepted: decision.inputAccepted ? 1 : 0,
        errorText: decision.errorText,
        delayMs: decision.delayMs,
        sendAt: decision.sendAt,
        queuedMessageId: decision.queuedMessageId,
      });
      // Cheap on every insert and exact: `MAX(id)` on an integer primary key
      // is O(1), and the delete finds nothing to do until the log is over the
      // cap. Bounding it here means no install can grow an unbounded table.
      prune.run({ maxRows: MAX_DECISION_ROWS });
    },

    list(options = {}) {
      const limit = Math.max(1, Math.min(options.limit ?? 50, 1000));
      const clauses: string[] = [];
      const params: Record<string, string | number> = { limit };
      if (options.threadId !== undefined) {
        clauses.push("thread_id = @threadId");
        params.threadId = options.threadId;
      }
      if (options.action !== undefined) {
        clauses.push("action = @action");
        params.action = options.action;
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM retry_decisions ${where} ORDER BY id DESC LIMIT @limit`,
        )
        .all(params) as RawDecisionRow[];
      return rows.map(toRow);
    },

    countsSince(since) {
      const rows = db
        .prepare(
          `SELECT action, COUNT(*) AS count FROM retry_decisions
           WHERE at >= @since GROUP BY action`,
        )
        .all({ since }) as { action: string; count: number }[];
      const counts: DecisionCounts = { retry: 0, skip: 0, "dry-run": 0, error: 0 };
      for (const row of rows) {
        if (row.action in counts) {
          counts[row.action as DecisionAction] = row.count;
        }
      }
      return counts;
    },

    latestQueuedRetry(threadId) {
      const row = db
        .prepare(
          `SELECT * FROM retry_decisions
           WHERE thread_id = @threadId AND action = 'retry'
             AND queued_message_id IS NOT NULL
           ORDER BY id DESC LIMIT 1`,
        )
        .get({ threadId }) as RawDecisionRow | undefined;
      return row === undefined ? null : toRow(row);
    },

    async readChain(threadId) {
      const state = await bb.storage.kv.get<ChainState>(chainKey(threadId));
      if (
        state === null ||
        typeof state !== "object" ||
        typeof state.startedAt !== "number"
      ) {
        return null;
      }
      return state;
    },

    async writeChain(threadId, state) {
      await bb.storage.kv.set(chainKey(threadId), state);
    },

    async clearChain(threadId) {
      await bb.storage.kv.delete(chainKey(threadId));
    },

    async sweepChains(maxAgeMs, now) {
      const keys = await bb.storage.kv.list(CHAIN_PREFIX);
      let removed = 0;
      for (const key of keys) {
        const state = await bb.storage.kv.get<ChainState>(key);
        const updatedAt =
          state !== null && typeof state === "object" ? state.updatedAt : undefined;
        // A key we cannot read is unusable, so it goes too. This is the only
        // thing that clears a chain the plugin was unloaded for — a thread
        // that went idle, was archived, or was deleted while it was disabled.
        if (typeof updatedAt !== "number" || now - updatedAt > maxAgeMs) {
          await bb.storage.kv.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    pruneDecisions(maxRows) {
      const before = db
        .prepare(`SELECT COUNT(*) AS count FROM retry_decisions`)
        .get() as { count: number };
      prune.run({ maxRows });
      const after = db
        .prepare(`SELECT COUNT(*) AS count FROM retry_decisions`)
        .get() as { count: number };
      return before.count - after.count;
    },
  };
}
