/**
 * Loader for the code that runs inside the target page.
 *
 * The page code itself lives in `page-scripts.js` as ordinary JavaScript, read here as
 * text and injected. It is not imported, because it never runs in this process.
 *
 * Why a separate file rather than a function or a template literal, both of which were
 * tried and both of which failed:
 *
 *   `String(fn)` on a TypeScript function ships a reference to esbuild's `__name`
 *   helper (tsx enables keepNames), which does not exist in the page — ReferenceError
 *   on evaluate.
 *
 *   A template literal in a .ts file loses type checking and syntax highlighting and
 *   needs every backslash doubled. Two real bugs came from exactly that: a regex
 *   silently became /s+/ instead of /\s+/, and a backtick inside a comment terminated
 *   the literal.
 *
 * As a plain file it is reviewable code that no build step touches.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `__dirname` is undefined in ES modules; derive the location from the module URL so
// the script is found regardless of the process's working directory.
const SCRIPTS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "page-scripts.js"),
  "utf8",
);

/**
 * An expression that evaluates to a call of one of the page functions.
 *
 * The whole script is included each time so the helpers the target function depends on
 * are in scope; it is a few kilobytes and evaluated in a throwaway scope.
 */
function callInPage(expression: string): string {
  return `(() => { ${SCRIPTS}\n return ${expression}; })()`;
}

/** AxNode[] — the accessibility view of the screen. */
export const harvestExpr = (maxNodes: number): string =>
  callInPage(`harvest(${maxNodes})`);

/** string[] — text of any open interstitial. */
export const dialogsExpr = (): string => callInPage("dialogs()");

/** string[] — unique CSS paths of controls a visible caption is labelling. */
export const nearbyExpr = (caption: string, axis: "preceding" | "following"): string =>
  callInPage(`nearby(${JSON.stringify(caption)}, ${JSON.stringify(axis)})`);
