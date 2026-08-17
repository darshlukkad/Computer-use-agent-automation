/**
 * Ladder resolution for a browser surface.
 *
 * One rule governs everything here: try rungs in order, and never guess. A rung
 * that matches nothing means try the next one; a rung that matches several means
 * stop. Taking `.first()` on an ambiguous match is how automation clicks the wrong
 * row of a payments table, and it fails silently, which is the worst way to fail.
 *
 * Each strategy below is chosen so a desktop driver could implement the same
 * instruction against OS accessibility APIs. `css` is the exception and is
 * deliberately last.
 */
import type { Frame, Locator, Page } from "playwright";
import type { LocatorStrategy, Target } from "../../artifact/schema.ts";
import { TargetAmbiguous, TargetMissing, type Resolution } from "../driver.ts";

/** Interpolate `${inputs.foo}` against the run's parameters. */
export function interpolate(text: string, inputs: Record<string, string>): string {
  return text.replace(/\$\{inputs\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key: string) =>
    key in inputs ? inputs[key]! : whole,
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact-ish name match: anchored and case-insensitive, but not a substring. */
function nameRe(name: string): RegExp {
  return new RegExp(`^\\s*${escapeRe(name)}\\s*$`, "i");
}

/** Controls a nearby-text anchor could plausibly be labelling. */
const CONTROL = "self::input or self::select or self::textarea or self::button or self::a";

function locateIn(frame: Frame, s: LocatorStrategy, inputs: Record<string, string>): Locator {
  switch (s.kind) {
    // rung 1 — desktop equivalent: UIA ControlType + Name
    case "role_name":
      return frame.getByRole(s.role as Parameters<Frame["getByRole"]>[0], {
        name: nameRe(interpolate(s.name, inputs)),
      });

    // rung 2 — desktop equivalent: UIA LabeledBy
    case "label":
      return frame.getByLabel(nameRe(interpolate(s.text, inputs)));

    // rung 3 — desktop equivalent: UIA spatial navigation.
    // The anchor text is matched on its own element, then we step to the nearest
    // control in reading order. This is what an operator does when a field has no
    // programmatic label at all.
    case "nearby_text": {
      const text = interpolate(s.text, inputs);
      const axis = s.direction === "above" || s.direction === "left" ? "preceding" : "following";
      const idx = axis === "preceding" ? "last()" : "1";
      return frame.locator(
        `xpath=//*[normalize-space(text())=${xpathLiteral(text)}]/${axis}::*[${CONTROL}][${idx}]`,
      );
    }

    // rung 4 — desktop equivalent: UIA Grid/Table pattern.
    // Column located by header text and row by content, so neither column order nor
    // row order matters. Handled outside XPath because the column index is dynamic.
    case "table_cell":
      return frame.locator("table");

    // rung 5 — no desktop equivalent. Last resort by construction.
    case "css":
      return frame.locator(s.selector);
  }
}

function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.split("'").join(`', "'", '`)}')`;
}

/**
 * table_cell needs two lookups the locator engine cannot express in one selector:
 * find the column whose header matches, then the row whose text matches.
 */
async function resolveTableCell(
  frame: Frame,
  s: Extract<LocatorStrategy, { kind: "table_cell" }>,
  inputs: Record<string, string>,
): Promise<Locator[]> {
  const header = interpolate(s.header, inputs);
  const rowMatch = s.rowMatch ? interpolate(s.rowMatch, inputs) : undefined;
  const hits: Locator[] = [];

  const tables = frame.locator("table");
  for (let t = 0; t < (await tables.count()); t++) {
    const table = tables.nth(t);
    const headers = table.locator("th");

    let col = -1;
    for (let h = 0; h < (await headers.count()); h++) {
      const text = (await headers.nth(h).innerText().catch(() => "")).trim();
      if (nameRe(header).test(text)) { col = h; break; }
    }
    if (col < 0) continue;

    const rows = table.locator("tbody tr, tr");
    for (let r = 0; r < (await rows.count()); r++) {
      const row = rows.nth(r);
      const cells = row.locator("td");
      if ((await cells.count()) <= col) continue; // header row, or a spanning footer
      if (rowMatch) {
        const rowText = await row.innerText().catch(() => "");
        if (!new RegExp(`\\b${escapeRe(rowMatch)}\\b`).test(rowText)) continue;
      }
      hits.push(cells.nth(col));
    }
  }
  return hits;
}

/** Every frame of the page. Legacy apps put real content inside framesets. */
function framesOf(page: Page): Frame[] {
  return page.frames();
}

async function visibleMatches(
  page: Page,
  s: LocatorStrategy,
  inputs: Record<string, string>,
): Promise<Locator[]> {
  const found: Locator[] = [];
  for (const frame of framesOf(page)) {
    try {
      const candidates =
        s.kind === "table_cell"
          ? await resolveTableCell(frame, s, inputs)
          : await spread(locateIn(frame, s, inputs));
      for (const c of candidates) {
        if (await c.isVisible().catch(() => false)) found.push(c);
      }
    } catch {
      // A frame can detach mid-walk; that is not an error for the ladder.
    }
  }
  return found;
}

async function spread(locator: Locator): Promise<Locator[]> {
  const n = await locator.count();
  return Array.from({ length: n }, (_, i) => locator.nth(i));
}

export interface Hit extends Resolution {
  locator: Locator;
}

function describe(s: LocatorStrategy): string {
  switch (s.kind) {
    case "role_name": return `role_name(${s.role}, "${s.name}")`;
    case "label": return `label("${s.text}")`;
    case "nearby_text": return `nearby_text("${s.text}", ${s.direction})`;
    case "table_cell": return `table_cell("${s.header}"${s.rowMatch ? `, row~"${s.rowMatch}"` : ""})`;
    case "css": return `css(${s.selector})`;
  }
}

/**
 * For acting. Returns the first rung matching exactly one visible element.
 *
 * A rung matching several stops the walk rather than falling through — a lower rung
 * happening to be unique would not make the artifact any less ambiguous, and
 * silently preferring it would hide a real defect.
 */
export async function resolveTarget(
  page: Page,
  target: Target,
  inputs: Record<string, string> = {},
): Promise<Hit> {
  const tried: string[] = [];

  for (let i = 0; i < target.strategies.length; i++) {
    const s = target.strategies[i]!;
    const matches = await visibleMatches(page, s, inputs);
    tried.push(`${describe(s)}=${matches.length}`);

    if (matches.length === 1) {
      return { rung: i + 1, strategy: s, matchCount: 1, locator: matches[0]! };
    }
    if (matches.length > 1) throw new TargetAmbiguous(i + 1, matches.length);
  }
  throw new TargetMissing(tried);
}

/**
 * For conditions. Many matches is legitimate here — "wait until this table has at
 * least one row" is a count, not a unique lookup.
 */
export async function countTarget(
  page: Page,
  target: Target,
  inputs: Record<string, string> = {},
): Promise<number> {
  for (const s of target.strategies) {
    const n = (await visibleMatches(page, s, inputs)).length;
    if (n > 0) return n;
  }
  return 0;
}
