#!/usr/bin/env node
/**
 * Operator entry point. Thin on purpose — it parses flags and prints results; every
 * decision lives in the modules it calls.
 */
import { loadCapability, listCapabilities, saveCapability } from "./artifact/store.ts";
import { approve } from "./artifact/digest.ts";
import { WebDriver } from "./surface/web/driver.ts";
import { replay } from "./replay/engine.ts";
import { formatMoney } from "./replay/values.ts";
import type { ReplayResult } from "./result/types.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const USAGE = `
  replay   --id <capability> --input '<json>' [--headed] [--slow <ms>] [--video <dir>]
           [--tenant <name>] [--unapproved]
  approve  --id <capability> --approver <who>
  list
`;

async function main(): Promise<number> {
  const command = process.argv[2];

  if (command === "list") {
    for (const { path, artifact: a } of listCapabilities()) {
      const gate = a.metadata.status === "approved" ? "approved" : a.metadata.status.toUpperCase();
      console.log(`${a.metadata.id}  v${a.metadata.version}  [${gate}]`);
      console.log(`    ${a.metadata.title}`);
      console.log(`    in:  ${describeFields(a.signature.inputs)}`);
      console.log(`    out: ${describeFields(a.signature.outputs)}`);
      console.log(`    ${path}\n`);
    }
    return 0;
  }

  if (command === "approve") {
    const id = required("id");
    const approver = required("approver");
    const stored = loadCapability(id);
    const approved = approve(stored.artifact, approver);
    saveCapability({ ...stored, artifact: approved });
    console.log(`approved ${id} v${approved.metadata.version}`);
    console.log(`  digest   ${approved.metadata.digest}`);
    console.log(`  approver ${approver}`);
    console.log(`\nAny edit to ${stored.path} now invalidates this approval.`);
    return 0;
  }

  if (command === "replay") {
    const id = required("id");
    const inputs = JSON.parse(flag("input") ?? "{}") as Record<string, string>;
    const videoDir = flag("video");

    const { artifact } = loadCapability(id);
    const driver = new WebDriver({
      headed: has("headed"),
      slowMoMs: flag("slow") ? Number(flag("slow")) : undefined,
      ...(videoDir ? { videoDir } : {}),
    });
    await driver.launch();

    console.log(`replaying ${id} v${artifact.metadata.version}  inputs=${JSON.stringify(inputs)}`);
    const result = await replay({
      artifact,
      inputs,
      driver,
      tenant: flag("tenant") ?? null,
      requireApproved: !has("unapproved"),
    });
    await driver.close();

    report(result);
    if (videoDir) console.log(`\nvideo: ${videoDir}`);
    // A business outcome is a legitimate answer, so it exits 0. Only a genuine
    // failure or a refusal is a non-zero exit.
    return result.status === "success" || result.status === "business_outcome" ? 0 : 1;
  }

  console.error(`usage:${USAGE}`);
  return 2;
}

function required(name: string): string {
  const v = flag(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

function describeFields(fields: Record<string, { type: string; required?: boolean }>): string {
  const entries = Object.entries(fields);
  if (!entries.length) return "(none)";
  return entries.map(([k, f]) => `${k}: ${f.type}${f.required === false ? "?" : ""}`).join(", ");
}

/** One block per status, so the taxonomy is visible at the terminal. */
function report(r: ReplayResult): void {
  console.log("");
  switch (r.status) {
    case "success":
      console.log(`SUCCESS in ${r.durationMs}ms`);
      for (const [k, v] of Object.entries(r.outputs)) {
        const shown = isMoney(v) ? formatMoney(v) : JSON.stringify(v);
        console.log(`  ${k} = ${shown}`);
      }
      if (r.recoveries.length) {
        console.log(`  recovered from: ${r.recoveries.map((x) => x.code).join(", ")}`);
      }
      break;

    case "business_outcome":
      // Not an error. The automation worked; the answer is negative.
      console.log(`BUSINESS OUTCOME: ${r.code}`);
      console.log(`  observed: ${r.observed.slice(0, 160)}`);
      break;

    case "intervention_required":
      console.log(`NEEDS A HUMAN: ${r.code}`);
      console.log(`  at step   ${r.stepId}`);
      console.log(`  because   ${r.reason}`);
      console.log(`  id        ${r.interventionId}`);
      break;

    case "blocked":
      console.log(`BLOCKED by ${r.policyRule}`);
      console.log(`  ${r.reason}`);
      break;

    case "failure":
      console.log(`FAILURE: ${r.code}`);
      console.log(`  step      ${r.stepId ?? "(before any step)"}`);
      console.log(`  expected  ${r.expected}`);
      console.log(`  observed  ${r.observed}`);
      console.log(`  retryable ${r.safeToRetry}`);
      break;
  }

  if ("trace" in r && r.trace.length) {
    console.log("\n  step                 rung  strategy       drift     ms");
    for (const t of r.trace) {
      const rung = t.resolvedRung === null ? "-" : `${t.resolvedRung}/${t.baselineRung}`;
      const drift = t.drift === "none" ? "" : t.drift.toUpperCase();
      console.log(
        `  ${t.stepId.padEnd(20)} ${rung.padEnd(5)} ${(t.strategy ?? "-").padEnd(14)} ${drift.padEnd(9)} ${t.durationMs}`,
      );
    }
  }
  console.log(`\n  evidence: ${r.evidenceDir}`);
}

function isMoney(v: unknown): v is { currency: string; minorUnits: number } {
  return typeof v === "object" && v !== null && "minorUnits" in v && "currency" in v;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });

