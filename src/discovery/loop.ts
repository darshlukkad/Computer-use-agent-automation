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

  let observation = await driver.observe();
  history.push({ role: "user", text: renderGoal(opts.goal, observation) });

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
        case "fill":
          await driver.act({ action: "fill", target: ladder, value: decision.action.value });
          break;
        case "select":
          await driver.act({ action: "select", target: ladder, value: decision.action.value });
          break;
        case "read": {
          const value = await driver.readText(ladder);
          outputs[decision.action.outputName] = value;
          entry.extracted = { name: decision.action.outputName, value };
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
