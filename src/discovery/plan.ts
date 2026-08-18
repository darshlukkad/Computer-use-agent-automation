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
     string  anything else, including identifiers and names
   Name them for what they are, not for the specific record: "balance", never
   "balance_for_account_13344". A task that only asks for something to be done, with
   no value reported back, has no outputs.

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
    },
    required: ["thought", "parameters", "outputs"],
  },
};

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

  return { params, outputs, template };
}
