#!/usr/bin/env node
/**
 * The operator console. `npm start`.
 *
 * A wrapper, deliberately: it asks questions and then runs the same `src/cli.ts`
 * commands a person would type, with stdio inherited so the output on screen is the
 * real thing rather than a summary of it. Nothing is orchestrated here that could not
 * be reproduced by hand, and every command it runs is printed before it runs — so this
 * doubles as documentation for the CLI.
 *
 * The reason it exists is that the interesting commands have a lot of surface. Replay
 * needs the exact input field names, and those come from whatever the discovery run
 * settled on — `account_number`, not `accountId`. Guessing them is the most common way
 * to get INPUT_VALIDATION. So the console reads the artifact and asks for its inputs
 * by name, with their type, whether they are required, and the description the
 * compiler recorded.
 *
 * Every run is headed, slowed, and recorded. This is a tool for a person sitting in
 * front of it; if you cannot see what it did, it has failed at its one job.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { join } from "node:path";

import { listCapabilities, CAPABILITY_DIR } from "./artifact/store.ts";
import { capabilityRisk } from "./policy/policy.ts";
import type { Capability, FieldSpec } from "./artifact/schema.ts";
import { listSessions, SESSION_DIR } from "./session/registry.ts";

try {
  process.loadEnvFile(".env");
} catch {
  // Credentials may come from the shell instead.
}

const ENTRY = "http://localhost:8080/parabank/index.htm";
const CREDENTIALS = ["operator_username", "operator_password"];
const VIDEO_ROOT = join("evidence", "video");
/** Slow enough that a person can follow each action without losing patience. */
const SLOW_MS = 700;

/**
 * Prompting that works whether stdin is a terminal or a pipe.
 *
 * `rl.question()` was the obvious choice and it is quietly broken for pipes: with a
 * non-TTY stdin it answers the first question and then never resolves again, so
 * `npm start < answers.txt` hangs after one prompt with no error. Iterating the
 * interface as a line stream behaves the same either way, which also makes this
 * scriptable — useful for producing an evidence run without a person at the keyboard.
 */
const lines: Interface = createInterface({ input: process.stdin });
const nextLine = lines[Symbol.asyncIterator]();

/** Thrown when input runs out, so a scripted session ends rather than hanging. */
class InputExhausted extends Error {}

async function ask(question: string, fallback?: string): Promise<string> {
  const suffix = fallback === undefined ? "" : ` [${fallback}]`;
  process.stdout.write(`  ${question}${suffix}: `);
  const { value, done } = await nextLine.next();
  if (done) {
    process.stdout.write("\n");
    throw new InputExhausted("no more input");
  }
  const answer = String(value).trim();
  return answer || fallback || "";
}

async function askRequired(question: string): Promise<string> {
  for (;;) {
    const answer = await ask(question);
    if (answer) return answer;
    console.log("  (required)");
  }
}

async function confirm(question: string, fallback = true): Promise<boolean> {
  const answer = await ask(`${question} (${fallback ? "Y/n" : "y/N"})`, fallback ? "y" : "n");
  return /^y/i.test(answer);
}

/** Numbered menu. Returns the chosen item, or null if the user backed out. */
async function choose<T>(
  title: string,
  items: T[],
  label: (item: T) => string,
): Promise<T | null> {
  if (!items.length) return null;
  console.log(`\n  ${title}`);
  items.forEach((item, i) => console.log(`    ${i + 1}) ${label(item)}`));
  console.log(`    0) back`);
  for (;;) {
    const raw = await ask("choice");
    const n = Number(raw);
    if (raw === "0") return null;
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!;
    console.log(`  (enter 1-${items.length}, or 0 to go back)`);
  }
}

// --- running the real CLI --------------------------------------------------

/**
 * Run a cli.ts command with stdio inherited.
 *
 * The command line is printed first, because a wrapper that hides what it runs makes
 * the thing it wraps harder to learn rather than easier.
 */
