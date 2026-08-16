/**
 * Content-addressed approval.
 *
 * `status: "approved"` is worthless if anyone can flip the field. Here approval
 * stores a SHA-256 over the artifact's canonical form, so editing an approved
 * artifact invalidates it and forces re-review. That turns the approval gate from a
 * label into something enforceable.
 *
 * Limit, stated plainly: this detects mutation, it is not a signature against a
 * malicious repository writer. Production would bind the digest to an authenticated
 * reviewer identity with a server-held key.
 */
import { createHash } from "node:crypto";
import type { Capability } from "./schema.ts";

/**
 * Key-sorted JSON so that two artifacts differing only in key order hash the same.
 * Without this, a formatter could silently invalidate every approval in the repo.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Hash over everything EXCEPT the digest and approval block, which it produces. */
export function artifactDigest(a: Capability): string {
  const { digest: _d, approval: _ap, ...metadata } = a.metadata;
  const unsigned = { ...a, metadata: { ...metadata, status: "draft" } };
  return createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}

export function approve(a: Capability, approverId: string): Capability {
  const digest = artifactDigest(a);
  return {
    ...a,
    metadata: {
      ...a.metadata,
      status: "approved",
      digest,
      approval: { digest, approverId, approvedAt: new Date().toISOString() },
    },
  };
}

export type ApprovalCheck =
  | { valid: true }
  | { valid: false; reason: string };

/** Called by replay before executing anything marked approved. */
export function verifyApproval(a: Capability): ApprovalCheck {
  if (a.metadata.status !== "approved") {
    return { valid: false, reason: `status is '${a.metadata.status}', not 'approved'` };
  }
  const { digest, approval } = a.metadata;
  if (!digest || !approval) {
    return { valid: false, reason: "marked approved but carries no digest" };
  }
  if (approval.digest !== digest) {
    return { valid: false, reason: "approval digest does not match metadata digest" };
  }
  const actual = artifactDigest(a);
  if (actual !== digest) {
    return {
      valid: false,
      reason: `content changed since approval (expected ${digest.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
    };
  }
  return { valid: true };
}

/** Record that an identifier was used without storing the identifier. */
export function fingerprint(value: string): string {
  return `fp_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}
