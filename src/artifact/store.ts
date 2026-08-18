/**
 * Artifacts on disk. A capability is a file; the registry is a directory.
 *
 * Deliberately not a database. The brief is explicit that building scaling
 * infrastructure is not rewarded, and a JSON file per capability is diffable in a
 * pull request — which is the property that makes these reviewable at all. If this
 * ever needed to become a service, this module is the only seam that changes.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCapability, type Capability } from "./schema.ts";

export const CAPABILITY_DIR = "capabilities";

export interface StoredCapability {
  path: string;
  artifact: Capability;
}

export function listCapabilities(dir = CAPABILITY_DIR): StoredCapability[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const path = join(dir, f);
      return { path, artifact: parseCapability(JSON.parse(readFileSync(path, "utf8"))) };
    });
}

/**
 * Resolved by declared id rather than by filename, so a file can be renamed
 * without changing what a calling agent asks for.
 */
export function loadCapability(id: string, dir = CAPABILITY_DIR): StoredCapability {
  const matches = listCapabilities(dir).filter((c) => c.artifact.metadata.id === id);
  if (matches.length === 0) {
    const known = listCapabilities(dir).map((c) => c.artifact.metadata.id);
    throw new Error(`no capability '${id}'. known: ${known.join(", ") || "(none)"}`);
  }
  if (matches.length > 1) {
    throw new Error(`'${id}' is declared by ${matches.length} files: ${matches.map((m) => m.path).join(", ")}`);
  }
  return matches[0]!;
}

export function saveCapability(stored: StoredCapability): void {
  writeFileSync(stored.path, `${JSON.stringify(stored.artifact, null, 2)}\n`);
}