function run(args: string[]): Promise<number> {
  const shown = args.map((a) => (/[\s{}"']/.test(a) ? `'${a}'` : a)).join(" ");
  console.log(`\n  $ npm run cua -- ${shown}\n`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      // stdin ignored, not inherited. No cli.ts command reads it, and an inherited
      // stdin lets the child swallow the rest of a piped script — which is how a
      // scripted session loses every answer after the first command.
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Is the target application actually up?
 *
 * Worth its own check because the failure otherwise arrives as `FAILURE: INTERNAL` with
 * a Playwright call log attached, which reads like a defect in the automation. It is
 * not — it is a container that stopped. Told plainly, it costs a `docker start`.
 */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(new URL(url).origin, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

/** Warn, and let the operator decide. They may be pointing at something else. */
async function checkTarget(url: string): Promise<boolean> {
  if (await reachable(url)) return true;
  console.log(`\n  ${new URL(url).origin} is not answering.`);
  console.log(`  If that is ParaBank:  docker start parabank`);
  return confirm("Run anyway?", false);
}

/** A per-run directory, so recordings are findable rather than a pile of hashes. */
function videoDirFor(label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(VIDEO_ROOT, `${label}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Playwright names recordings by a random id. Rename to the run's label so a directory
 * of them can be read without opening each one.
 */
function nameTheVideo(dir: string, label: string): string | null {
  if (!existsSync(dir)) return null;
  const webm = readdirSync(dir).find((f) => f.endsWith(".webm"));
  if (!webm) return null;
  const target = join(dir, `${label}.webm`);
  if (join(dir, webm) !== target) renameSync(join(dir, webm), target);
  return target;
}

// --- describing artifacts --------------------------------------------------

function describeCapability(a: Capability): string {
  const gate = a.metadata.status === "approved" ? "approved" : a.metadata.status.toUpperCase();
  return `${a.metadata.id.padEnd(28)} ${capabilityRisk(a).padEnd(13)} ${gate}`;
}

function fieldPrompt(name: string, f: FieldSpec): string {
  return `${name} (${f.type}${f.required ? "" : ", optional"})`;
}

/** Ask for every declared input, showing what the artifact says about each. */
async function askInputs(a: Capability): Promise<Record<string, string>> {
  const inputs: Record<string, string> = {};
  console.log(`\n  ${a.metadata.title}`);
  for (const [name, field] of Object.entries(a.signature.inputs)) {
    if (field.description) console.log(`\n  ${field.description}`);
    const value = field.required
      ? await askRequired(fieldPrompt(name, field))
      : await ask(fieldPrompt(name, field), "");
    if (value) inputs[name] = value;
  }
  return inputs;
}

// --- the actions -----------------------------------------------------------

async function doReplay(): Promise<void> {
  const stored = listCapabilities();
  const picked = await choose("Which capability?", stored, (s) => describeCapability(s.artifact));
  if (!picked) return;

  const entry = picked.artifact.entry.originAllowlist[0] ?? ENTRY;
  if (!(await checkTarget(entry))) return;

  const inputs = await askInputs(picked.artifact);
  const dir = videoDirFor(`replay-${picked.artifact.metadata.id}`);

  await run([
    "replay",
    "--id", picked.artifact.metadata.id,
    "--input", JSON.stringify(inputs),
    "--headed", "--slow", String(SLOW_MS),
    "--video", dir,
  ]);

  const video = nameTheVideo(dir, picked.artifact.metadata.id);
  if (video) console.log(`\n  recording: ${video}`);
}

async function doDiscover(): Promise<void> {
  console.log(`
  Describe the task the way you would to a new operator, with the real values in it.
  The contract is read off the sentence: "look up account 13122 and read its current
  balance" yields one parameter and one output, and you get to see them before the
  run starts.`);

  const goal = await askRequired("goal");
  const id = await askRequired("capability id (e.g. account.lookup_balance)");
  const entry = await ask("entry url", ENTRY);
  if (!(await checkTarget(entry))) return;
  const dir = videoDirFor(`discover-${id}`);

  const args = [
    "discover",
    "--goal", goal,
    "--id", id,
    "--entry", entry,
    "--vendor", "parasoft",
    "--product", "parabank",
    "--version-range", ">=5.0.0 <6.0.0",
    "--headed", "--slow", String(SLOW_MS),
    "--video", dir,
  ];
  for (const c of CREDENTIALS) args.push("--credential", c);

  const code = await run(args);
  const video = nameTheVideo(dir, id);
  if (video) console.log(`\n  recording: ${video}`);
  if (code !== 0) return;

  // Compiled artifacts are always draft. Offering the approval here saves a command,
  // and refusing it is the honest default — nothing self-approves.
  if (await confirm(`\n  Approve ${id} now so it can run unattended?`, false)) {
    await doApprove(id);
  } else {
    console.log(`\n  Left as draft. Replaying it will be BLOCKED until approved.`);
  }
}

async function doApprove(preselected?: string): Promise<void> {
  let id = preselected;
  if (!id) {
    const drafts = listCapabilities();
    const picked = await choose("Approve which capability?", drafts, (s) => describeCapability(s.artifact));
    if (!picked) return;
    id = picked.artifact.metadata.id;
  }
  const approver = await ask("approver (an email or name, recorded in the artifact)", process.env.USER ?? "");
  if (!approver) return;
  await run(["approve", "--id", id, "--approver", approver]);
}

async function doProbe(): Promise<void> {
  console.log(`
  A probe drives a capability into an unhappy path on purpose, twice: once with inputs
  that work and once with inputs that do not. The exception rule is then the difference
  between the two screens — measured, not guessed. This is the only place an artifact
  ever gets 'verified: true'.`);

  const stored = listCapabilities();
  const picked = await choose("Probe which capability?", stored, (s) => describeCapability(s.artifact));
  if (!picked) return;

  console.log(`\n  First, inputs that SUCCEED (the reference run):`);
  const good = await askInputs(picked.artifact);
  console.log(`\n  Now inputs that reach the branch (e.g. a record that does not exist):`);
  const bad = await askInputs(picked.artifact);

  const code = await askRequired("outcome code (e.g. ACCOUNT_NOT_FOUND)");
  const answer = await ask("answer sentence, using ${inputs.*} placeholders (blank for none)", "");

  const args = [
    "probe",
    "--id", picked.artifact.metadata.id,
    "--good", JSON.stringify(good),
    "--bad", JSON.stringify(bad),
    "--code", code,
    "--class", "business_outcome",
    "--headed",
  ];
  if (answer) args.push("--answer", answer);
  await run(args);
  console.log(`\n  The artifact changed, so it is back to draft and needs re-approval.`);
}

/**
 * The handoff walkthrough.
 *
 * Needs a capability that actually stops, and the three real ones do not against a
 * healthy app — so this writes a temporary copy with one control's locator pointed at
 * something absent and onError set to escalate, then deletes it. That edit is exactly
 * what a vendor renaming a button looks like from here.
 *
 * The session runs as a detached child process on purpose. A browser owned by whatever
 * ran the last step cannot outlive it, and §3.6 requires the person to work on the
 * session the automation was using.
 */
async function doHandoff(): Promise<void> {
  const stored = listCapabilities().filter((s) =>
    s.artifact.steps.some((step) => step.action === "click"),
  );
  const picked = await choose(
    "Walk through a handoff on which capability?",
    stored,
    (s) => describeCapability(s.artifact),
  );
  if (!picked) return;

  if (!(await checkTarget(picked.artifact.entry.originAllowlist[0] ?? ENTRY))) return;

  const clicks = picked.artifact.steps.filter((s) => s.action === "click");
  const broken = await choose(
    "Which control should the vendor have renamed?",
    clicks,
    (s) => `${s.id}`,
  );
  if (!broken) return;

  const inputs = await askInputs(picked.artifact);

  // Must satisfy the schema's id pattern — lowercase, dot-separated, no leading
  // underscore. A "_walkthrough" here parsed fine as JSON and was rejected by the
  // schema at replay time, which made every later step of this walkthrough fail for
  // a reason that had nothing to do with what it was demonstrating.
  const demoId = "walkthrough.temporary";
  const demoPath = join(CAPABILITY_DIR, `${demoId}.json`);
  const sessionId = "walkthrough";
  const dir = videoDirFor("handoff");
  let serve: ReturnType<typeof spawn> | null = null;

  try {
    // A copy, broken at one step. Written as a file because every command below is a
    // separate process and resolves capabilities by id from disk.
    const copy = JSON.parse(JSON.stringify(picked.artifact)) as Capability;
    copy.metadata.id = demoId;
    copy.metadata.title = `TEMPORARY: ${picked.artifact.metadata.id} with ${broken.id} renamed`;
    copy.metadata.status = "draft";
    delete copy.metadata.digest;
    delete copy.metadata.approval;
    const step = copy.steps.find((s) => s.id === broken.id)!;
    step.target = {
      strategies: [{ kind: "role_name", role: "button", name: "Sign On With Passkey" }],
      baselineRung: 1,
      rationale: "Deliberately absent, standing in for a control the vendor renamed.",
    };
    step.onError = "escalate";
    writeFileSync(demoPath, `${JSON.stringify(copy, null, 2)}\n`);
    console.log(`\n  wrote ${demoPath} (temporary; deleted when this finishes)`);

    // Checked, not assumed. An unapproved copy would be BLOCKED at replay and the
    // walkthrough would go on to fail at every subsequent step for the wrong reason.
    if (await run(["approve", "--id", demoId, "--approver", "walkthrough@local"])) {
      console.log(`\n  Could not approve the temporary copy; stopping here.`);
      return;
    }

    console.log(`\n  Starting the session process. It owns the browser and nothing else.`);
    serve = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "session", "serve", "--id", sessionId, "--video", dir],
      { stdio: "inherit", detached: true },
    );
    // Wait for it to write its record, which is how other processes find the endpoint.
    for (let i = 0; i < 40 && !existsSync(join(SESSION_DIR, `${sessionId}.json`)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!existsSync(join(SESSION_DIR, `${sessionId}.json`))) {
      console.log(`\n  the session did not start; is port 9222 free?`);
      return;
    }

    const code = await run([
      "replay", "--id", demoId, "--input", JSON.stringify(inputs), "--session", sessionId,
    ]);
    if (code === 0) {
      console.log(`\n  That run did not need a person, so there is no handoff to walk through.`);
      return;
    }

    const actor = await ask("who is taking control?", process.env.USER ?? "operator");
    if (await run(["takeover", "--session", sessionId, "--actor", actor])) {
      console.log(`\n  Could not take control; stopping here.`);
      return;
    }

    console.log(`
  The browser window is yours. Do what the automation could not — the control it was
  looking for is still on screen under its real name.

  Try handing it back without touching anything first; the handback is refused, because
  resuming into an unchanged screen stops at the same step and asks again.`);
    await ask("\n  Press Enter when you have finished with the browser", "");

    const note = await ask("what did you do? (recorded on the session)", "clicked the control by hand");
    const handedBack = await run([
      "handback", "--session", sessionId, "--actor", actor, "--note", note,
    ]);
    if (handedBack !== 0) {
      console.log(`\n  Handback refused. Act on the page and try the walkthrough again.`);
      return;
    }

    await run(["resume", "--session", sessionId]);
    console.log(`\n  The session record is ${join(SESSION_DIR, `${sessionId}.json`)} — every`);
    console.log(`  control transfer, who held it, and a digest of the screen at each handover.`);
  } finally {
    if (serve?.pid) {
      // SIGTERM so the session closes its browser and finalises the recording.
      try { process.kill(serve.pid, "SIGTERM"); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 2500));
    }
    rmSync(demoPath, { force: true });
    const video = nameTheVideo(dir, "handoff");
    if (video) console.log(`\n  recording: ${video}`);
    console.log(`  removed ${demoPath}`);
  }
}

async function doList(): Promise<void> {
  await run(["list"]);
  const sessions = listSessions();
  if (sessions.length) await run(["session", "list"]);
}

// --- the menu --------------------------------------------------------------

const ACTIONS: Array<{ label: string; hint: string; go: () => Promise<void> }> = [
  { label: "Replay a capability", hint: "pick one, fill in its inputs, watch it run", go: doReplay },
  { label: "Discover a new capability", hint: "describe a task; the model works out how", go: doDiscover },
  { label: "Approve a capability", hint: "sign a draft so it can run unattended", go: doApprove },
  { label: "Probe an unhappy path", hint: "teach a capability what going wrong looks like", go: doProbe },
  { label: "Walk through a handoff", hint: "pause a run, take the browser, hand it back", go: doHandoff },
  { label: "Show what exists", hint: "capabilities, their risk, and any live sessions", go: doList },
];

async function main(): Promise<void> {
  console.log(`
  Computer-use automation — operator console

  Every run here is headed, slowed to ${SLOW_MS}ms per action, and recorded to
  ${VIDEO_ROOT}/. Each command is printed before it runs, so anything you do here
  you can also do by hand.`);

  if (!listCapabilities().length) {
    console.log(`\n  No capabilities yet — start with "Discover a new capability".`);
  }

  for (;;) {
    const chosen = await choose(
      "What do you want to do?",
      ACTIONS,
      (a) => `${a.label.padEnd(28)} ${a.hint}`,
    );
    if (!chosen) break;
    try {
      await chosen.go();
    } catch (e) {
      // Running out of input ends the session; anything else is one bad answer, and
      // should not cost the operator the rest of their work.
      if (e instanceof InputExhausted) break;
      console.log(`\n  ${(e as Error).message}`);
    }
  }
  console.log("\n  bye\n");
}

main()
  .then(() => lines.close())
  .catch((e) => {
    // Input running out at the top-level menu is a normal end, not a failure.
    if (!(e instanceof InputExhausted)) {
      console.error(`error: ${(e as Error).message}`);
      lines.close();
      process.exit(1);
    }
    console.log("\n  bye\n");
    lines.close();
  });
