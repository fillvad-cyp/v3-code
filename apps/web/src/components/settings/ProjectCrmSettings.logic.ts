import { errorDisplayMessage, thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AuthSessionState,
  type CrmClient,
  type CrmClientStatus,
  type ExecutionEnvironmentCapabilities,
  type MemberWithMemberships,
  type ProjectId,
  type ProjectRole,
  boundProjectRole,
  roleHasCapability,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { isSessionOwner } from "./MembersSettings.logic";

export const CRM_STATUS_OPTIONS = ["lead", "active", "inactive", "archived"] as const;

export const CRM_STATUS_LABELS = {
  lead: msg("Lead", { $context: "CRM client status" }),
  active: msg("Active", { $context: "CRM client status" }),
  inactive: msg("Inactive", { $context: "CRM client status" }),
  archived: msg("Archived", { $context: "CRM client status" }),
} as const satisfies Record<CrmClientStatus, ReturnType<typeof msg>>;

export function supportsCrmCapability(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
): boolean {
  return capabilities?.crm === true || capabilities?.members === true;
}

export interface ProjectCrmPermissions {
  readonly isOwner: boolean;
  readonly isExternal: boolean;
  readonly actorRole: ProjectRole | undefined;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canInvite: boolean;
}

function resolveActorProjectRole(input: {
  readonly session: AuthSessionState | null;
  readonly projectId: ProjectId;
  readonly members: ReadonlyArray<MemberWithMemberships>;
}): ProjectRole | undefined {
  const { session, projectId, members } = input;
  if (!session?.authenticated) return undefined;
  if (isSessionOwner(session)) return "owner";
  if (session.binding?._tag === "projects") {
    return boundProjectRole(session.binding, projectId);
  }
  const principalId = session.principal?.id;
  if (principalId !== undefined) {
    const self = members.find((entry) => entry.principal.id === principalId);
    const membership = self?.memberships.find(
      (entry) => entry.projectId === projectId && entry.state === "active",
    );
    if (membership !== undefined) return membership.role;
  }
  return session.role;
}

export function deriveProjectCrmPermissions(input: {
  readonly session: AuthSessionState | null;
  readonly canReadScope: boolean;
  readonly canOperateScope: boolean;
  readonly projectId: ProjectId;
  readonly members: ReadonlyArray<MemberWithMemberships>;
}): ProjectCrmPermissions {
  const isOwner = isSessionOwner(input.session);
  const isExternal = !isOwner && input.session?.principal?.kind === "external";
  const actorRole = resolveActorProjectRole(input);
  const canRead =
    input.canReadScope &&
    (isOwner || (actorRole !== undefined && roleHasCapability(actorRole, "project:crm.read")));
  const canWrite =
    !isExternal &&
    input.canOperateScope &&
    (isOwner || (actorRole !== undefined && roleHasCapability(actorRole, "project:crm.write")));
  const canInvite =
    !isExternal &&
    input.canOperateScope &&
    (isOwner ||
      (actorRole !== undefined && roleHasCapability(actorRole, "project:crm.invite_client")));
  return {
    isOwner,
    isExternal,
    actorRole,
    canRead,
    canWrite,
    canInvite,
  };
}

export function sortCrmClients(clients: ReadonlyArray<CrmClient>): ReadonlyArray<CrmClient> {
  return [...clients].sort((left, right) => {
    const leftRedacted = left.redactedAt !== null ? 1 : 0;
    const rightRedacted = right.redactedAt !== null ? 1 : 0;
    if (leftRedacted !== rightRedacted) return leftRedacted - rightRedacted;
    return left.name.localeCompare(right.name);
  });
}

export function formatCrmErrorMessage(error: unknown, resolve: MessageResolver = m): string {
  const message =
    errorDisplayMessage(error, resolve) ??
    thrownErrorMessage(error, resolve) ??
    resolve(msg("CRM request failed. Try again."));
  const lowered = message.toLowerCase();
  if (lowered.includes("project:crm.") || lowered.includes("forbidden")) {
    return resolve(msg("You do not have permission to perform this CRM action on this project."));
  }
  if (lowered.includes("not found") || lowered.includes("resource_not_found")) {
    return resolve(msg("The requested CRM record was not found in this project."));
  }
  if (lowered.includes("purged") || lowered.includes("redacted")) {
    return resolve(msg("This client record has been purged and can no longer be edited."));
  }
  return message;
}

export function downloadJsonlFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "application/x-ndjson;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
