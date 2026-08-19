/**
 * Reading a goal stated the way a person would state it.
 *
 * §3.1 asks for a natural-language goal plus a target, and the brief's own examples
 * put the value inline: "look up member 12345 and read their current savings
 * balance". Nothing there tells the system that 12345 is a parameter or that a
 * balance is the value wanted — so the system has to work that out.
 *
 * This is one model call before the loop starts, and it is kept separate from the
 * loop on purpose. The loop decides how to operate a screen; this decides what the
 * request actually asks for. Mixing them would mean re-deriving the contract on every
 * turn, and the contract is the thing that later checks the loop's work.
 *
 * The result is a proposal, not a verdict: it is printed for the operator, an
 * explicit --param or --output overrides it, and a value the goal does not literally
 * contain is rejected — provenance-based parameterisation depends on the value having
 * genuinely been in the request.
 */
import type { FieldSpec } from "../artifact/schema.ts";
import type { ModelClient } from "./model.ts";

export interface GoalPlan {
  /** Parameter name -> the literal value it had in this goal. */
  params: Record<string, string>;
  outputs: Array<{ name: string; type: FieldSpec["type"] }>;
  /** The goal with values replaced by placeholders, for the artifact's title. */
  template: string;
  /**
   * A sentence template reporting the result, or "" when the task reports nothing.
   *
   * Phrasing belongs to the capability rather than to the caller: an agent relaying a
   * balance to a member should not have to invent wording, and wording that lands in
   * front of a customer ought to be reviewable in the same diff as the flow that
   * produced it. It is derived here, at discovery time, and compiled in — replay
   * renders it with no model involved.
   */
  answer: string;
}

const SYSTEM = `You read a task written for a human operator of a business application
and identify its contract. You do not plan how to perform it.

Two things to extract:

1. Parameters — the concrete values in the task that would differ the next time
   someone asked for the same thing. An account number, a member id, an amount, a
   date. Give each a short snake_case name and quote its value EXACTLY as it appears
   in the task text. A value you cannot quote verbatim from the task is not a
   parameter.

   Words describing what kind of thing to look at are not parameters. In "read the
   current savings balance", "savings" is part of the task, not a value someone would
   vary per request.

2. Outputs — the values the task asks the operator to come back with, each with the
   type it will have:
     money   an amount of currency
     number  a plain numeric quantity
     boolean a yes/no state
     string  anything else, including identifiers, names, and confirmations
   Choose the type by what will be READABLE ON SCREEN, not by how the answer feels.
   A confirmation or status is shown as words — "Transfer Complete!" — so it is a
   string. Reserve boolean for a field that literally displays a yes/no value.
   Name them for what they are, not for the specific record: "balance", never
   "balance_for_account_13344". A task that only asks for something to be done, with
   no value reported back, has no outputs.

3. Answer — one sentence reporting the result, written as a template someone would be
   happy to read to a customer. Refer to every value through a \${outputs.<name>} or
   \${inputs.<name>} placeholder, using exactly the names you chose above. Put no
   literal value in it: the same sentence is used every time the task runs, with
   different values each time. Report what was found, not what was done. Leave it
   empty only when there are no outputs.

Extract nothing that is not in the task.`;

const PLAN_TOOL = {
  name: "contract",
  description: "Report the parameters and outputs of the task.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      thought: { type: "string", description: "One sentence on how you read the task." },
      parameters: {
        type: "array",
        description: "Values that would vary between invocations. May be empty.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", description: "short snake_case name" },
            value: { type: "string", description: "quoted verbatim from the task text" },
          },
          required: ["name", "value"],
        },
      },
      outputs: {
        type: "array",
        description: "Values the task asks to be reported back. May be empty.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", description: "short snake_case name" },
            type: { type: "string", enum: ["string", "money", "number", "boolean"] },
          },
          required: ["name", "type"],
        },
      },
      answer: {
        type: "string",
        description:
          "One sentence reporting the result, using ${outputs.name} and ${inputs.name} " +
          "placeholders and no literal values. Empty string if there are no outputs.",
      },
    },
    required: ["thought", "parameters", "outputs", "answer"],
  },
};

