#!/usr/bin/env node
// Derive the plugin id from a package manifest, exactly as bb and the
// marketplace do: drop the npm scope, drop a lowercase `bb-plugin-` prefix,
// lowercase, replace every other character run with a hyphen, trim the edges.
//
// This mirrors the marketplace's `scripts/derive-plugin-id.mjs` so the gate
// stays runnable from a clone of this repository alone, without reaching into
// a local bb installation.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function derivePluginId(packageName) {
  const withoutScope = packageName.startsWith("@")
    ? packageName.slice(packageName.indexOf("/") + 1)
    : packageName;
  const withoutPrefix = withoutScope.toLowerCase().startsWith("bb-plugin-")
    ? withoutScope.slice("bb-plugin-".length)
    : withoutScope;
  return withoutPrefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

// Run as a command only when invoked directly, so the test that imports the
// derivation does not also run its CLI.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const manifestPath = process.argv[2];
  if (manifestPath === undefined) {
    process.stderr.write("usage: node test/derive-plugin-id.mjs <package.json>\n");
    process.exit(2);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const id = derivePluginId(manifest.name);
  if (id.length === 0) {
    process.stderr.write(`derived an empty plugin id from ${manifest.name}\n`);
    process.exit(1);
  }
  process.stdout.write(`${id}\n`);
}
