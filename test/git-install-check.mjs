#!/usr/bin/env node
// Gate G8: a git install must be able to build this plugin.
//
// `bb plugin install git:<url>` runs `npm install --omit=dev --omit=optional`
// and then builds from source. Two things can break that and neither shows up
// in a working checkout: a runtime import left in devDependencies (installed
// away), and a file the build needs that was never committed. So this takes
// exactly the files git would hand over, installs exactly what a git install
// installs, and builds.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workDir = mkdtempSync(path.join(tmpdir(), "agent-retry-git-"));
const archivePath = path.join(workDir, "head.tar");

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fail(message) {
  process.stderr.write(`git install check failed: ${message}\n`);
  process.exit(1);
}

try {
  run("git", ["archive", "HEAD", "--format=tar", "-o", archivePath], repoRoot);
  const extractDir = path.join(workDir, "src");
  execFileSync("mkdir", ["-p", extractDir]);
  run("tar", ["-xf", archivePath, "-C", extractDir], repoRoot);

  if (!existsSync(path.join(extractDir, "package.json"))) {
    fail("git archive did not contain package.json");
  }
  if (existsSync(path.join(extractDir, "node_modules"))) {
    fail("git archive contained node_modules, which means it is committed");
  }

  // The git install's dependency step, verbatim.
  run("npm", ["install", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"], extractDir);

  const installed = JSON.parse(
    readFileSync(path.join(extractDir, "package.json"), "utf8"),
  );
  const runtimeDeps = Object.keys(installed.dependencies ?? {});
  for (const dependency of runtimeDeps) {
    if (!existsSync(path.join(extractDir, "node_modules", dependency))) {
      fail(`runtime dependency ${dependency} was not installed`);
    }
  }

  run("bb", ["plugin", "build"], extractDir);

  const metaPath = path.join(extractDir, "dist", "server.meta.json");
  const bundlePath = path.join(extractDir, "dist", "server.js");
  if (!existsSync(metaPath) || !existsSync(bundlePath)) {
    fail("bb plugin build produced no server bundle");
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (meta.pluginId !== "agent-retry") {
    fail(`built artifact declares pluginId ${meta.pluginId}`);
  }
  // A bundle that cannot be parsed would fail at load, after install.
  run("node", ["--check", bundlePath], extractDir);

  process.stdout.write(
    `production install build passed (${runtimeDeps.length} runtime dependency: ${runtimeDeps.join(", ")})\n`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