/** Every `${inputs.x}` / `${outputs.y}` a template refers to. */
function placeholders(template: string): Array<{ bucket: string; name: string }> {
  return [...template.matchAll(/\$\{(inputs|outputs)\.([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => ({
    bucket: m[1]!,
    name: m[2]!,
  }));
}

export class GoalUnclear extends Error {}

export async function planGoal(model: ModelClient, goal: string): Promise<GoalPlan> {
  const raw = await model.callTool(SYSTEM, `Task: ${goal}`, PLAN_TOOL);

  const params: Record<string, string> = {};
  let template = goal;

  for (const p of (raw.parameters ?? []) as Array<{ name: string; value: string }>) {
    const name = String(p.name ?? "").trim();
    const value = String(p.value ?? "").trim();
    if (!name || !value) continue;
    // Provenance is the whole point: a value the request did not contain cannot be
    // traced back to it, and substituting it would be a guess.
    if (!goal.includes(value)) {
      throw new GoalUnclear(
        `proposed parameter '${name}' = ${JSON.stringify(value)}, which does not appear ` +
        `in the goal text. Pass --param ${name}=<value> explicitly.`,
      );
    }
    params[name] = value;
    template = template.split(value).join(`{{${name}}}`);
  }

  const outputs = ((raw.outputs ?? []) as Array<{ name: string; type: string }>)
    .map((o) => ({ name: String(o.name ?? "").trim(), type: String(o.type ?? "string") }))
    .filter((o) => o.name)
    .map((o) => ({ name: o.name, type: o.type as FieldSpec["type"] }));

  const answer = validateAnswer(String(raw.answer ?? "").trim(), params, outputs);
  return { params, outputs, template, answer };
}

/**
 * Hold the proposed sentence to the contract it is supposed to describe.
 *
 * Two failure modes, both seen from models on other parts of this system. A
 * placeholder naming something that does not exist renders as a visible hole; a
 * sentence with the run's actual values typed into it looks perfect on the run that
 * produced it and is wrong on every run after. Neither is worth shipping into an
 * artifact a reviewer is meant to be able to trust at a glance.
 */
function validateAnswer(
  answer: string,
  params: Record<string, string>,
  outputs: Array<{ name: string }>,
): string {
  if (!answer) {
    if (outputs.length) {
      throw new GoalUnclear(
        `the task reports ${outputs.map((o) => o.name).join(", ")} but no answer sentence ` +
        `was proposed. Pass --answer '<sentence>' explicitly.`,
      );
    }
    return "";
  }

  const declared = { inputs: new Set(Object.keys(params)), outputs: new Set(outputs.map((o) => o.name)) };
  for (const { bucket, name } of placeholders(answer)) {
    const known = bucket === "inputs" ? declared.inputs : declared.outputs;
    if (!known.has(name)) {
      throw new GoalUnclear(
        `the answer sentence refers to \${${bucket}.${name}}, which is not a declared ` +
        `${bucket === "inputs" ? "parameter" : "output"}. Pass --answer '<sentence>' explicitly.`,
      );
    }
  }

  // A literal value in the template would be right once and wrong forever after.
  for (const [name, value] of Object.entries(params)) {
    if (answer.includes(value)) {
      throw new GoalUnclear(
        `the answer sentence contains this run's value for '${name}' literally, so it would ` +
        `report the same value on every future run. Pass --answer '<sentence>' explicitly.`,
      );
    }
  }

  if (outputs.length && !placeholders(answer).some((p) => p.bucket === "outputs")) {
    throw new GoalUnclear(
      `the answer sentence reports none of the task's outputs ` +
      `(${outputs.map((o) => o.name).join(", ")}), so it states no result.`,
    );
  }
  return answer;
}
