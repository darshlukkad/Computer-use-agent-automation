/**
 * The discovery loop: observe -> decide -> act, until the goal is met or a stopping
 * condition fires.
 *
 * The model proposes; this loop disposes. Every action is policy-checked before it
 * touches the page, and the page is snapshotted before and after — the before/after
 * pair is what the compiler later diffs to derive a checkpoint, so the model is never
 * asked to invent one.
 *
 * Parameters are handled by provenance rather than by asking the model about them.
 * The caller supplies `params`, the goal text is rendered with those values
 * substituted, and the compiler knows which literal came from which parameter because
 * it was told. Nothing in the prompt mentions parameterisation at all.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Observation, SurfaceDriver } from "../surface/driver.ts";
import { TargetAmbiguous, TargetMissing } from "../surface/driver.ts";
import type { Target } from "../artifact/schema.ts";
import { renderDecision, renderGoal, renderResult, SYSTEM } from "./prompt.ts";
import { resolveSecret } from "../replay/values.ts";
import type { Decision, Exchange, ModelClient, ModelTarget } from "./model.ts";

export interface TraceEntry {
  turn: number;
  thought: string;
  action: Decision["action"];
  /** The ladder we synthesised, and which rung actually resolved it. */
  target?: { ladder: Target; resolvedRung: number };
  /** State before and after, for checkpoint derivation and for evidence. */
  before: Observation;
  after?: Observation;
  outcome: "ok" | "unresolved" | "ambiguous" | "blocked" | "error";
  /** Set when this fill wrote a credential; the value itself is never recorded. */
  credentialRef?: string;
  detail?: string;
  extracted?: { name: string; value: string };
}

export interface DiscoveryRun {
  status: "success" | "stuck" | "exhausted" | "failed";
  goal: string;
  params: Record<string, string>;
  model: string;
  modelCalls: number;
  trace: TraceEntry[];
  outputs: Record<string, string>;
  stopReason: string;
  evidenceDir: string;
}

export interface DiscoverOptions {
  goal: string;
  /** Values injected into the goal text; the compiler parameterises by these. */
  params?: Record<string, string>;
  entryUrl: string;
  driver: SurfaceDriver;
  model: ModelClient;
  maxTurns?: number;
  timeoutMs?: number;
  evidenceRoot?: string;
  /** Actions the run may take at all. Defaults to the read-only set. */
  allowedActions?: Array<Decision["action"]["kind"]>;
  /**
   * Logical credential roles the run may use, e.g. ["operator_username"].
   *
   * The model is told these names and fills fields with them verbatim; the real value
   * is substituted here, at the keystroke. So the secret never enters the model's
   * context and never enters the trace, while the sign-in still works. Giving the
   * model the actual credential would put it in the transcript, the evidence, and any
   * provider-side logging — for a value it has no need to know.
   */
  credentials?: string[];
  /** The output contract the caller wants. Declared, never invented by the model. */
  requiredOutputs?: Array<{ name: string; type: string }>;
}

const SAFE_ACTIONS: Array<Decision["action"]["kind"]> = [
  "click", "fill", "select", "read", "done", "stuck",
];

/**
 * Turn what the model saw into a ladder worth recording.
 *
 * An accessible name yields a rung 1 candidate; a caption yields a nearby_text rung.
 * Both are emitted when both are known, so an artifact recorded against a label-less
 * app still improves automatically if the vendor adds proper labelling later. Which
 * rung actually resolves is measured, not assumed — that measurement becomes
 * `baselineRung`, and it is what makes drift detection meaningful rather than noisy.
 */
