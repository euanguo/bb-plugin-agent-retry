# bb-plugin-agent-retry

Retries a failed BB turn on a configurable, growing backoff — for **any**
failure a provider reports, including ones that carry no structured error info.

## Why

BB already has two retry layers, and neither covers a long backoff over
arbitrary failures:

| | Pi's built-in retry | built-in `provider-retry` | this plugin |
|---|---|---|---|
| Attempts | configurable | hard-coded 5 | configurable (default 50) |
| Backoff | exponential, capped at 60s by default | `5s × 2ⁿ`, overloaded only | exponential / linear / fixed, configurable base, growth, cap, jitter |
| Which failures | a hard-coded list of provider messages | `overloaded` + resettable subscription-window rate limits | everything except an explicit skip list — **including failures with no error info** |
| Scope | every thread | every thread | per project, provider, thread, visibility |
| Survives restart | no (in-process) | yes | yes |

Pi's retryable-error list lives in `@earendil-works/pi-ai` and cannot be
extended by configuration. Core's `turn.failed` event, by contrast, fires for
every failed turn and carries a durable attempt counter — which is what a long
backoff needs.

## Install

```bash
cd ~/bb-plugin-src/bb-plugin-agent-retry
npm install
bb plugin build
bb plugin install . --yes
bb plugin disable provider-retry   # otherwise the two retriers race
```

## Use

```bash
bb agent-retry status             # effective policy, recent activity, pending retries
bb agent-retry log                # decision history
bb agent-retry explain            # resolved policy + the waits it would use
bb agent-retry simulate --category none --message "service unavailable"
bb agent-retry cancel <thread-id> # drop the queued retry
bb agent-retry retry <thread-id>  # retry now
```

Configuration lives in Settings → Installed plugins → Agent Retry, or
`bb plugin config agent-retry`. See `skills/agent-retry/SKILL.md` for the full
settings reference and the `advancedJson` override format.

## Layout

| file | role |
|---|---|
| `policy.ts` | pure decision engine — no BB imports, no clock, fully unit-tested |
| `config.ts` | the two config layers and how they merge |
| `store.ts` | the SQLite decision log and the kv retry-chain state |
| `cli.ts` | `bb agent-retry` |
| `server.ts` | the factory: wires the event handlers, does the I/O |

## Develop

```bash
npm test        # 39 unit + fake-host integration tests
npm run typecheck
bb plugin dev   # rebuild and reload on save
```
