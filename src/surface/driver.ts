/**
 * The seam. Everything above this line is surface-agnostic.
 *
 * Only implementations of this interface may know what a browser is. The artifact
 * schema, the replay engine, the classifier, policy, and the discovery loop are all
 * Playwright-free — `grep -r playwright src/` should only ever hit src/surface/web/.
 *
 * That is what makes the desktop story structural rather than aspirational: a
 * Windows driver populates the same Observation from UI Automation, and nothing
 * upstream changes.
 */
import type { LocatorStrategy, Target } from "../artifact/schema.ts";

/**
 * One control as a human would perceive it.
 *
 * `name` is the accessible name computed per spec — which on a legacy app is very
 * often empty. That emptiness is honest and important: it is why the ladder exists.
 * `nearbyText` carries what a human uses instead when the name is missing (the bold
 * caption sitting above an unlabelled field), so an unnamed control is still
 * identifiable to the model during discovery.
 */
export interface AxNode {
  role: string;
  name: string;
  value?: string;
  /** Nearest preceding visible text. Populated only when `name` is empty. */
  nearbyText?: string;
  /** For a cell in a headed table: the header of its column. */
  columnHeader?: string;
  /** For a cell in a table: the leading cell of its row, which identifies the record. */
  rowLabel?: string;
  /**
   * For a dropdown: what can be chosen, capped.
   *
   * A combobox whose options are unknown cannot be used — the caller has to guess a
   * value and hope. Reporting them also removes the option text from the page-text
   * dump, where it otherwise appeared once per dropdown as unattributed lines.
   */
  options?: string[];
  /** Frame name or url; legacy apps put real content inside framesets. */
  frame?: string;
}

/** A single perception snapshot. Contains no browser types by design. */
export interface Observation {
  url: string;
  title: string;
  nodes: AxNode[];
  /** Visible text, truncated and redacted. */
  text: string;
  /** Open interstitials — the thing that derails an unattended replay. */
  dialogs: string[];
}

/** Which rung answered, so drift can be measured against the recorded baseline. */
export interface Resolution {
  /** 1-based index into the target's ladder. */
  rung: number;
  strategy: LocatorStrategy;
  /** How many elements this rung matched. Acting requires exactly 1. */
  matchCount: number;
}

export type ActRequest =
  | { action: "navigate"; url: string }
  | { action: "click"; target: Target }
  | { action: "fill"; target: Target; value: string }
  | { action: "select"; target: Target; value: string };

/** Ladder exhausted — no rung matched anything. */
export class TargetMissing extends Error {
  constructor(readonly tried: string[]) {
    super(`no rung matched. tried: ${tried.join(" -> ")}`);
  }
}

/**
 * More than one match. We refuse rather than taking `.first()`.
 *
 * Guessing here is how automation clicks the wrong row of a payments table. An
 * ambiguous target is a defect in the artifact, and it should surface as one.
 */
export class TargetAmbiguous extends Error {
  constructor(readonly rung: number, readonly count: number) {
    super(`rung ${rung} matched ${count} elements; refusing to guess`);
  }
}

export interface SurfaceDriver {
  readonly surface: string;

  observe(): Promise<Observation>;
  url(): Promise<string>;

  /**
   * Walk the ladder and return the first rung matching exactly one element.
   * Throws TargetMissing or TargetAmbiguous — never picks arbitrarily.
   */
  resolve(target: Target): Promise<Resolution>;

  /**
   * Match count at the first rung that matches anything. Unlike resolve(), many
   * matches is legitimate here: "wait until this table has at least one row".
   */
  count(target: Target): Promise<number>;

  readText(target: Target): Promise<string>;
  readValue(target: Target): Promise<string>;

  act(request: ActRequest): Promise<void>;
  screenshot(path: string): Promise<void>;

  /**
   * Discard authentication state so the next run starts from the same place the
   * last one did.
   *
   * Not an optimisation but a determinism requirement: a capability whose entry
   * precondition is "the login page is showing" cannot satisfy it against a browser
   * that is already signed in. Reusing a session would make the second replay of
   * identical inputs take a different path from the first.
   */
  clearSession(): Promise<void>;

  close(): Promise<void>;
}