function ladderFor(t: ModelTarget): Target {
  const strategies: Target["strategies"] = [];
  const reasons: string[] = [];

  // A figure in a grid is located by column and row, never by what sits beside it:
  // stepping from a column header to the next cell lands in the first row, which on a
  // live run read one account's number as another account's balance.
  if (t.columnHeader && t.rowLabel) {
    strategies.push({ kind: "table_cell", header: t.columnHeader, rowMatch: t.rowLabel });
    reasons.push(
      `it is the cell under ${JSON.stringify(t.columnHeader)} in the row for ` +
      `${JSON.stringify(t.rowLabel)}, so neither column order nor row order matters`,
    );
  }
  if (t.name) {
    strategies.push({ kind: "role_name", role: t.role, name: t.name });
    reasons.push(`the application names this control ${JSON.stringify(t.name)}`);
  }
  if (t.nearbyText) {
    strategies.push({ kind: "label", text: t.nearbyText });
    strategies.push({ kind: "nearby_text", text: t.nearbyText, direction: "below" });
    reasons.push(
      `its visible caption is ${JSON.stringify(t.nearbyText)}, which is what an operator reads` +
      (t.name ? "" : " because the application gives this control no name of its own"),
    );
  }
  if (!strategies.length) {
    // Nothing identifying was observed; a role alone is not a locator.
    strategies.push({ kind: "role_name", role: t.role, name: "" });
    reasons.push("only a role was observed, which is not a stable identification");
  }

  return {
    strategies,
    baselineRung: 1, // replaced with the measured rung below
    rationale: `Recorded from a live run: ${reasons.join("; ")}.`,
  };
}

