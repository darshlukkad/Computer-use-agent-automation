/**
 * The typed boundary between a calling agent and a browser.
 *
 * Inputs are validated before anything opens, because rejecting a malformed
 * account number in microseconds beats discovering it three screens deep. Outputs
 * are validated on the way out, so a caller promised `money` gets money or gets a
 * failure — never a surprise `undefined`.
 */
import type { Capability, FieldSpec, Money } from "../artifact/schema.ts";

export class ValueError extends Error {}

/** Parsed to integer minor units. Float dollars drift by a cent per thousand rows. */
export function parseMoney(text: string, currency = "USD"): Money {
  const cleaned = text.replace(/\s/g, "");
  // Sign may lead the amount or the symbol: "-$1,234.56" and "$-1,234.56" both occur.
  const negative = /^-|\(-?[^)]*\)$/.test(cleaned) || cleaned.includes("$-");
  const digits = cleaned.match(/(\d[\d,]*)(?:\.(\d{1,2}))?/);
  if (!digits) throw new ValueError(`not a monetary amount: ${JSON.stringify(text)}`);

  const whole = digits[1]!.replace(/,/g, "");
  const frac = (digits[2] ?? "").padEnd(2, "0");
  // String arithmetic on purpose — 1234.56 * 100 is 123455.99999999999.
  const minorUnits = Number(whole) * 100 + Number(frac);
  return { currency, minorUnits: negative ? -minorUnits : minorUnits };
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

export function formatMoney(m: Money): string {
  const sign = m.minorUnits < 0 ? "-" : "";
  const abs = Math.abs(m.minorUnits);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const cents = String(abs % 100).padStart(2, "0");
  const symbol = SYMBOL[m.currency];
  return symbol
    ? `${sign}${symbol}${whole}.${cents}`
    : `${sign}${whole}.${cents} ${m.currency}`;
}

function isMoney(v: unknown): v is Money {
  return typeof v === "object" && v !== null && "minorUnits" in v && "currency" in v;
}

function display(v: unknown): string {
  if (isMoney(v)) return formatMoney(v);
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Render an answer template. Only `${inputs.*}` and `${outputs.*}` are substituted;
 * an unknown reference is left visible rather than silently becoming "undefined",
 * so a broken template shows up in review instead of shipping a sentence with a
 * hole in it.
 */
export function renderAnswer(
  template: string,
  scope: { inputs: Record<string, string>; outputs?: Record<string, unknown> },
): string {
  return template.replace(
    /\$\{(inputs|outputs)\.([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (whole, bucket: string, key: string) => {
      const source = bucket === "inputs" ? scope.inputs : scope.outputs ?? {};
      return key in source ? display(source[key]) : whole;
    },
  );
}

/**
 * Mask values of fields the artifact tagged as regulated before an answer is
 * written to disk. The caller gets the real sentence; the evidence file gets a
 * fingerprint, so a run stays debuggable without persisting an account number.
 *
 * This is what makes the `pii` tags load-bearing rather than decorative.
 */
export function redactAnswer(
  answer: string,
  inputs: Record<string, string>,
  spec: Record<string, { pii?: string }>,
): string {
  let out = answer;
  for (const [name, value] of Object.entries(inputs)) {
    const pii = spec[name]?.pii;
    if (!value || pii === "none" || pii === undefined) continue;
    out = out.split(value).join(`[${name}:redacted]`);
  }
  return out;
}

/** Values enter the browser as strings; this is the sole conversion point. */
export function validateInputs(
  spec: Capability["signature"]["inputs"],
  supplied: Record<string, string>,
): Record<string, string> {
  const unknown = Object.keys(supplied).filter((k) => !(k in spec));
  if (unknown.length) {
    throw new ValueError(`unknown input(s): ${unknown.join(", ")}`);
  }

  const out: Record<string, string> = {};
  for (const [name, field] of Object.entries(spec)) {
    const value = supplied[name];
    if (value === undefined || value === "") {
      if (field.required) throw new ValueError(`missing required input '${name}'`);
      continue;
    }
    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      // The value itself is withheld — an input tagged `identifier` is regulated data.
      throw new ValueError(`input '${name}' does not match ${field.pattern}`);
    }
    if (field.type === "number" && !/^-?\d+(\.\d+)?$/.test(value)) {
      throw new ValueError(`input '${name}' is not a number`);
    }
    out[name] = value;
  }
  return out;
}

/** Coerce one extracted string into its declared output type. */
export function coerceOutput(name: string, field: FieldSpec, raw: string): unknown {
  const text = raw.trim();
  if (!text) throw new ValueError(`output '${name}' extracted nothing`);

  switch (field.type) {
    case "money": return parseMoney(text);
    case "number": {
      const n = Number(text.replace(/,/g, ""));
      if (!Number.isFinite(n)) throw new ValueError(`output '${name}' is not a number: ${text}`);
      return n;
    }
    case "boolean": return /^(true|yes|y|1)$/i.test(text);
    case "string": return text;
  }
}

export function validateOutputs(
  spec: Capability["signature"]["outputs"],
  extracted: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(spec)) {
    const raw = extracted[name];
    if (raw === undefined) {
      if (field.required) throw new ValueError(`declared output '${name}' was never extracted`);
      continue;
    }
    out[name] = coerceOutput(name, field, raw);
  }
  return out;
}

/**
 * Credentials are a runtime binding, never a capability input.
 *
 * Three reasons they are not part of `signature.inputs`:
 *
 *   - §3.4 forbids persisting credentials. An input flows into shell history, the
 *     result contract, logs and evidence; the leak then has to be fought in every
 *     one of those places instead of never existing.
 *   - The calling agent should not hold the institution's operator password. A
 *     prompt injection that reaches an agent holding only `accountId` can misuse a
 *     bounded action set; one that reaches an agent holding credentials has full
 *     operator access.
 *   - Declaring "this flow needs an operator credential" and deciding *which*
 *     credential are different jobs with different review paths.
 *
 * The artifact names a LOGICAL ROLE, never an environment variable or an
 * institution. `operator_password` resolves per tenant, so one approved artifact
 * serves every tenant running the same vendor product. Baking `SUMMIT_PASSWORD`
 * into the artifact would mean editing it per tenant — changing its content,
 * invalidating its digest, and forcing re-approval for what is purely deployment
 * configuration.
 */
export function resolveSecret(ref: string, tenant?: string | null): string {
  const logical = ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const candidates = tenant
    ? [`${tenant.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${logical}`, logical]
    : [logical];

  for (const name of candidates) {
    const value = process.env[name];
    if (value) return value;
  }
  // Names the variables it looked for, never a value.
  throw new ValueError(
    `credential '${ref}' is unbound; set one of: ${candidates.join(", ")}`,
  );
}
