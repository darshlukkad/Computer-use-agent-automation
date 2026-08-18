/**
 * The model seam. One key, either provider.
 *
 * Only discovery imports this. An architecture test walks the import graph from the
 * replay engine and fails if any model SDK is reachable from it — the claim that
 * production runs cost nothing per invocation is a boundary claim, and boundaries
 * erode one convenient import at a time.
 *
 * A manual loop rather than the SDK's tool runner, deliberately: the runner executes
 * tools for you, and we need to snapshot the page before and after every action (for
 * evidence, and to derive checkpoints by diffing), plus run a policy check between
 * the decision and the act. Those hooks do not exist inside `run()`.
 */

/** A control as the model refers to it — the same vocabulary an Observation uses. */
export interface ModelTarget {
  role: string;
  /** Accessible name, when the app provides one. */
  name?: string;
  /** The visible caption, for controls the app left unnamed. */
  nearbyText?: string;
}

/** The closed action vocabulary. The model can emit nothing else. */
export type ModelAction =
  | { kind: "click"; target: ModelTarget }
  | { kind: "fill"; target: ModelTarget; value: string }
  | { kind: "select"; target: ModelTarget; value: string }
  | { kind: "read"; target: ModelTarget; outputName: string }
  | { kind: "done"; summary: string }
  | { kind: "stuck"; reason: string };

export interface Decision {
  /** The model's stated reason. Recorded as evidence, never executed. */
  thought: string;
  action: ModelAction;
}

export interface Exchange {
  role: "user" | "assistant";
  text: string;
}

export interface ModelClient {
  /** Provider and model id, recorded in artifact provenance. */
  readonly id: string;
  decide(system: string, history: Exchange[]): Promise<Decision>;
}

// ---------------------------------------------------------------------------
// The action schema, shared by both providers
// ---------------------------------------------------------------------------

const TARGET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    role: { type: "string", description: "The control's role, exactly as the observation lists it." },
    name: { type: "string", description: "Its accessible name, if the observation shows one." },
    nearbyText: { type: "string", description: "Its nearbyText, for controls with an empty name." },
  },
  required: ["role"],
} as const;

interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

const obj = (
  props: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties: { thought: { type: "string", description: "Why this action, in one sentence." }, ...props },
  required: ["thought", ...required],
});

const TOOLS: ToolSpec[] = [
  { name: "click", description: "Click a control.", schema: obj({ target: TARGET_SCHEMA }, ["target"]) },
  {
    name: "fill",
    description: "Type a value into a text field.",
    schema: obj({ target: TARGET_SCHEMA, value: { type: "string" } }, ["target", "value"]),
  },
  {
    name: "select",
    description: "Choose an option in a dropdown.",
    schema: obj({ target: TARGET_SCHEMA, value: { type: "string" } }, ["target", "value"]),
  },
  {
    name: "read",
    description: "Record a value shown on screen as an output of this task.",
    schema: obj(
      {
        target: TARGET_SCHEMA,
        outputName: { type: "string", description: "A short snake_case name for this value." },
      },
      ["target", "outputName"],
    ),
  },
  {
    name: "done",
    description: "The goal is achieved and every value it asked for has been read.",
    schema: obj({ summary: { type: "string" } }, ["summary"]),
  },
  {
    name: "stuck",
    description: "No available control makes progress toward the goal.",
    schema: obj({ reason: { type: "string" } }, ["reason"]),
  },
];

function toAction(name: string, input: Record<string, unknown>): ModelAction {
  const target = input.target as ModelTarget;
  switch (name) {
    case "click": return { kind: "click", target };
    case "fill": return { kind: "fill", target, value: String(input.value ?? "") };
    case "select": return { kind: "select", target, value: String(input.value ?? "") };
    case "read": return { kind: "read", target, outputName: String(input.outputName ?? "value") };
    case "done": return { kind: "done", summary: String(input.summary ?? "") };
    case "stuck": return { kind: "stuck", reason: String(input.reason ?? "") };
    default: throw new Error(`model chose an unknown action '${name}'`);
  }
}

export class ModelRefused extends Error {}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

class AnthropicClient implements ModelClient {
  readonly id: string;
  // Typed as unknown to keep this module free of a hard dependency on either SDK's
  // types; the shape is exercised by the live discovery run.
  private client: { messages: { create(body: unknown): Promise<AnthropicResponse> } };

  constructor(sdk: new (o: { apiKey: string }) => unknown, apiKey: string, model: string) {
    this.client = new sdk({ apiKey }) as never;
    this.id = `anthropic:${model}`;
    this.model = model;
  }
  private model: string;

  async decide(system: string, history: Exchange[]): Promise<Decision> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      // Deciding one UI action is a small judgement; medium effort keeps a
      // ten-turn loop affordable without making it careless.
      output_config: { effort: "medium" },
      tool_choice: { type: "any" },
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
        strict: true,
      })),
      messages: history.map((h) => ({ role: h.role, content: h.text })),
    });

    if (response.stop_reason === "refusal") {
      throw new ModelRefused(`model declined: ${response.stop_details?.category ?? "unknown"}`);
    }
    const call = response.content.find((b) => b.type === "tool_use");
    if (!call) throw new Error(`model returned no action (stop_reason=${response.stop_reason})`);

    const input = call.input as Record<string, unknown>;
    return { thought: String(input.thought ?? ""), action: toAction(call.name, input) };
  }
}

interface AnthropicResponse {
  stop_reason: string;
  stop_details?: { category?: string } | null;
  content: Array<{ type: string; name: string; input: unknown }>;
}

class OpenAIClient implements ModelClient {
  readonly id: string;
  private client: {
    chat: { completions: { create(body: unknown): Promise<OpenAIResponse> } };
  };
  private model: string;

  constructor(sdk: new (o: { apiKey: string }) => unknown, apiKey: string, model: string) {
    this.client = new sdk({ apiKey }) as never;
    this.id = `openai:${model}`;
    this.model = model;
  }

  async decide(system: string, history: Exchange[]): Promise<Decision> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      tool_choice: "required",
      tools: TOOLS.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.schema, strict: true },
      })),
      messages: [
        { role: "system", content: system },
        ...history.map((h) => ({ role: h.role, content: h.text })),
      ],
    });

    const call = response.choices[0]?.message?.tool_calls?.[0];
    if (!call) throw new Error("model returned no action");
    const input = JSON.parse(call.function.arguments) as Record<string, unknown>;
    return { thought: String(input.thought ?? ""), action: toAction(call.function.name, input) };
  }
}

interface OpenAIResponse {
  choices: Array<{
    message?: { tool_calls?: Array<{ function: { name: string; arguments: string } }> };
  }>;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = { anthropic: "claude-opus-5", openai: "gpt-5" } as const;

/**
 * Provider is inferred from the key prefix and can be forced with LLM_PROVIDER.
 * SDKs are imported lazily so that neither is loaded — nor required to be
 * installed — unless a discovery run actually happens.
 */
export async function modelFromEnv(): Promise<ModelClient> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LLM_API_KEY is not set. Discovery needs a model; replay does not. " +
      "Copy .env.example to .env and add a key from either provider.",
    );
  }

  const provider =
    (process.env.LLM_PROVIDER as "anthropic" | "openai" | undefined) ??
    (apiKey.startsWith("sk-ant-") ? "anthropic" : "openai");
  const model = process.env.LLM_MODEL ?? DEFAULT_MODEL[provider];

  if (provider === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    return new AnthropicClient(Anthropic as never, apiKey, model);
  }
  const { default: OpenAI } = await import("openai");
  return new OpenAIClient(OpenAI as never, apiKey, model);
}
