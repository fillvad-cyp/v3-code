// @effect-diagnostics nodeBuiltinImport:off -- Synchronous SHA-256 hashing for SQLite audit chain rows inside a transaction.
import * as NodeCrypto from "node:crypto";

import type { AuditChainVerificationResult } from "@t3tools/contracts";

export const AUDIT_CHAIN_GENESIS_HASH = "0".repeat(64);

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export interface AuditHashPayload {
  readonly at: number;
  readonly actorPrincipalId: string | null;
  readonly actorSessionId: string | null;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly projectId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly outcome: string;
  readonly metadataJson: string | null;
}

export interface AuditHashChainRow extends AuditHashPayload {
  readonly id: number;
  readonly prevHash: string | null;
  readonly eventHash: string | null;
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).toSorted()) {
      const entry = record[key];
      if (entry !== undefined) {
        sorted[key] = canonicalizeJsonValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

export function canonicalizeAuditMetadata(
  metadata: Readonly<Record<string, unknown>> | null,
): string | null {
  if (metadata === null) {
    return null;
  }
  return JSON.stringify(canonicalizeJsonValue(metadata));
}

export function computeAuditEventHash(prevHash: string, payload: AuditHashPayload): string {
  const canonical = JSON.stringify([
    payload.at,
    payload.actorPrincipalId,
    payload.actorSessionId,
    payload.action,
    payload.resourceType,
    payload.resourceId,
    payload.projectId,
    payload.ip,
    payload.userAgent,
    payload.outcome,
    payload.metadataJson,
  ]);
  return NodeCrypto.createHash("sha256")
    .update(prevHash)
    .update("\n")
    .update(canonical)
    .digest("hex");
}

export function verifyAuditHashChainRows(
  rows: ReadonlyArray<AuditHashChainRow>,
): AuditChainVerificationResult {
  if (rows.length === 0) {
    return {
      valid: true,
      checked: 0,
      firstBrokenId: null,
      reason: null,
    };
  }

  let expectedPrevHash: string | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (row.prevHash === null || row.eventHash === null) {
      return {
        valid: false,
        checked: index,
        firstBrokenId: row.id,
        reason: "missing_hash",
      };
    }
    if (index === 0) {
      if (
        (row.id === 1 && row.prevHash !== AUDIT_CHAIN_GENESIS_HASH) ||
        !SHA256_HEX_RE.test(row.prevHash)
      ) {
        return {
          valid: false,
          checked: 0,
          firstBrokenId: row.id,
          reason: "prev_hash_mismatch",
        };
      }
    } else if (row.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        checked: index,
        firstBrokenId: row.id,
        reason: "prev_hash_mismatch",
      };
    }

    const expectedEventHash = computeAuditEventHash(row.prevHash, row);
    if (row.eventHash !== expectedEventHash) {
      return {
        valid: false,
        checked: index,
        firstBrokenId: row.id,
        reason: "hash_mismatch",
      };
    }

    expectedPrevHash = row.eventHash;
  }

  return {
    valid: true,
    checked: rows.length,
    firstBrokenId: null,
    reason: null,
  };
}