export async function discover(opts: DiscoverOptions): Promise<DiscoveryRun> {
  const { driver, model } = opts;
  const params = opts.params ?? {};
  const maxTurns = opts.maxTurns ?? 14;
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  const allowed = new Set(opts.allowedActions ?? SAFE_ACTIONS);

  const evidenceDir = makeDir(opts.evidenceRoot ?? "evidence", "discover");
  const logPath = join(evidenceDir, "log.jsonl");
  const log = (event: string, data: Record<string, unknown>): void => {
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
  };

  const trace: TraceEntry[] = [];
  const outputs: Record<string, string> = {};
  const history: Exchange[] = [];
  let modelCalls = 0;

  const finish = (status: DiscoveryRun["status"], stopReason: string): DiscoveryRun => {
    const run: DiscoveryRun = {
      status, goal: opts.goal, params, model: model.id, modelCalls,
      trace, outputs, stopReason, evidenceDir,
    };
    // The full trace, including every failed attempt. A tidied transcript would
    // misrepresent how the run actually went.
    writeFileSync(join(evidenceDir, "trace.json"), `${JSON.stringify(run, null, 2)}\n`);
    log("finished", { status, stopReason, modelCalls, turns: trace.length });
    return run;
  };

  log("started", { goal: opts.goal, entryUrl: opts.entryUrl, model: model.id, maxTurns });
  await driver.clearSession();
  await driver.act({ action: "navigate", url: opts.entryUrl });

  const credentials = opts.credentials ?? [];
  const requiredOutputs = opts.requiredOutputs ?? [];
  const wanted = new Set(requiredOutputs.map((r) => r.name));
  let observation = await driver.observe();
  history.push({ role: "user", text: renderGoal(opts.goal, observation, credentials, requiredOutputs) });

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (Date.now() > deadline) return finish("exhausted", "timeout");

    let decision: Decision;
    try {
      decision = await model.decide(SYSTEM, history);
      modelCalls += 1;
    } catch (e) {
      log("model_error", { turn, message: (e as Error).message });
      return finish("failed", `model error: ${(e as Error).message}`);
    }

    log("decided", { turn, thought: decision.thought, action: decision.action });
    history.push({ role: "assistant", text: renderDecision(decision) });

    const entry: TraceEntry = {
      turn, thought: decision.thought, action: decision.action,
      before: observation, outcome: "ok",
    };

    if (decision.action.kind === "done") {
      // The model's claim of success is not evidence of success. Hold it to the
      // contract: on a live run this caught a model reporting it had read a balance
      // when it had in fact read an account number.
      const missing = [...wanted].filter((n) => !(n in outputs));
      if (missing.length) {
        entry.outcome = "blocked";
        entry.detail = `claimed done without reading: ${missing.join(", ")}`;
        trace.push(entry);
        log("premature_done", { turn, missing });
        history.push({
          role: "user",
          text: renderResult(
            `You have not recorded ${missing.join(", ")} yet, so the goal is not met. ` +
            `Read the control that displays the value.`,
            observation,
          ),
        });
        continue;
      }
      trace.push(entry);
      await driver.screenshot(join(evidenceDir, `turn-${pad(turn)}-done.png`)).catch(() => undefined);
      return finish("success", decision.action.summary || "model reported the goal met");
    }
    if (decision.action.kind === "stuck") {
      trace.push(entry);
      await driver.screenshot(join(evidenceDir, `turn-${pad(turn)}-stuck.png`)).catch(() => undefined);
      return finish("stuck", decision.action.reason || "model reported no way forward");
    }

    // Policy first: the model proposes, and an action outside the permitted set never
    // reaches the page.
    if (!allowed.has(decision.action.kind)) {
      entry.outcome = "blocked";
      entry.detail = `action '${decision.action.kind}' is not permitted for this run`;
      trace.push(entry);
      log("blocked", { turn, action: decision.action.kind });
      history.push({ role: "user", text: renderResult(`That action is not permitted in this run. ${entry.detail}`, observation) });
      continue;
    }

    const ladder = ladderFor(decision.action.target);
    let resolvedRung: number | null = null;

    try {
      const resolution = await driver.resolve(ladder);
      resolvedRung = resolution.rung;
      entry.target = { ladder: { ...ladder, baselineRung: resolution.rung }, resolvedRung: resolution.rung };

      switch (decision.action.kind) {
        case "click":
          await driver.act({ action: "click", target: ladder });
          break;
        case "fill": {
          // Substitute here and nowhere earlier: the trace keeps the placeholder.
          const isCredential = credentials.includes(decision.action.value);
          const typed = isCredential ? resolveSecret(decision.action.value) : decision.action.value;
          await driver.act({ action: "fill", target: ladder, value: typed });
          if (isCredential) entry.credentialRef = decision.action.value;
          break;
        }
        case "select":
          await driver.act({ action: "select", target: ladder, value: decision.action.value });
          break;
        case "read": {
          const name = decision.action.outputName;
          if (wanted.size && !wanted.has(name)) {
            // Names are part of the contract; a run may not rename them.
            entry.outcome = "blocked";
            entry.detail = `'${name}' is not a declared output`;
            trace.push(entry);
            observation = await driver.observe();
            history.push({
              role: "user",
              text: renderResult(
                `'${name}' is not one of the values this task requires. Use one of: ${[...wanted].join(", ")}.`,
                observation,
              ),
            });
            continue;
          }
          const value = await driver.readText(ladder);
          outputs[name] = value;
          entry.extracted = { name, value };
          break;
        }
      }
    } catch (e) {
      entry.outcome =
        e instanceof TargetAmbiguous ? "ambiguous"
        : e instanceof TargetMissing ? "unresolved"
        : "error";
      entry.detail = (e as Error).message;
      trace.push(entry);
      log("act_failed", { turn, outcome: entry.outcome, detail: entry.detail });

      // Report the failure back and let the model reconsider. This is where a real run
      // gets messy, and the mess is kept in the evidence rather than smoothed away.
      observation = await driver.observe();
      history.push({
        role: "user",
        text: renderResult(`That action failed: ${entry.detail}`, observation),
      });
      continue;
    }

    await driver.screenshot(join(evidenceDir, `turn-${pad(turn)}-${decision.action.kind}.png`))
      .catch(() => undefined);

    observation = await driver.observe();
    entry.after = observation;
    trace.push(entry);
    log("acted", {
      turn, action: decision.action.kind, resolvedRung,
      url: observation.url, extracted: entry.extracted?.name,
    });

    history.push({ role: "user", text: renderResult("Action completed.", observation) });
  }

  return finish("exhausted", `reached the ${maxTurns}-turn limit`);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function makeDir(root: string, prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(root, `${prefix}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
