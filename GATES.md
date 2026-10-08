# Gates: Agent Retry

OWNS: policy.ts, config.ts, store.ts, cli.ts, server.ts, test/**, GATES.md, README.md, PLUGIN_OVERVIEW.md, package.json

Scope: prove that Agent Retry decides and retries correctly across the whole
failure space it claims to cover — every error category, both configuration
layers, every scope filter, both backoff floors, the whole CLI surface, and the
failure paths where core or the database misbehaves — then ship the verified
commit to the Community marketplace.

Every gate is runnable. A gate is met only when its process exits zero and its
`EXPECT:` marker appears; each marker is printed after every assertion in the
check has passed, never before.

- [x] G1: the policy engine decides every failure shape the plugin claims to cover
  CHECK: node test/run-gates.mjs G1
  EXPECT: policy scenarios passed
  EVIDENCE: exit 0, `Tests 69 passed (69)`. Covers the unclassified gateway failure that motivated the plugin (no `errorInfo`, error text present), every structured category, the default skip list, both floors (rate-limit reset and backoff), the boundaries of `maxWaitMs` (equal retries, one millisecond over declines) and `maxTotalSpanMs` (equal declines, one millisecond under retries), rate-limit windows with no reset, no windows, several blocked windows, and a non-blocked one, scope at its edges (a null project or provider against an allowlist versus a denylist), rule precedence (message beats category beats `*` beats defaults), and attempt counters of 0, −5, 0.4, 2.9, NaN, and 51. Two defects were found here and fixed: a non-finite counter produced the longest wait instead of the first step, and `"*"` was documented as a baseline when the code treats it as a selector — the documented semantics are now pinned by a test.

- [x] G2: both configuration layers parse, validate, merge, and reject what they must
  CHECK: node test/run-gates.mjs G2
  EXPECT: config scenarios passed
  EVIDENCE: exit 0, `Tests 32 passed (32)`. Runs through the real settings descriptors and the fake host's real settings save, so a schema that stops rejecting bad input fails here. Rejections proven: malformed JSON, an unknown top-level key, an unknown field inside a rule (which is what proves `zod`'s `.extend()` kept the object strict), a wrong type, an invalid regex, an invalid flag, and six out-of-range numbers. Merging proven: `advancedJson` overrides only the fields it names, category keys are lowercased, `"*"` survives, a non-empty advanced scope list replaces the flat one field by field while an empty one is treated as silent, and a stored value that predates the schema falls back to the flat layer and reports a problem instead of being ignored.

- [x] G3: a real turn.failed payload drives a real decision, a real queue row, and a real database row
  CHECK: node test/run-gates.mjs G3
  EXPECT: plugin scenarios passed
  EVIDENCE: exit 0, `Tests 36 passed (36)`. Real `turn.failed` events through the SDK's fake host against a real better-sqlite3 database and real kv. Covers a queued retry, a declined category, the attempt cap, dry run, scope, a door rejection read from `system/error` so message rules can match it, the chain span clock surviving attempts and a reload, the chain clearing on idle, archive, delete, and a cancellation of this plugin's own row — and deliberately not on another retrier's row, which was a real defect: it had been handing the next failure a fresh budget. Also covers the degraded paths: a thread that cannot be read, error text that cannot be read, a decision log that cannot be written (the retry is still queued), a core refusal recorded as an error rather than thrown, an immediate `sent` retry with nothing pending, a rate-limit floor, two threads' chains staying apart, a settings change applying without a reload, the master switch recording nothing at all, `logDecisions: false` deciding without recording, a reload re-running its migrations and appending to the same table, and the daily sweep keeping a live chain while dropping an abandoned one.

- [x] G4: every CLI command answers, filters, and fails the way an operator or agent needs
  CHECK: node test/run-gates.mjs G4
  EXPECT: cli scenarios passed
  EVIDENCE: exit 0, `Tests 30 passed (30)`. Every command in both its human and `--json` form: `status` (policy, 24-hour counts, pending retries, the master switch, and a configuration problem), `log` (filters by thread, action, and limit; newest first; a wait rendered from the decision), `explain` (the resolved policy, the waits it would use, regexes serialised rather than thrown at), `simulate` (each category, a rate-limit reset, a chain age, scope inputs, both halves of the input-accepted space, jitter at three samples, message rules, and the dry-run and disabled notes), `cancel` (three failure paths), and `retry` (immediate, scheduled and recorded, and a core refusal as a usage error with a hint). Parser behaviour: `--help` at two levels exits 0, an unknown command or option exits 2, a missing positional is reported, an out-of-range value is rejected, and a failure with `--json` emits the error envelope.

- [x] G5: the package imports nothing outside the public SDK, ships no private data, and its documents obey the marketplace's content rules
  CHECK: node test/run-gates.mjs G5
  EXPECT: hygiene scenarios passed
  EVIDENCE: exit 0, `Tests 10 passed (10)`. The public-SDK scan reports no violations and no private `@bb/*` dependency across twelve source and test files. The manifest is checked against what the marketplace will derive: the plugin id, a hook of 121 characters with no banned adjective and one sentence, a declared icon, a server entry, engine ranges, MIT, the repository URL, and `zod` as the only runtime dependency. The overview is inside 4000 characters, has no `#` title, no raw HTML, tables, images, footnotes or task lists, and every link is absolute https; the skill documents all six commands and the advanced layer. A privacy scan of every committed source, JSON and Markdown file finds no home directory path, no token, and no email address — which is what caught a local skill path in this ledger and a self-matching pattern in the scanner itself.

- [x] G6: the type surface compiles with strict checking on
  CHECK: node test/run-gates.mjs G6
  EXPECT: type surface compiles
  EVIDENCE: exit 0, no output. `strict` on, `skipLibCheck` off.

- [x] G7: the plugin builds into a loadable server artifact
  CHECK: node test/run-gates.mjs G7
  EXPECT: server artifact built
  EVIDENCE: exit 0. `dist/server.js`, `dist/server.js.map` and `dist/server.meta.json`, declaring `pluginId: agent-retry`, `sdkVersion: 0.6.23`, `artifactFormatVersion: 1`.

- [x] G8: a production-only install, which is what a git install runs, still builds from the committed files alone
  CHECK: node test/git-install-check.mjs
  EXPECT: production install build passed
  EVIDENCE: exit 0, `production install build passed (1 runtime dependency: zod)`. `git archive HEAD` hands over only committed files, so this also proves nothing the build needs was left uncommitted and that `node_modules` is not tracked. The install is `npm install --omit=dev --omit=optional`, the git install's own step; the build then produces a bundle whose `pluginId` is checked and which `node --check` parses.

- [x] G9: the derived plugin id matches the manifest name and the marketplace entry id
  CHECK: node test/derive-plugin-id.mjs package.json
  EXPECT: agent-retry
  EVIDENCE: exit 0, `agent-retry`. The derivation is vendored in the repository, so the gate runs from a clone alone; it mirrors the marketplace's `scripts/derive-plugin-id.mjs`, and `test/hygiene.test.ts` asserts the same value in-process. The marketplace entry's id, its filename, and the manifest all agree.

- [x] G10: a running server retries a real failed turn, grows the wait, cancels cleanly, and leaves a fresh failure alone when disabled
  CHECK: node test/live-check.mjs
  EXPECT: live retry chain verified
  EVIDENCE: exit 0. Against a live bb: a hidden thread is spawned on the current project with a model no catalog can resolve, so it fails at the door with no structured error info — the exact case this plugin exists for. The plugin queues attempt 2 via `[defaults]`, core holds the row in `bb thread queue list`, and `status` lists it as pending. The chain then grows to attempt 4 with growing waits (`1->2s, 2->3s, 3->5s`), proving the counter and the backoff survive each round trip through core. `cancel` drops it and nothing is left pending. Finally the master switch is turned off and the same turn is re-dispatched: it fails again, and the plugin records no decision and queues nothing. The check snapshots and restores every setting and deletes its thread even when it fails — which it did not at first: `process.exit` skipped the cleanup `finally` and left the operator's policy changed, so `fail()` now throws and the cleanup always runs.

- [x] G11: the marketplace entry, icon, screenshots and overview pass the marketplace's own build and check
  CHECK: node test/marketplace-check.mjs
  EXPECT: marketplace validation passed
  EVIDENCE: exit 0, `marketplace validation passed (entry, icon RotateCcw, 3 screenshot(s), 2377-char overview)`. Run against a clone of the marketplace on the submission branch. `npm ci --ignore-scripts`, `npm run build` and `npm run check` all pass (342 entries). The check also proves: the entry id matches its filename and the derived plugin id; the category is one id from `marketplace.base.json`; `author.github` is the submitting account; the host icon name exists in bb's own icon registry rather than being invented; every screenshot is referenced, present, at least 1200 px wide and under 2 MiB, with no unreferenced file in the directory; and the overview is at the documented path, referenced, and inside 4000 characters. The entry is committed before the build runs, because the build derives `publishedAt` from the file's first addition date. Pull request: https://github.com/get-bb/marketplace/pull/510

- [x] G12: the released tag resolves publicly and is what a user installs
  CHECK: node test/release-check.mjs
  EXPECT: release source verified
  EVIDENCE: exit 0. The check derives the expected tag from the manifest version, so it
  verifies whichever release this commit is tagged as rather than one hard-coded run:
  the tag exists on the remote and points at the release commit rather than somewhere
  else, the repository is public, a fresh clone of the tag carries the same version and
  every entry point, and the highest release equals the manifest version, so the range a
  marketplace entry names resolves to it. First passed for `v0.2.0 = 78d4dad`; re-run and
  passing for every release since.

<!--
Negative controls for the marker convention, both run and recorded:

  node test/run-gates.mjs G6 -- --definitely-not-a-tsc-flag
  → exit 1, "gate G6 failed (exit 1)" on stderr, and no "type surface compiles"
    on stdout (checked: zero occurrences). A check that fails cannot print its
    marker.

  node test/run-gates.mjs G1 --help
  → exit 2, refused before running anything, so a forwarded `--help` cannot
    exit zero and print a marker for a check that never ran. An earlier control
    using a nonexistent vitest path was invalid and was replaced: vitest reads
    extra positionals as filters, so it exited 0 with the real file still run.

If a gate becomes impossible, keep it and add
`ABANDON: G<n> <reason>` rather than deleting it.
-->
