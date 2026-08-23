#!/usr/bin/env node
/**
 * Operator entry point. Thin on purpose — it parses flags and prints results; every
 * decision lives in the modules it calls.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCapability, listCapabilities, saveCapability, CAPABILITY_DIR } from "./artifact/store.ts";
import type { ExceptionRule } from "./artifact/schema.ts";
import type { Observation } from "./surface/driver.ts";
import { discover } from "./discovery/loop.ts";
import { compile, probeOutcome } from "./discovery/compile.ts";
import { modelFromEnv } from "./discovery/model.ts";
import { planGoal } from "./discovery/plan.ts";
import { approve } from "./artifact/digest.ts";
import { capabilityRisk, loadPolicy, POLICY_PATH, requiresApproval } from "./policy/policy.ts";
import {
  createSession, listSessions, readSession, writeSession, SESSION_DIR, type SessionRecord,
} from "./session/registry.ts";
import { handback, pause, takeover } from "./hitl/handoff.ts";
import { WebDriver } from "./surface/web/driver.ts";
import { replay } from "./replay/engine.ts";
import { formatMoney } from "./replay/values.ts";
import type { ReplayResult } from "./result/types.ts";

/**
 * Load .env before anything reads process.env.
 *
 * Node does not read .env on its own, and neither did we — a key sitting in the file
 * was simply invisible. Using the built-in loader rather than a dependency; a real
 * environment variable already set always wins, so CI and shell exports are unaffected.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // No .env is normal: replay needs only credentials, which may come from the shell.
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** Repeatable flags: --param a=1 --param b=2 */
function pairs(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  process.argv.forEach((arg, i) => {
    if (arg !== `--${name}`) return;
    const [k, ...rest] = (process.argv[i + 1] ?? "").split("=");
    if (k && rest.length) out[k] = rest.join("=");
  });
  return out;
}
function repeated(name: string): string[] {
  return process.argv.flatMap((arg, i) => (arg === `--${name}` ? [process.argv[i + 1] ?? ""] : []));
}

const USAGE = `
  discover --goal '<natural language>' --id <capability> --entry <url>
           [--param k=v ...] [--output <name>:<type> ...]   (inferred if omitted)
           [--credential <role> ...] [--headed] [--slow <ms>] [--policy <file>]
           [--video <dir>]
           [--max-turns <n>] [--vendor <v>] [--product <p>] [--risk <class>]
           [--answer '<sentence template>']   (derived from the goal if omitted)
  replay   --id <capability> --input '<json>' [--headed] [--slow <ms>] [--video <dir>]
           [--tenant <name>] [--unapproved] [--policy <file>] [--session <session>]
  session  serve  --id <session> [--port <n>] [--headless] [--video <dir>]
                                                            (blocks; owns the browser)
           list
  takeover --session <session> --actor <who>
  handback --session <session> --actor <who> [--note '<what you did>'] [--force]
  resume   --session <session>
  probe    --id <capability> --good '<json>' --bad '<json>'
           --code <CODE> [--class business_outcome|recoverable|hard_failure]
           [--answer '<sentence>'] [--headed]
  approve  --id <capability> --approver <who>
  list     [--policy <file>]
`;

