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

- [ ] G1: the policy engine decides every failure shape the plugin claims to cover
  CHECK: node test/run-gates.mjs G1
  EXPECT: policy scenarios passed
  EVIDENCE: pending

- [ ] G2: both configuration layers parse, validate, merge, and reject what they must
  CHECK: node test/run-gates.mjs G2
  EXPECT: config scenarios passed
  EVIDENCE: pending

- [ ] G3: a real turn.failed payload drives a real decision, a real queue row, and a real database row
  CHECK: node test/run-gates.mjs G3
  EXPECT: plugin scenarios passed
  EVIDENCE: pending

- [ ] G4: every CLI command answers, filters, and fails the way an operator or agent needs
  CHECK: node test/run-gates.mjs G4
  EXPECT: cli scenarios passed
  EVIDENCE: pending

- [ ] G5: the package imports nothing outside the public SDK, ships no private data, and its documents obey the marketplace's content rules
  CHECK: node test/run-gates.mjs G5
  EXPECT: hygiene scenarios passed
  EVIDENCE: pending

- [ ] G6: the type surface compiles with strict checking on
  CHECK: node test/run-gates.mjs G6
  EXPECT: type surface compiles
  EVIDENCE: pending

- [ ] G7: the plugin builds into a loadable server artifact
  CHECK: node test/run-gates.mjs G7
  EXPECT: server artifact built
  EVIDENCE: pending

- [ ] G8: a production-only install, which is what a git install runs, still builds from the committed files alone
  CHECK: node test/git-install-check.mjs
  EXPECT: production install build passed
  EVIDENCE: pending

- [ ] G9: the derived plugin id matches the manifest name and the marketplace entry id
  CHECK: node test/derive-plugin-id.mjs package.json
  EXPECT: agent-retry
  EVIDENCE: pending

- [ ] G10: a running server retries a real failed turn, grows the wait, cancels cleanly, and leaves a fresh failure alone when disabled
  CHECK: node test/live-check.mjs
  EXPECT: live retry chain verified
  EVIDENCE: pending

- [ ] G11: the marketplace entry, icon, screenshots and overview pass the marketplace's own build and check
  CHECK: node test/marketplace-check.mjs
  EXPECT: marketplace validation passed
  EVIDENCE: pending

- [ ] G12: the released tag resolves publicly and is what a user installs
  CHECK: node test/release-check.mjs
  EXPECT: release source verified
  EVIDENCE: pending

<!--
Negative controls for the marker convention, both run and recorded:

  node test/run-gates.mjs G6 -- --definitely-not-a-tsc-flag
  → exit 1, "gate G6 failed (exit 1)", and no "type surface compiles"

  node test/run-gates.mjs G1 --help
  → exit 2, refused, so a forwarded --help cannot print a marker for a check
    that never ran

If a gate becomes impossible, keep it and add
`ABANDON: G<n> <reason>` rather than deleting it.
-->
