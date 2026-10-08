// Hygiene scenarios: what a published plugin must be true of, checked against
// the files themselves rather than asserted by hand.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

const packageRoot = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
  description: string;
  license: string;
  repository: { url: string };
  engines: Record<string, string>;
  bb: {
    name: string;
    description: string;
    branding: { icon?: string; logo?: unknown };
    server: string;
    skills?: string[];
    app?: string;
  };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

import { derivePluginId } from "./derive-plugin-id.mjs";

function walk(dir: string, skip: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, skip));
    } else {
      found.push(full);
    }
  }
  return found;
}

describe("public SDK surface", () => {
  it("imports nothing outside the public SDK and holds no private dependency", () => {
    // `vitest/config` is the test runner's own entry, which the scan cannot
    // know is tooling rather than plugin code.
    const scan = experimental_scanPublicSdkOnly(packageRoot, {
      allow: [/^vitest(\/|$)/u],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
    expect(scan.files.length).toBeGreaterThan(5);
  });
});

describe("manifest", () => {
  it("identifies the plugin the way the marketplace will", () => {
    expect(derivePluginId(manifest.name)).toBe("agent-retry");
    expect(manifest.bb.name).toBe("Agent Retry");
    expect(manifest.bb.name.length).toBeLessThanOrEqual(24);
  });

  it("carries a one-sentence hook short enough for a browse card", () => {
    expect(manifest.bb.description).toBe(manifest.description);
    expect(manifest.bb.description.length).toBeGreaterThan(40);
    expect(manifest.bb.description.length).toBeLessThanOrEqual(140);
    expect(manifest.bb.description).not.toMatch(
      /powerful|seamless|easy|simple|fast|best|modern|beautiful|robust|intuitive/iu,
    );
    // The hook must stand alone in a two-line clamp, so it is one sentence.
    expect(manifest.bb.description.match(/\.\s|\.[^.]*$/gu)?.length ?? 0).toBe(1);
  });

  it("declares identity, an icon, a server entry, and engine ranges", () => {
    expect(manifest.bb.branding.icon).toBeTruthy();
    expect(manifest.bb.server).toBe("./server.ts");
    expect(manifest.bb.app).toBeUndefined();
    expect(manifest.engines.bb).toBeTruthy();
    expect(manifest.engines.bbPluginSdk).toBeTruthy();
    expect(manifest.license).toBe("MIT");
    expect(manifest.repository.url).toContain("github.com/euanguo/bb-plugin-agent-retry");
    expect(manifest.bb.skills).toEqual(["skills"]);
  });

  it("keeps zod as the only runtime dependency", () => {
    expect(Object.keys(manifest.dependencies)).toEqual(["zod"]);
    // Anything the build or the tests need stays out of the runtime install,
    // which is what a git install performs.
    expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBeTruthy();
  });
});

describe("shipped documents", () => {
  const overview = readFileSync(
    path.join(packageRoot, "PLUGIN_OVERVIEW.md"),
    "utf8",
  );
  const skill = readFileSync(
    path.join(packageRoot, "skills", "agent-retry", "SKILL.md"),
    "utf8",
  );

  it("keeps the overview inside the marketplace's content rules", () => {
    expect(overview.length).toBeLessThanOrEqual(4000);
    expect(overview.length).toBeGreaterThanOrEqual(700);
    expect(overview.trimStart().startsWith("#")).toBe(false);
    expect(overview).not.toMatch(/<[a-z]/iu); // raw HTML
    expect(overview).not.toMatch(/^\s*\|/mu); // tables
    expect(overview).not.toMatch(/!\[/u); // images
    expect(overview).not.toMatch(/\[\^/u); // footnotes
    expect(overview).not.toMatch(/^\s*- \[[ x]\]/mu); // task lists
    for (const link of overview.match(/\]\(([^)]+)\)/gu) ?? []) {
      expect(link).toMatch(/\]\(https:\/\//u);
    }
    // Every heading is a section label, not a page title.
    for (const heading of overview.match(/^#+ .*$/gmu) ?? []) {
      expect(heading.startsWith("## ")).toBe(true);
    }
  });

  it("documents the plugin's own commands and settings in its skill", () => {
    expect(skill).toMatch(/^---\nname: agent-retry\n/u);
    expect(skill).toMatch(/description: "/u);
    for (const command of ["status", "log", "explain", "simulate", "cancel", "retry"]) {
      expect(skill).toContain(`bb agent-retry ${command}`);
    }
    expect(skill).toContain("advancedJson");
  });

  it("keeps the overview and the hook on the same claim", () => {
    // Both must mention the two things a user decides on: any failure, and a
    // growing wait.
    for (const text of [manifest.bb.description, overview]) {
      expect(text).toMatch(/fail/iu);
      expect(text).toMatch(/backoff|wait/iu);
    }
  });
});

describe("privacy", () => {
  it("ships no home directory path, token, or email", () => {
    const files = walk(packageRoot, new Set(["node_modules", "dist", ".git"]));
    const offenders: string[] = [];
    for (const file of files) {
      if (!/\.(ts|js|mjs|json|md|txt)$/u.test(file)) continue;
      // This file holds the patterns themselves, so it would always match.
      if (file.endsWith("hygiene.test.ts")) continue;
      const text = readFileSync(file, "utf8");
      if (/\/Users\/[a-z]/iu.test(text)) offenders.push(`${file}: home path`);
      if (/gho_|ghp_|sk-[A-Za-z0-9]{16}/u.test(text)) offenders.push(`${file}: token`);
      // Strip npm scopes before looking for an address, so `@get-bb/plugin-sdk`
      // and `@types/node` cannot read as one.
      if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/iu.test(text.replace(/@[\w-]+\//gu, ""))) {
        offenders.push(`${file}: email`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not commit the build output or the dependency tree", () => {
    const ignore = readFileSync(path.join(packageRoot, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^dist\/$/mu);
    expect(ignore).toMatch(/^node_modules\/$/mu);
  });
});