async function main(): Promise<number> {
  const command = process.argv[2];

  if (command === "list") {
    const policy = loadPolicy(flag("policy") ?? POLICY_PATH);
    for (const { path, artifact: a } of listCapabilities()) {
      const gate = a.metadata.status === "approved" ? "approved" : a.metadata.status.toUpperCase();
      console.log(`${a.metadata.id}  v${a.metadata.version}  [${gate}]`);
      console.log(`    ${a.metadata.title}`);
      // Risk and the gate side by side, because "draft" only matters if the policy
      // in force actually gates this risk class.
      console.log(
        `    risk: ${capabilityRisk(a)}` +
        `${requiresApproval(policy, a) ? " (approval required)" : " (runs unattended)"}`,
      );
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

  if (command === "discover") {
    const goal = required("goal");
    const id = required("id");
    const entry = required("entry");

    const explicitOutputs = repeated("output").map((spec) => {
      const [name, type = "string"] = spec.split(":");
      if (!name) throw new Error(`--output needs <name>:<type>, got ${JSON.stringify(spec)}`);
      if (!["string", "money", "number", "boolean"].includes(type)) {
        throw new Error(`unknown output type '${type}'`);
      }
      return { name, type: type as "string" | "money" | "number" | "boolean" };
    });
    const explicitParams = pairs("param");

    const model = await modelFromEnv();

    // §3.1 asks for a natural-language goal, and the brief's examples put the value
    // inline: "look up member 12345 and read their savings balance". So when the
    // contract is not spelled out, read it off the goal rather than demanding the
    // operator pre-decompose their own request. Explicit flags always win, and the
    // proposal is printed so it can be seen and disagreed with.
    let params = explicitParams;
    let requiredOutputs = explicitOutputs;
    let goalTemplate = goal;
    let answer = flag("answer");

    if (!Object.keys(explicitParams).length || !explicitOutputs.length) {
      const plan = await planGoal(model, goal);
      if (!Object.keys(explicitParams).length) { params = plan.params; goalTemplate = plan.template; }
      if (!explicitOutputs.length) requiredOutputs = plan.outputs;
      // The sentence the capability will state its own result with. Derived here,
      // reviewed at approval, and rendered at replay with no model involved.
      answer ??= plan.answer || undefined;

      console.log("read from the goal:");
      const shown = Object.entries(params);
      console.log(`  parameters ${shown.length ? shown.map(([k, v]) => `${k}=${v}`).join(", ") : "(none)"}`);
      console.log(`  outputs    ${requiredOutputs.length ? requiredOutputs.map((o) => `${o.name}:${o.type}`).join(", ") : "(none)"}`);
      console.log(`  template   ${goalTemplate}`);
      console.log(`  answer     ${answer ?? "(none)"}\n`);
    }

    if (!requiredOutputs.length) {
      throw new Error(
        "no outputs were identified in the goal, so the capability would return nothing. " +
        "State what the task should report back, or pass --output <name>:<type>.",
      );
    }
    const driver = new WebDriver({
      headed: has("headed"),
      slowMoMs: flag("slow") ? Number(flag("slow")) : undefined,
      ...(flag("video") ? { videoDir: flag("video") } : {}),
    });
    await driver.launch();

    // The model always sees real values, never a placeholder; the compiler
    // parameterises afterwards using the provenance it was given.
    const renderedGoal = Object.entries(params).reduce(
      (g, [k, v]) => g.replaceAll(`{{${k}}}`, v),
      goal,
    );

    console.log(`discovering with ${model.id}`);
    console.log(`  goal   ${renderedGoal}`);
    console.log(`  entry  ${entry}\n`);

    const run = await discover({
      goal: renderedGoal, params, entryUrl: entry, driver, model,
      policy: loadPolicy(flag("policy") ?? POLICY_PATH),
      credentials: repeated("credential"),
      requiredOutputs,
      maxTurns: flag("max-turns") ? Number(flag("max-turns")) : undefined,
    });
    await driver.close();

    console.log(`\n${run.status.toUpperCase()} after ${run.trace.length} turns, ${run.modelCalls} model calls`);
    console.log(`  ${run.stopReason}`);
    for (const t of run.trace) {
      const rung = t.target ? ` rung ${t.target.resolvedRung}` : "";
      const mark = t.outcome === "ok" ? " " : "!";
      console.log(`  ${mark} ${String(t.turn).padStart(2)} ${t.action.kind.padEnd(7)}${rung.padEnd(8)} ${t.thought.slice(0, 70)}`);
    }
    console.log(`\n  evidence: ${run.evidenceDir}`);
    const discoveryVideo = driver.videoPath();
    if (discoveryVideo) console.log(`  video:    ${discoveryVideo}`);
    if (run.status !== "success") return 1;

    const artifact = compile({
      run, capabilityId: id,
      // The template, so the title reads as a capability rather than one invocation.
      title: flag("title") ?? goalTemplate,
      description: flag("description") ?? `Discovered from a live run against ${new URL(entry).host}.`,
      vendor: flag("vendor") ?? "unknown",
      product: flag("product") ?? "unknown",
      versionRange: flag("version-range") ?? ">=0.0.0",
      originAllowlist: [new URL(entry).origin],
      entryPath: new URL(entry).pathname + new URL(entry).search,
      requiredOutputs,
      ...(answer ? { answer } : {}),
      ...(flag("risk") ? { risk: flag("risk") as "safe" | "reversible" | "irreversible" } : {}),
    });

    const path = join(CAPABILITY_DIR, `${id}.json`);
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`  compiled: ${path}  (${artifact.steps.length} steps, status ${artifact.metadata.status})`);
    console.log(`\nApprove it before unattended replay:\n  npm run approve -- --id ${id} --approver you@example.com`);
    return 0;
  }

  /**
   * The session commands. These exist because §3.6 requires the human to operate the
   * same live session the automation was using, and a browser owned by the agent
   * process cannot outlive it — so `session serve` is a separate process whose only
   * job is to hold the browser open. Every other command attaches over CDP, does its
   * work, and detaches without closing anything.
   */
  if (command === "session") {
    const sub = process.argv[3];

    if (sub === "list") {
      const sessions = listSessions();
      if (!sessions.length) console.log("no sessions. start one: npm run session -- serve --id s1");
      for (const s of sessions) {
        const turn = s.actors.at(-1);
        console.log(`${s.id}  owner=${s.owner}  ${s.cdpEndpoint}`);
        console.log(`    held by ${turn?.actor ?? "?"} since ${turn?.took ?? "?"}`);
        if (s.pending) {
          console.log(`    waiting: ${s.pending.capabilityId} at ${s.pending.stepId} — ${s.pending.reason}`);
        }
        console.log(`    ${s.actors.length} control transfer(s)`);
      }
      return 0;
    }

    if (sub === "serve") {
      const id = required("id");
      const port = Number(flag("port") ?? 9222);
      // Headed by default: the operator has to be able to see and click the page they
      // are about to be handed. A headless session is for tests.
      const driver = new WebDriver({
        headed: !has("headless"),
        remoteDebuggingPort: port,
        ...(flag("video") ? { videoDir: flag("video") } : {}),
      });
      await driver.launch();
      await driver.act({ action: "navigate", url: "about:blank" });

      const endpoint = `http://localhost:${port}`;
      const record = createSession(id, endpoint, process.pid);
      console.log(`session ${id} serving on ${endpoint}  (pid ${record.pid})`);
      console.log(`  state: ${join(SESSION_DIR, `${id}.json`)}`);
      console.log(`\nRun against it:  npm run replay -- --id <capability> --input '{...}' --session ${id}`);
      console.log(`Stop it with Ctrl-C; the browser dies with this process, by design.\n`);

      // Block. The browser's lifetime is this process's lifetime, and that is the point:
      // something has to own it, and it must not be whatever ran the last step.
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => resolve());
        process.on("SIGTERM", () => resolve());
      });
      await driver.close();
      const sessionVideo = driver.videoPath();
      // The whole session, including everything the operator did by hand.
      if (sessionVideo) console.log(`session video: ${sessionVideo}`);
      console.log(`session ${id} ended`);
      return 0;
    }

    console.error("usage: session serve --id <session> | session list");
    return 2;
  }

  if (command === "takeover") {
    const record = readSession(required("session"));
    const actor = required("actor");
    const driver = await attachTo(record);
    try {
      const { fingerprint, url } = await takeover(record, driver, actor);
      console.log(`${actor} now holds session ${record.id}`);
      console.log(`  the browser window is yours; it is showing ${url}`);
      if (record.pending) {
        console.log(`  stopped at ${record.pending.stepId}: ${record.pending.reason}`);
      }
      console.log(`  screen recorded as ${fingerprint}`);
      console.log(`\nWhen you are done:\n  npm run handback -- --session ${record.id} --actor ${actor} --note '...'`);
      return 0;
    } finally {
      // Detach. The browser, and therefore the operator's screen, is untouched.
      await driver.close();
    }
  }

  if (command === "handback") {
    const record = readSession(required("session"));
    const actor = required("actor");
    if (!record.pending) throw new Error(`session ${record.id} has no run to resume`);
    const { artifact } = loadCapability(record.pending.capabilityId);

    const driver = await attachTo(record);
    try {
      const result = await handback(record, driver, artifact, {
        actor,
        ...(flag("note") ? { note: flag("note") } : {}),
        force: has("force"),
      });
      console.log(`${actor} returned session ${record.id} to the automation`);
      console.log(`  screen changed: ${result.changed}`);
      if (result.plan.skipped.length) {
        console.log(`  already done, will be skipped: ${result.plan.skipped.join(", ")}`);
      }
      const next = artifact.steps[result.plan.index];
      console.log(`  will resume at: ${next ? next.id : "(the success checkpoint)"}`);
      console.log(`\nContinue the run:\n  npm run resume -- --session ${record.id}`);
      return 0;
    } finally {
      await driver.close();
    }
  }

  if (command === "resume") {
    const record = readSession(required("session"));
    if (!record.pending) throw new Error(`session ${record.id} has no run to resume`);
    if (record.owner !== "automation") {
      throw new Error(
        `session ${record.id} is still held by ${record.actors.at(-1)?.actor}. ` +
        `Hand it back before resuming.`,
      );
    }
    const { artifact } = loadCapability(record.pending.capabilityId);
    const driver = await attachTo(record, record.pending.inputs);
    try {
      console.log(`resuming ${record.pending.capabilityId} on session ${record.id}`);
      const result = await replay({
        artifact,
        inputs: record.pending.inputs,
        driver,
        tenant: record.pending.tenant,
        // The state on this page is exactly what we are resuming into.
        freshSession: false,
        resumeFrom: record.pending.stepIndex,
      });
      report(result);
      if (result.status !== "intervention_required") {
        record.pending = null;
        writeSession(record);
      } else {
        pause(record, artifact, result, record.pending.inputs, record.pending.tenant);
      }
      return result.status === "success" || result.status === "business_outcome" ? 0 : 1;
    } finally {
      await driver.close();
    }
  }

  /**
   * Teach a capability what an unhappy path looks like, by driving it into one.
   *
   * Every other command produces artifacts from happy runs, and those artifacts ship
   * with `exceptions: []` — deliberately, because a run that never failed has seen
   * nothing about failure. This is the only way an exception rule ever gets written,
   * and the only place `verified: true` is ever set.
   *
   * It runs the capability twice against the live application: once with inputs that
   * work, once with inputs that reach the branch. The rule is then the textual
   * difference between the two screens, which is a measurement rather than a guess.
   */
  if (command === "probe") {
    const id = required("id");
    const good = JSON.parse(required("good")) as Record<string, string>;
    const bad = JSON.parse(required("bad")) as Record<string, string>;
    const code = required("code");
    const outcomeClass = (flag("class") ?? "business_outcome") as ExceptionRule["class"];

    const stored = loadCapability(id);
    const driver = new WebDriver({ headed: has("headed") });
    await driver.launch();

    // Unapproved on purpose: probing is a development activity against a draft, and
    // demanding approval first would mean approving an artifact whose exception rules
    // do not exist yet.
    const shared = { artifact: stored.artifact, driver, requireApproved: false };
    console.log(`probing ${id}`);
    const happy = await replay({ ...shared, inputs: good });
    if (happy.status !== "success") {
      await driver.close();
      console.error(`the reference run did not succeed (${happy.status}), so there is `
        + `nothing to compare against. Fix that run first.`);
      report(happy);
      return 1;
    }

    const unhappy = await replay({ ...shared, inputs: bad });
    await driver.close();
    report(unhappy);

    if (unhappy.status === "success") {
      console.error(`\nthe probe inputs succeeded, so no ${code} branch was reached.`);
      return 1;
    }

    const successState = readObservation(happy.evidenceDir, ["success"]);
    const branchState = readObservation(unhappy.evidenceDir, ["failure", "unhappy", "intervention"]);
    if (!successState || !branchState) {
      console.error("\nno observation was recorded for one of the two runs.");
      return 1;
    }

    const updated = probeOutcome(
      stored.artifact,
      branchState,
      { id: `x_${code.toLowerCase()}`, code, class: outcomeClass, ...(flag("answer") ? { answer: flag("answer") } : {}) },
      successState,
    );
    saveCapability({ ...stored, artifact: updated });

    const added = updated.exceptions.at(-1)!;
    console.log(`\nrecorded exception ${added.id} (${added.class}, verified)`);
    console.log(`  ${JSON.stringify(added.when)}`);
    console.log(`\n${stored.path} changed, so it is back to draft and needs re-approval.`);
    return 0;
  }

  if (command === "replay") {
    const id = required("id");
    const inputs = JSON.parse(flag("input") ?? "{}") as Record<string, string>;
    const videoDir = flag("video");

    const { artifact } = loadCapability(id);
    // A run bound to a session borrows that session's browser, so an escalation can be
    // handed to a person instead of ending the run. Without --session the browser is
    // this process's own and dies with it, which is correct for an unattended run.
    const session = flag("session") ? readSession(flag("session")!) : null;
    const driver = session
      ? await attachTo(session, inputs)
      : new WebDriver({
          headed: has("headed"),
          slowMoMs: flag("slow") ? Number(flag("slow")) : undefined,
          ...(videoDir ? { videoDir } : {}),
        });
    if (!session) await driver.launch();

    const policy = loadPolicy(flag("policy") ?? POLICY_PATH);
    console.log(`replaying ${id} v${artifact.metadata.version}  inputs=${JSON.stringify(inputs)}`);
    console.log(`  risk ${capabilityRisk(artifact)}, policy ${flag("policy") ?? POLICY_PATH}`);
    if (session) console.log(`  session ${session.id} (${session.cdpEndpoint})`);
    const result = await replay({
      artifact,
      inputs,
      driver,
      policy,
      tenant: flag("tenant") ?? null,
      // --unapproved is an explicit override for testing a draft; without it the
      // policy decides, by the capability's risk.
      ...(has("unapproved") ? { requireApproved: false } : {}),
    });
    await driver.close();

    report(result);
    // Printed after the report because the file only exists once the browser has closed.
    const video = driver.videoPath();
    if (video) console.log(`  video:    ${video}`);
    if (session && result.status === "intervention_required") {
      pause(session, artifact, result, inputs, flag("tenant") ?? null);
      console.log(`\nThe session is paused and still open. Hand it to a person:`);
      console.log(`  npm run takeover -- --session ${session.id} --actor you@example.com`);
    } else if (result.status === "intervention_required") {
      console.log(`\nThis run needed a person, but it was not bound to a session, so the`);
      console.log(`browser is gone. Re-run with --session <id> to make the handoff possible.`);
    }
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

/** Join a session's existing browser. Never launches one. */
async function attachTo(
  record: SessionRecord,
  inputs: Record<string, string> = {},
): Promise<WebDriver> {
  const driver = new WebDriver({ cdpEndpoint: record.cdpEndpoint, inputs });
  await driver.launch();
  return driver;
}

/** The first observation a run happened to record, by preferred name. */
function readObservation(dir: string, names: string[]): Observation | null {
  for (const name of names) {
    try {
      return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Observation;
    } catch {
      // Not the shape this run ended in; try the next.
    }
  }
  return null;
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
      // The sentence first, because it is the thing a person actually asked for;
      // the typed outputs below it are what a calling agent consumes.
      if (r.answer) console.log(`\n  ${r.answer}\n`);
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
      if (r.answer) console.log(`\n  ${r.answer}\n`);
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
    console.log("\n  step                 outcome    rung  strategy       drift     ms");
    for (const t of r.trace) {
      const rung = t.resolvedRung === null ? "-" : `${t.resolvedRung}/${t.baselineRung}`;
      const drift = t.drift === "none" ? "" : t.drift.toUpperCase();
      // The outcome column exists because of `skipped`: without it, a step a person
      // completed during a handoff is indistinguishable from one that ran in 0ms.
      console.log(
        `  ${t.stepId.padEnd(20)} ${t.outcome.padEnd(10)} ${rung.padEnd(5)} ` +
        `${(t.strategy ?? "-").padEnd(14)} ${drift.padEnd(9)} ${t.durationMs}`,
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

