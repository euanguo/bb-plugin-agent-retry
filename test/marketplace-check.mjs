#!/usr/bin/env node
// Gate G11: the marketplace submission must pass the marketplace's own build
// and check, with this plugin's entry, icon, screenshots and overview in it.
//
// Run against a clone of the marketplace repository:
//   BB_MARKETPLACE_DIR=/path/to/marketplace node test/marketplace-check.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const PLUGIN_ID = "agent-retry";
const marketplaceDir =
  process.env.BB_MARKETPLACE_DIR ?? "/tmp/bb-marketplace";

function fail(message) {
  process.stderr.write(`marketplace check failed: ${message}\n`);
  process.exit(1);
}

function run(command, args) {
  return execFileSync(command, args, {
    cwd: marketplaceDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

if (!existsSync(path.join(marketplaceDir, "package.json"))) {
  fail(
    `no marketplace repository at ${marketplaceDir}; clone get-bb/marketplace there or set BB_MARKETPLACE_DIR`,
  );
}

const entryPath = path.join(marketplaceDir, "entries", `${PLUGIN_ID}.json`);
if (!existsSync(entryPath)) fail(`no entry at entries/${PLUGIN_ID}.json`);
const entry = JSON.parse(readFileSync(entryPath, "utf8"));

// The entry, its filename and the plugin manifest must agree.
if (entry.id !== PLUGIN_ID) fail(`entry id is ${entry.id}`);
for (const field of ["displayName", "description", "icon", "author", "source"]) {
  if (entry[field] === undefined) fail(`entry has no ${field}`);
}
if (entry.author.github !== "euanguo") fail(`author.github is ${entry.author.github}`);
if (entry.category === undefined) {
  fail("entry has no category, which marketplace CI refuses");
}
const base = JSON.parse(
  readFileSync(path.join(marketplaceDir, "marketplace.base.json"), "utf8"),
);
const categories = (base.categories ?? []).map((category) =>
  typeof category === "string" ? category : category.id,
);
if (!categories.includes(entry.category)) {
  fail(`category ${entry.category} is not one of ${categories.join(", ")}`);
}

// The icon is vendored, hashed, and inside the size rule.
const iconFile = entry.icon.url.replace(/^\.\//u, "");
const iconPath = path.join(marketplaceDir, iconFile);
if (!existsSync(iconPath)) fail(`icon ${iconFile} is missing`);
if (!iconFile.startsWith("icons/")) fail(`icon ${iconFile} is not vendored in icons/`);
const iconBytes = readFileSync(iconPath).length;
if (iconBytes > 256 * 1024) fail(`icon is ${iconBytes} bytes, over the 256 KiB cap`);
const hash = execFileSync("shasum", ["-a", "256", iconPath], { encoding: "utf8" })
  .split(/\s+/u)[0]
  .slice(0, 8);
if (!iconFile.includes(hash)) fail(`icon filename does not carry its hash (${hash})`);

// Screenshots: referenced, present, wide enough, small enough, and no orphans.
const screenshots = entry.screenshots ?? [];
if (screenshots.length === 0) fail("entry references no screenshot");
const shotDir = path.join(marketplaceDir, "screenshots", PLUGIN_ID);
for (const relative of screenshots) {
  const file = path.join(marketplaceDir, relative.replace(/^\.\//u, ""));
  if (!existsSync(file)) fail(`screenshot ${relative} is missing`);
  const bytes = readFileSync(file).length;
  if (bytes > 2 * 1024 * 1024) fail(`${relative} is over 2 MiB`);
  const dimensions = execFileSync("sips", ["-g", "pixelWidth", file], {
    encoding: "utf8",
  });
  const width = Number(dimensions.match(/pixelWidth: (\d+)/u)?.[1] ?? 0);
  if (width < 1200) fail(`${relative} is ${width}px wide, under the 1200px floor`);
}
const present = existsSync(shotDir) ? readdirSync(shotDir) : [];
const referenced = screenshots.map((relative) => path.basename(relative));
for (const file of present) {
  if (!referenced.includes(file)) fail(`screenshots/${PLUGIN_ID}/${file} is unreferenced`);
}

// The overview is copied from the plugin repository and referenced.
if (entry.overview !== `./overview/${PLUGIN_ID}.md`) {
  fail(`entry overview is ${entry.overview}`);
}
const overviewPath = path.join(marketplaceDir, "overview", `${PLUGIN_ID}.md`);
if (!existsSync(overviewPath)) fail(`no overview at overview/${PLUGIN_ID}.md`);
const overview = readFileSync(overviewPath, "utf8");
if (overview.length > 4000) fail("overview is over 4000 characters");

// The marketplace's own two commands, which are the real gate.
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
run("npm", ["run", "build"]);
run("npm", ["run", "check"]);

process.stdout.write(
  `marketplace validation passed (entry, icon ${iconBytes}B, ${screenshots.length} screenshot(s), ${overview.length}-char overview)\n`,
);
