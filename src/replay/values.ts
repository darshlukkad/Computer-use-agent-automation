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

export function formatMoney(m: Money): string {
  const sign = m.minorUnits < 0 ? "-" : "";
  const abs = Math.abs(m.minorUnits);
  return `${sign}${(abs / 100).toFixed(2)} ${m.currency}`;
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
 * Secrets are resolved from the environment at the moment of use and never stored,
 * logged, or returned. The artifact carries only the variable name.
 */
export function resolveSecret(ref: string): string {
  const value = process.env[ref];
  if (!value) throw new ValueError(`secret '${ref}' is not set in the environment`);
  return value;
}
