/**
 * Trace -> artifact.
 *
 * This is the step that makes a run reusable, and three of its decisions are the ones
 * worth defending.
 *
 * Parameters come from provenance, not from string matching. The caller told us
 * accountId was "13122"; we replace that exact literal where it was actually typed.
 * Searching the trace for a value that looks like an id would also rewrite an account
 * number that merely happened to appear in a table.
 *
 * Checkpoints are derived by diffing the page before and after each action, so the
 * model is never asked to invent one — a model guessing at a success condition is a
 * model guessing, and the whole point of replay is that nothing guesses.
 *
 * Exception rules are NOT invented here. A happy-path run has not seen a failure, so
 * emitting a plausible-looking rule for one would be fabrication dressed as a
 * mechanism. `probeOutcome` adds them from runs that genuinely hit the branch.
 */
import type {
  Capability, Condition, ExceptionRule, FieldSpec, Step, Target,
} from "../artifact/schema.ts";
import { parseCapability } from "../artifact/schema.ts";
import type { AxNode, Observation } from "../surface/driver.ts";
import type { DiscoveryRun, TraceEntry } from "./loop.ts";

const RUNNER_VERSION = "0.1.0";
const MONEY = /^-?[$€£]?\s?[\d,]+\.\d{2}$/;
/** Values too volatile to assert on: amounts, dates, times, long digit runs. */
const VOLATILE = /\d{2}[:/-]\d{2}|[$€£]\s?[\d,]+\.\d{2}|\b\d{4,}\b/;

export interface CompileOptions {
  run: DiscoveryRun;
  capabilityId: string;
  title: string;
  description: string;
  vendor: string;
  product: string;
  versionRange: string;
  originAllowlist: string[];
  entryPath: string;
  /**
   * The output contract, declared by the caller. Compilation fails if what the run
   * read does not fit — which is how a model claiming to have read a balance when it
   * read an account number gets stopped before it becomes an artifact.
   */
  requiredOutputs?: Array<{ name: string; type: FieldSpec["type"] }>;
  answer?: string;
}

export class CompileFailed extends Error {}

