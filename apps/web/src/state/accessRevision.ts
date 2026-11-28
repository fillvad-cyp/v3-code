import { type EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { authEnvironment } from "./auth";
import { useEnvironmentQuery } from "./query";
import { environmentSession, useEnvironmentSessionState } from "./session";

export interface AccessRevisionAdvanceResult {
  readonly nextRevision: number | null;
  readonly refreshSession: boolean;
  readonly refreshMembers: boolean;
}

/**
 * Pure monotonic high-water-mark transition for an environment's access revision.
 * Initial observation seeds the baseline without triggering an extra refetch; any strict
 * advance triggers member (and, when observed via the access stream, session) refresh.
 */
export function advanceAccessRevision(
  lastSeen: number | null,
  input: {
    readonly snapshotRevision: number | undefined;
    readonly sessionRevision: number | undefined;
  },
): AccessRevisionAdvanceResult {
  let next = lastSeen;
  let refreshSession = false;
  let refreshMembers = false;

  if (input.snapshotRevision !== undefined) {
    if (next !== null && input.snapshotRevision > next) {
      refreshSession = true;
      refreshMembers = true;
    }
    next = next === null ? input.snapshotRevision : Math.max(next, input.snapshotRevision);
  }

  if (input.sessionRevision !== undefined) {
    if (next !== null && input.sessionRevision > next) {
      refreshMembers = true;
    }
    next = next === null ? input.sessionRevision : Math.max(next, input.sessionRevision);
  }

  return { nextRevision: next, refreshSession, refreshMembers };
}

// Keyed by environment so multiple mounted subscribers (coordinator + settings panels)
// do not trigger duplicate refetches for the same revision bump.
const lastSeenRevisionByEnvironment = new Map<EnvironmentId, number>();

export function useSyncAccessRevision(environmentId: EnvironmentId | null, enabled: boolean): void {
  const accessChanges = useEnvironmentQuery(
    enabled && environmentId !== null
      ? authEnvironment.accessChanges({ environmentId, input: null })
      : null,
  );
  const session = useEnvironmentSessionState(enabled ? environmentId : null);

  const snapshotRevision =
    accessChanges.data?.type === "snapshot" ? accessChanges.data.payload.revision : undefined;
  const sessionRevision = session.data?.authenticated ? session.data.accessRevision : undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes session and member queries when the server access revision advances
  useEffect(() => {
    if (!enabled || environmentId === null) return;
    const previous = lastSeenRevisionByEnvironment.get(environmentId) ?? null;
    const { nextRevision, refreshSession, refreshMembers } = advanceAccessRevision(previous, {
      snapshotRevision,
      sessionRevision,
    });
    if (nextRevision !== null) {
      lastSeenRevisionByEnvironment.set(environmentId, nextRevision);
    }
    if (refreshSession) {
      appAtomRegistry.refresh(environmentSession.sessionStateAtom(environmentId));
    }
    if (refreshMembers) {
      appAtomRegistry.refresh(authEnvironment.listMembers({ environmentId, input: null }));
    }
  }, [enabled, environmentId, sessionRevision, snapshotRevision]);
}
