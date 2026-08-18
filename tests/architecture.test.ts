/**
 * Architectural invariants, enforced rather than asserted in a document.
 *
 * The two central claims of this system are boundary claims: the surface is the
 * only thing that knows about a browser, and replay never asks a model anything.
 * Both are cheap to state in a README and easy to erode with one convenient
 * import, so they are tested.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Import statements only — a mention in a comment is not a dependency. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const re = /^\s*import\s[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) specifiers.push(m[1] ?? m[2]!);
  return specifiers;
}

test("only the web surface driver may import a browser library", () => {
  const allowed = ["src/surface/web/driver.ts", "src/surface/web/resolve.ts"];
  const offenders = sourceFiles("src")
    .filter((f) => importsOf(f).some((s) => s === "playwright" || s.startsWith("playwright/")))
    .filter((f) => !allowed.includes(f));

  assert.deepEqual(offenders, [],
    `browser imports escaped the seam. A desktop driver would have to reimplement these:\n  ${offenders.join("\n  ")}`);
});

test("the surface seam itself declares no browser dependency", () => {
  // If the interface needed Playwright types, no non-browser surface could satisfy it.
  assert.ok(!importsOf("src/surface/driver.ts").some((s) => s.startsWith("playwright")));
});

test("the replay path cannot reach a model SDK", () => {
  // The system's central claim is that production runs are deterministic and cost
  // nothing per invocation. That is a boundary claim, and boundaries erode one
  // convenient import at a time — so it is checked rather than asserted.
  const MODEL_SDKS = ["@anthropic-ai/sdk", "openai", "@google/generative-ai", "ollama"];

  const reachable = new Set<string>();
  const walk = (file: string): void => {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const spec of importsOf(file)) {
      if (!spec.startsWith(".")) continue;
      const resolved = join(file, "..", spec);
      try { statSync(resolved); walk(resolved); } catch { /* type-only or missing */ }
    }
  };
  walk("src/replay/engine.ts");

  const offenders: string[] = [];
  for (const file of reachable) {
    for (const spec of importsOf(file)) {
      if (MODEL_SDKS.some((sdk) => spec === sdk || spec.startsWith(`${sdk}/`))) {
        offenders.push(`${file} -> ${spec}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    `a model SDK is reachable from the replay engine:\n  ${offenders.join("\n  ")}`);
  // Sanity: the walk must actually have traversed the graph, or this proves nothing.
  assert.ok(reachable.size >= 5, `only walked ${reachable.size} files`);
});

test("the artifact schema depends on nothing but its validator", () => {
  // The schema is the contract shared with reviewers and calling agents; it must
  // not drag in execution machinery.
  const imports = importsOf("src/artifact/schema.ts");
  assert.deepEqual(imports, ["zod"]);
});
