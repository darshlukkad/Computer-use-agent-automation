/**
 * The production execution path. No model is consulted, ever.
 *
 * `tests/architecture.test.ts` asserts this file imports no model SDK, because the
 * central claim of the whole system — that production runs are deterministic and
 * cheap — is a boundary claim, and boundaries erode one convenient import at a time.
 *
 * Per step: policy -> precondition -> resolve -> act -> postcondition, with retries
 * gated on what the step does to the world rather than on how many attempts are
 * left.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Capability, Step } from "../artifact/schema.ts";
import { verifyApproval } from "../artifact/digest.ts";
import type { ReplayResult, Recovery, StepTrace } from "../result/types.ts";
import { classifyDrift, isRetrySafe } from "../result/types.ts";
import { TargetAmbiguous, TargetMissing, type SurfaceDriver } from "../surface/driver.ts";
import { EvalContext, describe, waitFor } from "./conditions.ts";
import { classify, recoveryPermitted } from "./classify.ts";
import { resolveSecret, validateInputs, validateOutputs, ValueError } from "./values.ts";

export interface ReplayOptions {
  artifact: Capability;
  inputs: Record<string, string>;
  driver: SurfaceDriver;
  tenant?: string | null;
  /** Set false to run a capability still in draft (discovery, manual testing). */
  requireApproved?: boolean;
  evidenceRoot?: string;
  /** Total recoveries permitted across the run, so a flapping page cannot loop. */
  recoveryBudget?: number;
  /**
   * Discard cookies before starting, so a run cannot inherit a session from the
   * previous one. Default true, because a capability that declares "the login page
   * is showing" as its precondition cannot satisfy it while already signed in — and
   * silently skipping the login steps would make two replays of identical inputs
   * take different paths.
   *
   * Set false when resuming after a human handoff: the operator's session is
   * exactly the state we want to keep.
   */
  freshSession?: boolean;
}

/**
 * Omit<> over a union collapses it to the keys every member shares, which would
 * erase exactly the per-status fields the result contract exists to carry. This
 * distributes so each variant keeps its own shape.
 */
