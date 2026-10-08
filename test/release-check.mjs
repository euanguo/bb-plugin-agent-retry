#!/usr/bin/env node
// Gate G12: the released source must be what a user installs.
//
// Checks that the tag exists and is immutable in intent (it points at the
// release commit, not somewhere else), that the manifest version matches it,
// that the repository is public, and that the source range a marketplace entry
// would name resolves to it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const repositoryUrl = manifest.repository.url.replace(/^git\+/u, "");
const expectedTag = `v${manifest.version}`;

function run(command, args, cwd = repoRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fail(message) {
  process.stderr.write(`release check failed: ${message}\n`);
  process.exit(1);
}

// 1. The tag exists on the remote and points at HEAD.
const tags = run("git", ["ls-remote", "--tags", repositoryUrl])
  .split("\n")
  .filter((line) => line.includes(`refs/tags/${expectedTag}`));
if (tags.length === 0) fail(`${expectedTag} is not on ${repositoryUrl}`);
const peeled = tags.find((line) => line.includes("^{}"));
const tagCommit = (peeled ?? tags[0]).split(/\s+/u)[0];
const head = run("git", ["rev-parse", "HEAD"]).trim();
if (tagCommit !== head) {
  fail(`${expectedTag} points at ${tagCommit}, but HEAD is ${head}`);
}

// 2. The repository is public, and the tag is what the manifest claims.
const view = JSON.parse(
  run("gh", ["repo", "view", repositoryUrl, "--json", "visibility,name,defaultBranchRef"]),
);
if (view.visibility !== "PUBLIC") fail(`repository is ${view.visibility}`);

// 3. A fresh clone of the tag carries the same version and the same entry point.
const cloneDir = mkdtempSync(path.join(tmpdir(), "agent-retry-release-"));
try {
  run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    expectedTag,
    repositoryUrl,
    cloneDir,
  ]);
  const cloned = JSON.parse(readFileSync(path.join(cloneDir, "package.json"), "utf8"));
  if (cloned.version !== manifest.version) {
    fail(`the tag holds version ${cloned.version}, not ${manifest.version}`);
  }
  if (cloned.bb.server !== "./server.ts") fail("the tagged manifest has no server entry");
  for (const file of [
    "server.ts",
    "policy.ts",
    "config.ts",
    "store.ts",
    "cli.ts",
    "PLUGIN_OVERVIEW.md",
    "skills/agent-retry/SKILL.md",
  ]) {
    run("test", ["-f", path.join(cloneDir, file)]);
  }
} finally {
  rmSync(cloneDir, { recursive: true, force: true });
}

// 4. The range an entry names resolves to this release.
const latest = run("git", ["ls-remote", "--tags", repositoryUrl])
  .split("\n")
  .map((line) => line.match(/refs\/tags\/v(\d+\.\d+\.\d+)$/u)?.[1])
  .filter(Boolean)
  .sort((a, b) =>
    a
      .split(".")
      .map(Number)
      .reduce((acc, part, index) => acc + part / 1000 ** index, 0) -
    b
      .split(".")
      .map(Number)
      .reduce((acc, part, index) => acc + part / 1000 ** index, 0),
  )
  .at(-1);
if (latest !== manifest.version) {
  fail(`the highest release is v${latest}, but the manifest is ${manifest.version}`);
}

process.stdout.write(
  `release source verified (${repositoryUrl} @ ${expectedTag} = ${tagCommit.slice(0, 7)}, public, range ^${manifest.version})\n`,
);
