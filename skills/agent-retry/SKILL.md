---
name: agent-retry
description: "Retry a failed BB turn on a configurable backoff, for any provider failure — including ones with no structured error info. Use when a thread landed in error and you want another attempt, when tuning the retry policy, or when diagnosing why a failure was not retried."
---

# Agent Retry

Queues another attempt for a turn that failed, after a growing wait. It
listens to core's `turn.failed` event, which fires for **every** failed turn —
including failures that carry no structured error info at all, which is the
case BB's built-in `provider-retry` plugin declines.

## When to use it

- A thread is in `error` and the user wants it to keep trying by itself.
- A failure was **not** retried and you need to know why.
- The retry policy needs tuning (attempts, backoff shape, scope).

## Commands

```bash
bb agent-retry status                  # effective policy, last 24h, pending retries
bb agent-retry status --json
bb agent-retry log --limit 30          # decision history: retry / skip / dry-run / error
bb agent-retry log --thread thr_abc --action skip
bb agent-retry explain                 # fully resolved policy + the waits it would use
bb agent-retry simulate --category none --message "service unavailable"
bb agent-retry simulate --category rate-limit --rate-limit-reset 30m --attempt 4
bb agent-retry cancel thr_abc          # drop the retry this plugin queued
bb agent-retry retry thr_abc           # retry now, ignoring the backoff
bb agent-retry retry thr_abc --send-at 10m
```

`simulate` is the tuning tool: it replays a failure shape and prints the
decision, the rule that made it, and the resulting wait — no need to wait for a
real failure.

## Configuration

Settings → Installed plugins → Agent Retry, or `bb plugin config agent-retry`.
Every decision records the rule that made it, so `bb agent-retry log` always
explains an outcome.

Defaults: **50 attempts**, exponential backoff `30s × 1.6ⁿ` capped at 15
minutes, 15% jitter. That is roughly 11 hours of retrying before the cap, and
`maxTotalSpanMs` can bound it sooner.

The flat settings are the base policy. `advancedJson` overrides them:

```json
{
  "defaults": { "maxAttempts": 50, "baseDelayMs": 30000, "growth": 1.6 },
  "categoryRules": {
    "overloaded": { "baseDelayMs": 5000, "growth": 2, "maxDelayMs": 120000 },
    "billing": { "action": "skip" },
    "*": { "action": "retry", "maxAttempts": 20 }
  },
  "messageRules": [
    { "pattern": "temporarily unavailable", "flags": "i", "action": "retry", "maxAttempts": 50 },
    { "pattern": "invalid api key", "flags": "i", "action": "skip", "reason": "key is wrong" }
  ],
  "scope": { "providers": ["pi"], "excludeProjects": ["proj_noisy"] }
}
```

Resolution order for one failure: **message rules → category rule (specific,
then `*`) → flat settings**. A matching rule supplies only the fields it names;
everything else falls through. `advancedJson` wins over the flat settings
wherever both speak.

The default skip list (`billing`, `budget-exceeded`, `unauthorized`, `policy`,
`bad-request`, `context-window-exceeded`, `too-many-failed-attempts`,
`active-turn-not-steerable`) exists because those fail identically on every
attempt. An explicit category rule or message rule can put any of them back in.

`dryRun` logs the decision without queueing anything — the right way to try a
new policy.

## Operating constraints

- **Retries re-run a turn, they do not replay a request.** When the provider
  had already accepted the input, core continues the same conversation with an
  agent-only `Please continue.`; only a request the provider never took is
  re-sent verbatim. Model, reasoning level, and permission mode are preserved.
- **One live retry per turn.** Core refuses a second queued retry for the same
  original request (`retry_already_queued`), so this plugin cannot stack with
  another retrier. Disable the built-in `provider-retry` plugin when this one
  is enabled, or the two will race and one will lose the race noisily.
- **User-cancelled turns are never retried.** `interrupted` turns settle as
  `stop.settled`, not `turn.failed`.
- **Pi's own retry still runs first.** Pi retries its hard-coded set of
  transient messages inside the turn; this plugin only sees what Pi gave up on.
  The two attempt counters are independent.
- **A chain is per thread.** It starts at the first failure, survives a plugin
  reload (it lives in kv), and is cleared when the thread goes idle, is
  archived or deleted, or the queued retry is cancelled.
- `bb agent-retry retry` bypasses the policy entirely — it is the manual
  escape hatch, not a way to force a policy decision.