type PerVariant<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PartialResult = PerVariant<ReplayResult, "durationMs">;

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const started = Date.now();
  const { artifact, driver } = opts;
  const tenant = opts.tenant ?? null;
  const requireApproved = opts.requireApproved ?? true;
  let recoveryBudget = opts.recoveryBudget ?? 3;

  const trace: StepTrace[] = [];
  const recoveries: Recovery[] = [];
  const evidenceDir = makeEvidenceDir(opts.evidenceRoot ?? "evidence", artifact.metadata.id);

  const base = {
    capabilityId: artifact.metadata.id,
    capabilityVersion: artifact.metadata.version,
    tenant,
    evidenceDir,
  };
  const done = (r: PartialResult): ReplayResult => {
    const result = { ...r, durationMs: Date.now() - started } as ReplayResult;
    writeFileSync(join(evidenceDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };

  // --- gates that run before a browser is touched --------------------------

  if (requireApproved) {
    const approval = verifyApproval(artifact);
    if (!approval.valid) {
      // Refusing is not failing: nothing was attempted and the remedy is review,
      // not debugging.
      return done({
        ...base, status: "blocked",
        policyRule: "approval-required",
        reason: approval.reason,
      });
    }
  }

  let inputs: Record<string, string>;
  try {
    inputs = validateInputs(artifact.signature.inputs, opts.inputs);
  } catch (e) {
    return done({
      ...base, status: "failure", code: "INPUT_VALIDATION",
      stepId: null,
      expected: `inputs matching ${Object.keys(artifact.signature.inputs).join(", ")}`,
      observed: (e as Error).message,
      safeToRetry: false, trace,
    });
  }

  const entry = new URL(artifact.entry.path, artifact.entry.originAllowlist[0]!).toString();
  if (!artifact.entry.originAllowlist.some((o) => entry.startsWith(o))) {
    return done({
      ...base, status: "blocked",
      policyRule: "origin-allowlist",
      reason: `entry ${entry} is outside the capability's allowlist`,
    });
  }

  const ctx = new EvalContext(driver, inputs);
  if ("setInputs" in driver) (driver as { setInputs(i: Record<string, string>): void }).setInputs(inputs);

  // --- the run -------------------------------------------------------------

  const extracted: Record<string, string> = {};

  try {
    if (opts.freshSession ?? true) await driver.clearSession();
    await driver.act({ action: "navigate", url: entry });

    for (const pre of artifact.preconditions) {
      if (!(await waitFor(ctx, pre, 10_000))) {
        return done({
          ...base, status: "failure", code: "PRECONDITION_FAILED",
          stepId: null,
          expected: describe(pre, inputs),
          observed: summarize((await ctx.observation()).text),
          safeToRetry: true, trace,
        });
      }
    }

    for (let i = 0; i < artifact.steps.length; i++) {
      const step = artifact.steps[i]!;
      const stepStart = Date.now();
      const entryTrace: StepTrace = {
        stepId: step.id, action: step.action,
        resolvedRung: null, baselineRung: step.target?.baselineRung ?? null,
        strategy: null, drift: "none", attempts: 0,
        durationMs: 0, outcome: "failed",
      };
      trace.push(entryTrace);

      if (step.precondition && !(await waitFor(ctx, step.precondition, step.timeoutMs))) {
        const verdict = await handleStuck(step, i, "PRECONDITION_FAILED", describe(step.precondition, inputs));
        if (verdict) return verdict;
      }

      // Retry is governed by what the action does to the world, never by the
      // attempt counter alone. maxAttempts on a committed step is a lint error, so
      // this collapses to a single attempt there.
      const attempts = isRetrySafe(step.effect) ? step.maxAttempts : 1;
      let satisfied = false;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= attempts && !satisfied; attempt++) {
        entryTrace.attempts = attempt;
        try {
          if (step.target) {
            const res = await driver.resolve(step.target);
            entryTrace.resolvedRung = res.rung;
            entryTrace.strategy = res.strategy.kind;
            entryTrace.drift = classifyDrift(step.target.baselineRung, res.rung);
          }
          await perform(step, driver, inputs);
          satisfied = step.postcondition
            ? await waitFor(ctx, step.postcondition, step.timeoutMs)
            : true;
        } catch (e) {
          lastError = e as Error;
          if (e instanceof TargetAmbiguous) break; // never retried: the artifact is wrong
        }
        if (!satisfied && attempt < attempts) {
          await new Promise((r) => setTimeout(r, 400));
        }
      }

      if (!satisfied) {
        if (lastError instanceof TargetAmbiguous) {
          return done({
            ...base, status: "failure", code: "TARGET_AMBIGUOUS",
            stepId: step.id,
            expected: "exactly one matching control",
            observed: lastError.message,
            safeToRetry: false, trace,
          });
        }
        const code = lastError instanceof TargetMissing ? "TARGET_MISSING" : "POSTCONDITION_FAILED";
        const expected = lastError
          ? lastError.message
          : describe(step.postcondition!, inputs);
        const verdict = await handleStuck(step, i, code, expected);
        if (verdict) return verdict;
        // A recovery succeeded; re-verify and continue.
        satisfied = step.postcondition ? await waitFor(ctx, step.postcondition, step.timeoutMs) : true;
        if (!satisfied) {
          return done({
            ...base, status: "failure", code: "POSTCONDITION_FAILED",
            stepId: step.id, expected,
            observed: summarize((await ctx.observation()).text),
            safeToRetry: isRetrySafe(step.effect), trace,
          });
        }
        entryTrace.outcome = "recovered";
      } else {
        entryTrace.outcome = entryTrace.outcome === "recovered" ? "recovered" : "ok";
      }
      entryTrace.durationMs = Date.now() - stepStart;

      if (step.action === "read" && step.extractTo) {
        extracted[step.extractTo] = await driver.readText(step.target!);
      }
    }

    // --- the success checkpoint is independent of the steps completing ------

    if (!(await waitFor(ctx, artifact.success.checkpoint, 15_000))) {
      const verdict = await handleStuck(null, artifact.steps.length, "CHECKPOINT_MISMATCH",
        describe(artifact.success.checkpoint, inputs));
      if (verdict) return verdict;
    }

    const outputs = validateOutputs(artifact.signature.outputs, extracted);
    return done({ ...base, status: "success", outputs, recoveries, trace });
  } catch (e) {
    if (e instanceof ValueError) {
      return done({
        ...base, status: "failure", code: "OUTPUT_VALIDATION",
        stepId: null,
        expected: `outputs matching ${Object.keys(artifact.signature.outputs).join(", ")}`,
        observed: e.message, safeToRetry: true, trace,
      });
    }
    await driver.screenshot(join(evidenceDir, "failure.png")).catch(() => undefined);
    return done({
      ...base, status: "failure", code: "INTERNAL",
      stepId: trace.at(-1)?.stepId ?? null,
      expected: "the step to complete",
      observed: (e as Error).message.slice(0, 300),
      safeToRetry: false, trace,
    });
  }

  /**
   * Called whenever a checkpoint will not hold. Returns a terminal result, or null
   * if a recovery ran and the caller should re-verify.
   */
  async function handleStuck(
    step: Step | null,
    index: number,
    code: "PRECONDITION_FAILED" | "POSTCONDITION_FAILED" | "TARGET_MISSING" | "CHECKPOINT_MISMATCH",
    expected: string,
  ): Promise<ReplayResult | null> {
    const verdict = await classify(ctx, artifact);

    if (verdict.class === "business_outcome") {
      // The automation worked; the answer is negative. Not a failure.
      return done({
        ...base, status: "business_outcome",
        code: verdict.code, observed: verdict.observed,
        recoveries, trace,
      });
    }

    if (verdict.class === "recoverable") {
      const allowed = recoveryPermitted(verdict.recover, artifact, index);
      if (!allowed.permitted) {
        await driver.screenshot(join(evidenceDir, "intervention.png")).catch(() => undefined);
        return done({
          ...base, status: "intervention_required",
          interventionId: `iv_${Date.now().toString(36)}`,
          code: verdict.code,
          reason: `recovery refused: ${allowed.reason}`,
          stepId: step?.id ?? "success", trace,
        });
      }
      if (recoveryBudget <= 0) {
        await driver.screenshot(join(evidenceDir, "intervention.png")).catch(() => undefined);
        return done({
          ...base, status: "intervention_required",
          interventionId: `iv_${Date.now().toString(36)}`,
          code: verdict.code,
          reason: "recovery budget exhausted; the page keeps returning to this state",
          stepId: step?.id ?? "success", trace,
        });
      }
      recoveryBudget -= 1;
      recoveries.push({
        stepId: step?.id ?? "success",
        attempt: recoveries.length + 1,
        code: verdict.code,
        action: verdict.recover.strategy,
      });
      await runRecovery(verdict.recover, index);
      return null;
    }

    await driver.screenshot(join(evidenceDir, "failure.png")).catch(() => undefined);
    return done({
      ...base, status: "failure", code,
      stepId: step?.id ?? null,
      expected,
      observed: verdict.code ? `${verdict.code}: ${verdict.observed}` : verdict.observed,
      safeToRetry: step ? isRetrySafe(step.effect) : true, trace,
    });
  }

  async function runRecovery(
    plan: Parameters<typeof recoveryPermitted>[0],
    index: number,
  ): Promise<void> {
    switch (plan.strategy) {
      case "dismiss":
        await driver.act({ action: "click", target: plan.target });
        return;
      case "wait_retry":
        await new Promise((r) => setTimeout(r, plan.waitMs));
        return;
      case "re_login": {
        // Permitted only when nothing before this point committed — checked above.
        await driver.act({ action: "navigate", url: entry });
        for (const s of artifact.steps.slice(0, index)) {
          await perform(s, driver, inputs).catch(() => undefined);
        }
        return;
      }
    }
  }
}

async function perform(
  step: Step,
  driver: SurfaceDriver,
  inputs: Record<string, string>,
): Promise<void> {
  switch (step.action) {
    case "navigate":
      // Entry navigation is handled by the engine; a mid-flow navigate is a no-op
      // unless the step carries its own target, which the schema does not permit.
      return;
    case "wait":
    case "assert":
    case "read":
      return; // purely observational — the postcondition does the work
    case "fill":
      return driver.act({ action: "fill", target: step.target!, value: valueOf(step, inputs) });
    case "select":
      return driver.act({ action: "select", target: step.target!, value: valueOf(step, inputs) });
    case "click":
      return driver.act({ action: "click", target: step.target! });
  }
}

function valueOf(step: Step, inputs: Record<string, string>): string {
  const v = step.value;
  if (!v) throw new ValueError(`step '${step.id}' is a ${step.action} with no value`);
  switch (v.kind) {
    case "const": return v.value;
    case "param": {
      const found = inputs[v.name];
      if (found === undefined) throw new ValueError(`step '${step.id}' needs input '${v.name}'`);
      return found;
    }
    case "secret": return resolveSecret(v.ref);
  }
}

function summarize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function makeEvidenceDir(root: string, capabilityId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(root, `replay-${capabilityId}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
