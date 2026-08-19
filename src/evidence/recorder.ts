/**
 * One run, one directory, everything masked on the way out.
 *
 * Both the discovery loop and the replay engine were making their own timestamped
 * directory, appending their own JSONL, and repeating `screenshot(...).catch(() =>
 * undefined)` at every call site. That duplication is the reason redaction was only
 * ever applied to one thing — the replay answer — while the discovery trace was
 * written out with whole page observations in it, account numbers and all.
 *
 * So masking belongs at the write, not at each caller. A caller cannot forget to
 * redact something it does not know it is writing: the observation text in a trace,
 * the model's own thought, an error message quoting a field's contents. Everything
 * routed through here is masked once, on the boundary between memory and disk.
 *
 * What is deliberately NOT masked is what the caller receives. A replay returns the
 * real answer to whoever asked; only the copy that persists is masked. Redacting the
 * live result would be security theatre that breaks the product.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redacts, type Policy } from "../policy/policy.ts";

/** A value that must not reach disk, and the label that replaces it. */
export interface Masked {
  name: string;
  value: string;
}

export type Masker = (text: string) => string;

export const NO_MASK: Masker = (text) => text;

/**
 * Shortest value worth masking.
 *
 * A one- or two-character value ("1", "10") appears inside unrelated numbers, dates,
 * and ids all over a page, and replacing it everywhere would corrupt the evidence
 * into uselessness while protecting nothing — two digits are not identifying. The
 * boundary-guarded regex below handles the rest.
 */
const MIN_MASKABLE = 3;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a masked value is replaced with.
 *
 * Exported because it is readable evidence rather than a black hole: the token says
 * *which* field was here, so "this screen showed the account we asked about" remains
 * answerable from a masked observation. The outcome probe relies on exactly that.
 */
export const maskToken = (name: string): string => `[${name}:redacted]`;

/**
 * Mask by value, bounded so a value cannot match inside a longer one.
 *
 * `\b` is wrong here because these values often begin or end with punctuation — the
 * boundary before the `$` of "$100.00" does not exist, so a `\b`-anchored pattern
 * would silently never fire. Explicit lookarounds for an adjacent alphanumeric say
 * what is actually meant: account 131 must not be found inside account 13122.
 */
export function makeMasker(items: Masked[]): Masker {
  const rules = items
    .filter((i) => i.value.trim().length >= MIN_MASKABLE)
    .map((i) => ({
      re: new RegExp(`(?<![A-Za-z0-9])${escape(i.value)}(?![A-Za-z0-9])`, "g"),
      with: maskToken(i.name),
    }));
  if (!rules.length) return NO_MASK;
  return (text) => rules.reduce((out, r) => out.replace(r.re, r.with), text);
}

/**
 * The values a run must not persist, taken from the artifact's own `pii` tags and the
 * policy's list of which tags count as regulated. This is the join that makes those
 * tags do work: the artifact says what a field is, the policy says what to do about
 * it, and neither hard-codes a field name.
 */
export function maskedInputs(
  policy: Policy,
  spec: Record<string, { pii?: string }>,
  inputs: Record<string, string>,
): Masked[] {
  return Object.entries(inputs)
    .filter(([name, value]) => value && redacts(policy, spec[name]?.pii))
    .map(([name, value]) => ({ name, value }));
}

/** The minimum a recorder needs of a driver, so evidence does not depend on a surface. */
interface Screenshotter {
  screenshot(path: string): Promise<void>;
}

export class Recorder {
  readonly dir: string;
  private mask: Masker;

  constructor(root: string, prefix: string, mask: Masker = NO_MASK) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.dir = join(root, `${prefix}-${stamp}`);
    mkdirSync(this.dir, { recursive: true });
    this.mask = mask;
  }

  /**
   * Install masking once the run knows what its regulated values are.
   *
   * Needed because the first thing a replay may write is a refusal — an unapproved
   * capability is blocked before its inputs have even been validated — and that
   * refusal still has to be recorded.
   */
  setMask(mask: Masker): void {
    this.mask = mask;
  }

  file(name: string): string {
    return join(this.dir, name);
  }

  /**
   * Mask every string in the structure, before it is serialised.
   *
   * Masking the serialised JSON instead looks equivalent and is not. `JSON.stringify`
   * turns a newline into the two characters `\` and `n`, so a page whose text reads
   * "…\n13122\t$1,100.00" serialises with the letter `n` immediately before the
   * account number — and a boundary-guarded pattern correctly refuses to match it.
   * The account number then sails through onto disk.
   *
   * That is exactly what happened on the first live probe run: `result.json` came out
   * clean while `success.json` still carried the number, because one had a space
   * before the value and the other had an escape sequence. Masking the values
   * themselves has no such blind spot.
   *
   * Keys are left alone: they are structure, not data, and a masked key would change
   * the shape of a file something else has to read back.
   */
  private maskDeep(value: unknown): unknown {
    if (typeof value === "string") return this.mask(value);
    if (Array.isArray(value)) return value.map((v) => this.maskDeep(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.maskDeep(v)]),
      );
    }
    return value;
  }

  /** One JSON object per line, appended as the run goes, so a crash still leaves a trail. */
  log(event: string, data: Record<string, unknown> = {}): void {
    const line = this.maskDeep({ at: new Date().toISOString(), event, ...data });
    appendFileSync(this.file("log.jsonl"), `${JSON.stringify(line)}\n`);
  }

  write(name: string, value: unknown): void {
    writeFileSync(this.file(name), `${JSON.stringify(this.maskDeep(value), null, 2)}\n`);
  }

  /**
   * A screenshot is never worth failing a run for — it is evidence about a failure,
   * and a page that has just navigated away or crashed is exactly when it fails.
   *
   * ponytail: images are not masked, so a screenshot of a screen showing an account
   * number keeps it. Masking pixels needs OCR or element-level occlusion, neither of
   * which is a take-home's job; the text beside it is masked, and the limitation is
   * stated rather than papered over.
   */
  async snap(driver: Screenshotter, name: string): Promise<void> {
    await driver.screenshot(this.file(`${name}.png`)).catch(() => undefined);
  }
}
