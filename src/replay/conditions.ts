/**
 * Condition evaluation — surface-agnostic by construction.
 *
 * Conditions are evaluated here rather than inside the driver so the driver stays
 * primitive: it perceives and acts, it does not interpret the artifact. A desktop
 * driver therefore needs no condition logic of its own.
 *
 * Waiting always means "poll until this holds, or give up" — never sleep for a
 * duration. A fixed sleep is simultaneously too slow on a fast run and too short on
 * a slow one, and it turns a real failure into a flaky one.
 */
import type { Condition } from "../artifact/schema.ts";
import type { Observation, SurfaceDriver } from "../surface/driver.ts";
import { interpolate } from "../surface/web/resolve.ts";

/**
 * Caches one observation across a single evaluation so that a composite condition
 * over four text assertions does not scrape the page four times.
 */
export class EvalContext {
  private obs: Observation | null = null;

  constructor(
    readonly driver: SurfaceDriver,
    readonly inputs: Record<string, string>,
  ) {}

  async observation(): Promise<Observation> {
    this.obs ??= await this.driver.observe();
    return this.obs;
  }

  /** Call between polls; the page has moved on. */
  invalidate(): void {
    this.obs = null;
  }
}

export async function evaluate(ctx: EvalContext, c: Condition): Promise<boolean> {
  const text = (s: string): string => interpolate(s, ctx.inputs);

  switch (c.kind) {
    case "visible":
      return (await ctx.driver.count(c.target)) >= 1;

    case "text_present":
      return (await ctx.observation()).text.includes(text(c.text));

    case "text_absent":
      return !(await ctx.observation()).text.includes(text(c.text));

    case "url_contains":
      return (await ctx.driver.url()).includes(text(c.value));

    case "count_at_least":
      return (await ctx.driver.count(c.target)) >= c.n;

    case "value_equals":
      // A missing control is a false assertion, not an exception to propagate.
      return (await ctx.driver.readValue(c.target).catch(() => null)) === text(c.value);

    case "value_non_empty":
      return ((await ctx.driver.readValue(c.target).catch(() => "")) ?? "").length > 0;

    case "all": {
      for (const item of c.items) if (!(await evaluate(ctx, item))) return false;
      return true;
    }
    case "any": {
      for (const item of c.items) if (await evaluate(ctx, item)) return true;
      return false;
    }
  }
}

/** Poll until the condition holds. Returns false on timeout rather than throwing. */
export async function waitFor(
  ctx: EvalContext,
  c: Condition,
  timeoutMs: number,
  pollMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    ctx.invalidate();
    if (await evaluate(ctx, c)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Human-readable rendering, used for the `expected` half of a failure report. A
 * failure that says "postcondition failed" is not debuggable; one that says
 * `text_present("Accounts Overview")` is.
 */
export function describe(c: Condition, inputs: Record<string, string> = {}): string {
  const t = (s: string): string => interpolate(s, inputs);
  switch (c.kind) {
    case "visible": return `visible(${describeTarget(c.target)})`;
    case "text_present": return `text_present(${JSON.stringify(t(c.text))})`;
    case "text_absent": return `text_absent(${JSON.stringify(t(c.text))})`;
    case "url_contains": return `url_contains(${JSON.stringify(t(c.value))})`;
    case "count_at_least": return `count_at_least(${describeTarget(c.target)}, ${c.n})`;
    case "value_equals": return `value_equals(${describeTarget(c.target)}, ${JSON.stringify(t(c.value))})`;
    case "value_non_empty": return `value_non_empty(${describeTarget(c.target)})`;
    case "all": return `all[${c.items.map((i) => describe(i, inputs)).join(", ")}]`;
    case "any": return `any[${c.items.map((i) => describe(i, inputs)).join(", ")}]`;
  }
}

function describeTarget(t: { strategies: Array<{ kind: string }> }): string {
  return t.strategies.map((s) => s.kind).join("|");
}