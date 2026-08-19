/**
 * Reading the contract off a natural-language goal.
 *
 * The model is stubbed here on purpose. What needs testing is not whether a model can
 * read a sentence — it can — but whether *we* refuse the things a model plausibly gets
 * wrong. Every case below is a shape a model has actually produced somewhere in this
 * project: a value that was not in the request, a sentence with this run's numbers
 * typed into it, a placeholder for a field that does not exist.
 *
 * No network, no key, no cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { planGoal, GoalUnclear } from "../src/discovery/plan.ts";
import type { Decision, Exchange, ModelClient, ToolSpec } from "../src/discovery/model.ts";

/** A model that returns exactly what it is told to, so the test controls the input. */
function stub(reply: Record<string, unknown>): ModelClient {
  return {
    id: "stub",
    decide(_system: string, _history: Exchange[]): Promise<Decision> {
      throw new Error("planGoal must not run the decision loop");
    },
    callTool(_system: string, _user: string, _tool: ToolSpec): Promise<Record<string, unknown>> {
      return Promise.resolve(reply);
    },
  };
}

const GOAL = "look up account 13122 and read its current balance";

test("a goal yields parameters, outputs, a template, and an answer", async () => {
  const plan = await planGoal(
    stub({
      thought: "one account, one balance",
      parameters: [{ name: "account_number", value: "13122" }],
      outputs: [{ name: "current_balance", type: "money" }],
      answer: "The current balance for account ${inputs.account_number} is ${outputs.current_balance}.",
    }),
    GOAL,
  );

  assert.deepEqual(plan.params, { account_number: "13122" });
  assert.deepEqual(plan.outputs, [{ name: "current_balance", type: "money" }]);
  // The template is what the artifact's title reads, so it must describe the
  // capability rather than this one invocation.
  assert.equal(plan.template, "look up account {{account_number}} and read its current balance");
  assert.match(plan.answer, /\$\{outputs\.current_balance\}/);
});

test("a parameter value the goal does not contain is refused", async () => {
  // Provenance is the whole mechanism: the compiler replaces the literal where it was
  // actually typed. A value that was never in the request cannot be traced to it, so
  // substituting it would be a guess dressed up as parameterisation.
  await assert.rejects(
    () => planGoal(
      stub({
        thought: "", parameters: [{ name: "account_number", value: "13344" }],
        outputs: [{ name: "current_balance", type: "money" }],
        answer: "Balance is ${outputs.current_balance}.",
      }),
      GOAL,
    ),
    GoalUnclear,
  );
});

// --- the answer sentence is held to the contract it describes --------------

test("an answer naming an output that does not exist is refused", async () => {
  // It would render as a visible hole in a sentence a customer may read.
  await assert.rejects(
    () => planGoal(
      stub({
        thought: "", parameters: [{ name: "account_number", value: "13122" }],
        outputs: [{ name: "current_balance", type: "money" }],
        answer: "The available amount is ${outputs.available_amount}.",
      }),
      GOAL,
    ),
    /\$\{outputs\.available_amount\}, which is not a declared output/,
  );
});

test("an answer with this run's value typed into it is refused", async () => {
  // Right once, wrong on every run after. The failure is invisible on the run that
  // produced it, which is exactly why it needs a check rather than a review.
  await assert.rejects(
    () => planGoal(
      stub({
        thought: "", parameters: [{ name: "account_number", value: "13122" }],
        outputs: [{ name: "current_balance", type: "money" }],
        answer: "The balance for account 13122 is ${outputs.current_balance}.",
      }),
      GOAL,
    ),
    /contains this run's value for 'account_number' literally/,
  );
});

test("an answer that reports none of the outputs is refused", async () => {
  await assert.rejects(
    () => planGoal(
      stub({
        thought: "", parameters: [{ name: "account_number", value: "13122" }],
        outputs: [{ name: "current_balance", type: "money" }],
        answer: "The lookup for account ${inputs.account_number} completed.",
      }),
      GOAL,
    ),
    /states no result/,
  );
});

test("a missing answer is refused when the task reports something", async () => {
  await assert.rejects(
    () => planGoal(
      stub({
        thought: "", parameters: [], outputs: [{ name: "current_balance", type: "money" }],
        answer: "",
      }),
      GOAL,
    ),
    /no answer sentence was proposed/,
  );
});

test("a task that reports nothing needs no answer", async () => {
  const plan = await planGoal(
    stub({ thought: "", parameters: [], outputs: [], answer: "" }),
    "log out of the servicing console",
  );
  assert.equal(plan.answer, "");
  assert.deepEqual(plan.outputs, []);
});