export function compile(opts: CompileOptions): Capability {
  const { run } = opts;
  if (run.status !== "success") {
    throw new CompileFailed(`refusing to compile a run that ended '${run.status}': ${run.stopReason}`);
  }

  const acted = run.trace.filter((t) => t.outcome === "ok" && t.target);
  if (!acted.length) throw new CompileFailed("the run completed without a single successful action");

  const inputs: Record<string, FieldSpec> = {};
  const steps: Step[] = [];
  /** Parameters that turned out to be genuinely used somewhere in the flow. */
  const usedParams = new Set<string>();

  steps.push({
    id: "s1_open",
    action: "navigate",
    effect: "observation",
    risk: "safe",
    timeoutMs: 15_000,
    maxAttempts: 1,
    onError: "fail",
    postcondition: openingCheckpoint(acted[0]!.before),
  });

  let n = 1;
  for (const entry of acted) {
    n += 1;
    const rawTarget = entry.target!.ladder;
    const target = parameteriseTarget(rawTarget, run.params, usedParams);
    const id = `s${n}_${slug(entry.action.kind, rawTarget)}`;

    switch (entry.action.kind) {
      case "fill":
      case "select": {
        const literal = entry.action.value;
        const param = paramFor(literal, run.params);
        // The loop recorded which fills wrote a credential, so this is read off the
        // trace rather than inferred from the order fields happened to be typed in.
        const credential = entry.credentialRef;

        if (param) {
          inputs[param] ??= {
            type: "string",
            required: true,
            pii: "identifier",
            description: `Supplied per invocation; typed into ${describe(target)} during discovery.`,
          };
        }

        steps.push({
          id, action: entry.action.kind, target,
          value: param
            ? { kind: "param", name: param }
            : credential
              ? { kind: "secret", ref: credential }
              : { kind: "const", value: literal },
          effect: "idempotent_write",
          risk: "safe",
          timeoutMs: 15_000,
          maxAttempts: 1,
          onError: "fail",
          // A secret's postcondition must not name the value it wrote.
          postcondition: credential
            ? { kind: "value_non_empty", target: sameControl(target) }
            : { kind: "value_equals", target: sameControl(target), value: param ? `\${inputs.${param}}` : literal },
        });
        break;
      }

      case "click": {
        const appeared = derivePostcondition(entry);
        if (!appeared) {
          throw new CompileFailed(
            `step ${id} clicked but nothing verifiable changed on screen, so no checkpoint ` +
            `could be derived. Replay would have to assume the click worked.`,
          );
        }
        steps.push({
          id, action: "click", target,
          effect: "idempotent_write",
          risk: "safe",
          timeoutMs: 20_000,
          maxAttempts: 1,
          onError: "fail",
          postcondition: appeared,
        });
        break;
      }

      case "read": {
        const name = entry.action.outputName;
        steps.push({
          id, action: "read", target,
          effect: "observation",
          risk: "safe",
          timeoutMs: 15_000,
          // Reading is safe to repeat, which matters on a page that populates late.
          maxAttempts: 3,
          onError: "fail",
          extractTo: name,
        });
        break;
      }
    }
  }

  const reads = acted.filter((t) => t.action.kind === "read");
  if (!reads.length) {
    throw new CompileFailed("the run read no values, so the capability would return nothing");
  }

  const declaredOutputs = opts.requiredOutputs ?? [];
  const outputs: Record<string, FieldSpec> = {};

  for (const r of reads) {
    const name = (r.action as { outputName: string }).outputName;
    const value = (r.extracted?.value ?? "").trim();
    const declared = declaredOutputs.find((d) => d.name === name);
    const type = declared?.type ?? (MONEY.test(value) ? "money" : "string");

    // The check that makes the model's claim of success unnecessary to trust.
    if (declared && !fits(value, declared.type)) {
      throw new CompileFailed(
        `output '${name}' was declared ${declared.type} but the run read ` +
        `${JSON.stringify(value.slice(0, 40))}, which is not a ${declared.type}. ` +
        `The step read ${describe(r.target!.ladder)} — most likely the wrong control.`,
      );
    }

    outputs[name] = {
      type, required: true, pii: "none",
      description: `Read from ${describe(r.target!.ladder)} during discovery.`,
    };
  }

  for (const d of declaredOutputs) {
    if (!(d.name in outputs)) {
      throw new CompileFailed(`declared output '${d.name}' was never read during the run`);
    }
  }

  const artifact: Capability = {
    apiVersion: "cua.capability/v1",
    kind: "Capability",
    metadata: {
      id: opts.capabilityId,
      version: "1.0.0",
      // Never born approved. Approval is a human act, and a compiler that
      // self-approves has produced a gate that never applies.
      status: "draft",
      title: opts.title,
      description: opts.description,
    },
    provenance: {
      discoveryRunId: run.evidenceDir,
      model: run.model,
      createdAt: new Date().toISOString(),
      runnerVersion: RUNNER_VERSION,
      liveLlm: true,
    },
    compatibility: {
      vendor: opts.vendor,
      product: opts.product,
      versionRange: opts.versionRange,
    },
    entry: { originAllowlist: opts.originAllowlist, path: opts.entryPath },
    signature: { inputs: withUsedParams(inputs, usedParams, run.params), outputs },
    preconditions: [openingCheckpoint(acted[0]!.before)],
    steps,
    // Deliberately empty: nothing went wrong during this run, so nothing about what
    // going wrong looks like has been observed.
    exceptions: [],
    success: {
      checkpoint: successCheckpoint(run, new Set(Object.keys(withUsedParams(inputs, usedParams, run.params)))),
      extract: reads.map((r) => ({
        output: (r.action as { outputName: string }).outputName,
        from: steps.find((s) => s.extractTo === (r.action as { outputName: string }).outputName)!.id,
      })),
      ...(opts.answer ? { answer: opts.answer } : {}),
    },
  };

  // Round-trip through the schema and its structural lint, so a compiler bug surfaces
  // here rather than at replay time.
  return parseCapability(artifact);
}

