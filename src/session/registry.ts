/**
 * Who is driving, and which browser.
 *
 * §3.6 asks for two things that sound like one: the human must operate *the same live
 * session the automation was using — not a fresh one*, and there must be a way to know
 * **who is (or should be) in control**. Spawning a second browser for the operator is
 * the obvious shortcut, and it is the thing the clause is written to catch: a second
 * browser has none of the session state, so the human logs in again and is looking at
 * a different reality from the one the run got stuck in.
 *
 * So the browser cannot belong to the agent process. It belongs to a session, the
 * session outlives any single run, and the record here is what makes control transfer
 * an explicit state change rather than an implicit one. A file per session, for the
 * same reason capabilities are files: `cat` is a debugger everyone already has.
 *
 * A session record holds no page contents and no observation — those are evidence and
 * live under the run that produced them. This is only custody.
 *
 * The one piece of regulated data it does hold is the paused run's own inputs, under
 * `pending`. A run cannot be resumed without them, and making the operator retype an
 * account number defeats the handoff. Retention is bounded by the pause: `pending` is
 * cleared the moment the run finishes, the file is machine-local and git-ignored, and
 * it goes when the session does.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_DIR = "sessions";

/** One period of custody. Appended to, never rewritten, so the history is the audit. */
export interface ActorTurn {
  /** "automation", or however the operator identified themselves. */
  actor: string;
  role: "automation" | "human";
  took: string;
  released?: string;
  /**
   * A digest of the screen at the moment control changed hands, either side.
   *
   * This is what makes "record what the human did" more than a note they typed: a
   * handback whose digest equals its takeover digest is a handback where nothing
   * happened, and the run must not be resumed into the same blocker.
   *
   * A digest rather than the screen itself. The first version stored the raw
   * fingerprint and every custody entry became a full copy of the page, account table
   * and all — in a file that is not evidence and never passes through the masker.
   * Equality is the only question asked here, and a hash answers it.
   */
  fingerprintBefore?: string;
  fingerprintAfter?: string;
  /** What the operator said they did. Their words, never treated as evidence. */
  note?: string;
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  /**
   * CDP endpoint of the browser this session owns.
   *
   * Chosen over Playwright's own `launchServer` after testing both: a second process
   * calling `chromium.connect()` gets an isolated view — `browser.contexts()` is empty,
   * so it cannot reach the page the automation was using, which is exactly the failure
   * §3.6 is about. `connectOverCDP` attaches to the running browser and returns its
   * existing context and page, and closing that connection detaches without killing
   * the browser. Both behaviours were verified before this was built on them.
   */
  cdpEndpoint: string;
  /** The process holding the browser open. Informational; liveness is by connection. */
  pid: number | null;
  owner: "automation" | "human";
  /** Set while a run is paused waiting for a person. */
  pending: {
    capabilityId: string;
    interventionId: string;
    /** Where to resume from — never earlier than this, whatever the page now says. */
    stepId: string | null;
    stepIndex: number;
    reason: string;
    inputs: Record<string, string>;
    tenant: string | null;
    evidenceDir: string;
  } | null;
  actors: ActorTurn[];
}

export class SessionUnknown extends Error {}

const path = (id: string): string => join(SESSION_DIR, `${id}.json`);

export function sessionExists(id: string): boolean {
  return existsSync(path(id));
}

export function readSession(id: string): SessionRecord {
  if (!sessionExists(id)) {
    const known = listSessions().map((s) => s.id);
    throw new SessionUnknown(`no session '${id}'. known: ${known.join(", ") || "(none)"}`);
  }
  return JSON.parse(readFileSync(path(id), "utf8")) as SessionRecord;
}

export function writeSession(record: SessionRecord): void {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(path(record.id), `${JSON.stringify(record, null, 2)}\n`);
}

export function listSessions(): SessionRecord[] {
  if (!existsSync(SESSION_DIR)) return [];
  return readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(SESSION_DIR, f), "utf8")) as SessionRecord);
}

export function createSession(id: string, cdpEndpoint: string, pid: number): SessionRecord {
  const record: SessionRecord = {
    id,
    createdAt: new Date().toISOString(),
    cdpEndpoint,
    pid,
    // The automation holds control from the start. There is no unowned state: a
    // session nobody owns is a session where two actors can both decide to act.
    owner: "automation",
    pending: null,
    actors: [{ actor: "automation", role: "automation", took: new Date().toISOString() }],
  };
  writeSession(record);
  return record;
}

/** Close the open turn and open a new one. The only way `owner` ever changes. */
export function transferControl(
  record: SessionRecord,
  to: { actor: string; role: "automation" | "human" },
  fingerprint: string | undefined,
  note?: string,
): SessionRecord {
  const now = new Date().toISOString();
  const open = record.actors.at(-1);
  if (open && !open.released) {
    open.released = now;
    open.fingerprintAfter = fingerprint;
    if (note) open.note = note;
  }
  record.actors.push({
    actor: to.actor, role: to.role, took: now, fingerprintBefore: fingerprint,
  });
  record.owner = to.role;
  writeSession(record);
  return record;
}
