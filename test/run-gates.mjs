#!/usr/bin/env node
// Gate runner for the checks whose own output is not a stable marker.
//
// Each entry maps a gate id to the command that decides it and the marker that
// means "every assertion in it passed". The marker is printed only after the
// command exits zero, so a failed or truncated run cannot print one.
//
//   node test/run-gates.mjs G1
//   node test/run-gates.mjs G1 -- test/cli.test.ts   # extra args, for a negative control
import { spawnSync } from "node:child_process";

const GATES = {
  G1: {
    marker: "policy scenarios passed",
    command: ["npx", "vitest", "run", "test/policy.test.ts"],
  },
  G2: {
    marker: "config scenarios passed",
    command: ["npx", "vitest", "run", "test/config.test.ts"],
  },
  G3: {
    marker: "plugin scenarios passed",
    command: ["npx", "vitest", "run", "test/plugin.test.ts"],
  },
  G4: {
    marker: "cli scenarios passed",
    command: ["npx", "vitest", "run", "test/cli.test.ts"],
  },
  G5: {
    marker: "hygiene scenarios passed",
    command: ["npx", "vitest", "run", "test/hygiene.test.ts"],
  },
  G6: { marker: "type surface compiles", command: ["npx", "tsc", "--noEmit"] },
  G7: { marker: "server artifact built", command: ["bb", "plugin", "build"] },
};

const [gate, ...rest] = process.argv.slice(2);
const entry = GATES[gate];
if (entry === undefined) {
  process.stderr.write(
    `unknown gate ${gate ?? "(none)"}; expected one of ${Object.keys(GATES).join(", ")}\n`,
  );
  process.exit(2);
}

// Everything after `--` is appended, which is how a negative control points a
// gate at a command that must fail. Bare arguments are refused: a stray
// `--help` would otherwise be forwarded and exit zero, printing a marker for a
// check that never ran.
if (rest.length > 0 && rest[0] !== "--") {
  process.stderr.write(
    `unexpected argument ${rest[0]}; pass extra command arguments after --\n`,
  );
  process.exit(2);
}
const extra = rest.length === 0 ? [] : rest.slice(1);
const result = spawnSync(entry.command[0], [...entry.command.slice(1), ...extra], {
  cwd: process.cwd(),
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`${entry.command[0]} could not run: ${result.error.message}\n`);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(`gate ${gate} failed (exit ${result.status})\n`);
  process.exit(result.status ?? 1);
}
process.stdout.write(`${entry.marker}\n`);