/**
 * Add an exception rule from a run that actually reached the branch.
 *
 * `verified: true` is only ever set here, because only here has the state been seen.
 */
export function probeOutcome(
  artifact: Capability,
  observed: Observation,
  rule: { id: string; code: string; class: ExceptionRule["class"]; answer?: string },
  distinguishFrom: Observation,
): Capability {
  const marker = distinguishingText(observed, distinguishFrom);
  if (!marker) {
    throw new CompileFailed(
      `the ${rule.code} state is textually indistinguishable from the success state; ` +
      `it needs a different detector than page text`,
    );
  }

  const when: Condition = {
    kind: "all",
    items: [
      { kind: "text_present", text: marker },
      ...(rule.class === "business_outcome"
        // A negative answer must not be mistaken for the positive one.
        ? [{ kind: "text_absent", text: "${inputs.accountId}" } as Condition]
        : []),
    ],
  };

  return parseCapability({
    ...artifact,
    exceptions: [
      ...artifact.exceptions,
      { id: rule.id, when, class: rule.class, code: rule.code, verified: true, ...(rule.answer ? { answer: rule.answer } : {}) },
    ],
    // Content changed, so any prior approval is void.
    metadata: { ...artifact.metadata, status: "draft", digest: undefined, approval: undefined },
  });
}

// ---------------------------------------------------------------------------

/** Inputs discovered from keystrokes, plus any that appeared inside a locator. */
function withUsedParams(
  inputs: Record<string, FieldSpec>,
  used: Set<string>,
  params: Record<string, string>,
): Record<string, FieldSpec> {
  const out = { ...inputs };
  for (const name of used) {
    out[name] ??= {
      type: "string",
      required: true,
      pii: "identifier",
      description: `Supplied per invocation; identified a control during discovery.`,
    };
  }
  // A parameter the flow never used is not part of the contract.
  for (const name of Object.keys(out)) {
    if (!(name in params)) continue;
  }
  return out;
}

function fits(value: string, type: FieldSpec["type"]): boolean {
  switch (type) {
    case "money": return MONEY.test(value);
    case "number": return /^-?[\d,]+(\.\d+)?$/.test(value);
    case "boolean": return /^(true|false|yes|no)$/i.test(value);
    case "string": return value.length > 0;
  }
}

function paramFor(literal: string, params: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(params)) if (value === literal) return name;
  return undefined;
}

/**
 * Parameterise a locator, not only a typed value.
 *
 * A live run exposed why: the model read the balance by targeting the control whose
 * *name is the account number*, so the artifact's locator contained 13122 as a
 * literal and the capability worked for exactly one account. A parameter can arrive
 * in the page as easily as it arrives in a keystroke.
 */
function parameteriseTarget(
  t: Target,
  params: Record<string, string>,
  used: Set<string>,
): Target {
  const swap = (text: string): string => {
    let out = text;
    for (const [name, value] of Object.entries(params)) {
      if (value && out.includes(value)) {
        out = out.split(value).join(`\${inputs.${name}}`);
        used.add(name);
      }
    }
    return out;
  };

  const strategies = t.strategies.map((st) => {
    switch (st.kind) {
      case "role_name": return { ...st, name: swap(st.name) };
      case "label": return { ...st, text: swap(st.text) };
      case "nearby_text": return { ...st, text: swap(st.text) };
      case "table_cell":
        return { ...st, header: swap(st.header), ...(st.rowMatch ? { rowMatch: swap(st.rowMatch) } : {}) };
      case "css": return st;
    }
  });
  return { ...t, strategies };
}

/** The same control, as its own target, for a postcondition that reads it back. */
function sameControl(t: Target): Target {
  return {
    strategies: t.strategies,
    baselineRung: t.baselineRung,
    rationale: `The control written by this step; asserts the write landed.`,
  };
}

/** A heading present on the opening screen — stable, and cheap to assert. */
function openingCheckpoint(o: Observation): Condition {
  const heading = o.nodes.find((n) => n.role === "heading" && n.name && !VOLATILE.test(n.name));
  return heading
    ? { kind: "text_present", text: heading.name }
    : { kind: "url_contains", value: new URL(o.url).pathname.split(";")[0]! };
}

/**
 * What changed that is worth asserting. Headings first, because a heading is the
 * application telling you which screen you are on; volatile text is excluded so a
 * checkpoint does not assert on a balance that moves.
 */
function derivePostcondition(entry: TraceEntry): Condition | undefined {
  if (!entry.after) return undefined;

  const beforeHeadings = new Set(headings(entry.before.nodes));
  const gained = headings(entry.after.nodes).filter((h) => !beforeHeadings.has(h));
  if (gained.length) return { kind: "text_present", text: gained[0]! };

  const text = distinguishingText(entry.after, entry.before);
  return text ? { kind: "text_present", text } : undefined;
}

function headings(nodes: AxNode[]): string[] {
  return nodes
    .filter((n) => n.role === "heading" && n.name && !VOLATILE.test(n.name))
    .map((n) => n.name);
}

/** A line present in one observation and absent from the other, stable enough to assert. */
function distinguishingText(present: Observation, absent: Observation): string | undefined {
  const other = absent.text;
  return present.text
    .split("\n")
    .map((l) => l.trim())
    .find(
      (l) =>
        l.length >= 8 && l.length <= 80 &&
        !VOLATILE.test(l) &&
        /[A-Za-z]/.test(l) &&
        !other.includes(l),
    );
}

/**
 * Success asserts both that we reached the final screen and that it concerns the
 * record we asked about — the second half is what stops "some account's balance" from
 * counting as an answer.
 */
function successCheckpoint(run: DiscoveryRun, declaredInputs: Set<string>): Condition {
  const last = run.trace.filter((t) => t.after).at(-1);
  const final = last?.after;
  const items: Condition[] = [];

  const heading = final?.nodes.find((n) => n.role === "heading" && n.name && !VOLATILE.test(n.name));
  if (heading) items.push({ kind: "text_present", text: heading.name });

  for (const [name, value] of Object.entries(run.params)) {
    // Only assert on a parameter the artifact actually declares, or the checkpoint
    // would compare against an uninterpolated placeholder.
    if (declaredInputs.has(name) && final?.text.includes(value)) {
      items.push({ kind: "text_present", text: `\${inputs.${name}}` });
    }
  }

  if (!items.length) throw new CompileFailed("no stable success condition could be derived from the final screen");
  return items.length === 1 ? items[0]! : { kind: "all", items };
}

function describe(t: Target): string {
  const s = t.strategies[0]!;
  switch (s.kind) {
    case "role_name": return `the ${s.role} named ${JSON.stringify(s.name)}`;
    case "label": return `the control labelled ${JSON.stringify(s.text)}`;
    case "nearby_text": return `the control captioned ${JSON.stringify(s.text)}`;
    case "table_cell": return `the cell under ${JSON.stringify(s.header)}`;
    case "css": return `the element matching ${s.selector}`;
  }
}

function slug(kind: string, t: Target): string {
  const s = t.strategies[0]!;
  const label =
    s.kind === "role_name" ? s.name
    : s.kind === "label" || s.kind === "nearby_text" ? s.text
    : s.kind === "table_cell" ? s.header
    : "target";
  const cleaned = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24);
  return cleaned ? `${kind}_${cleaned}` : kind;
}
