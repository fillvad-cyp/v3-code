import { errorDisplayMessage, thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type MemberWithMemberships,
  type ProjectId,
  type ProjectRole,
  type ProjectSecret,
  ProjectSecretName,
  ProjectSecretSetInput,
  boundProjectRole,
  formatProjectSecretReference,
  roleHasCapability,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { isSessionOwner } from "./MembersSettings.logic";

const isValidProjectSecretName = Schema.is(ProjectSecretName);
const isValidProjectSecretInput = Schema.is(ProjectSecretSetInput);

export function supportsProjectSecretsCapability(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
): boolean {
  return capabilities?.projectSecrets === true;
}

export interface ProjectSecretsPermissions {
  readonly isOwner: boolean;
  readonly actorRole: ProjectRole | undefined;
  readonly canManage: boolean;
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
  return undefined;
}

export function deriveProjectSecretsPermissions(input: {
  readonly session: AuthSessionState | null;
  readonly canManageProviders: boolean;
  readonly projectId: ProjectId;
  readonly members: ReadonlyArray<MemberWithMemberships>;
}): ProjectSecretsPermissions {
  const isOwner = isSessionOwner(input.session);
  const actorRole = resolveActorProjectRole(input);
  const canManage =
    input.canManageProviders &&
    (isOwner || (actorRole !== undefined && roleHasCapability(actorRole, "project:secrets")));
  return {
    isOwner,
    actorRole,
    canManage,
  };
}

export function sortProjectSecrets(
  secrets: ReadonlyArray<ProjectSecret>,
): ReadonlyArray<ProjectSecret> {
  return [...secrets].sort((left, right) => left.name.localeCompare(right.name));
}

export function validateProjectSecretNameInput(
  rawName: string,
  resolve: MessageResolver = m,
): string | null {
  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    return resolve(msg("Enter a secret name."));
  }
  if (!isValidProjectSecretName(trimmed)) {
    return resolve(
      msg(
        "Use letters, digits, dots, hyphens, or underscores, starting with a letter, digit, or underscore.",
      ),
    );
  }
  return null;
}

export function validateProjectSecretValueInput(
  rawValue: string,
  resolve: MessageResolver = m,
): string | null {
  if (rawValue.length === 0) {
    return resolve(msg("Enter a secret value."));
  }
  if (!isValidProjectSecretInput({ value: rawValue })) {
    return resolve(msg("Secret value is too long."));
  }
  return null;
}

export function projectSecretReferenceText(projectId: ProjectId, name: string): string {
  return formatProjectSecretReference(projectId, name);
}

export function formatProjectSecretErrorMessage(
  error: unknown,
  resolve: MessageResolver = m,
): string {
  const message =
    errorDisplayMessage(error, resolve) ??
    thrownErrorMessage(error, resolve) ??
    resolve(msg("Secret request failed. Try again."));
  const lowered = message.toLowerCase();
  if (lowered.includes("project:secrets") || lowered.includes("forbidden")) {
    return resolve(msg("You do not have permission to manage secrets for this project."));
  }
  if (lowered.includes("insufficient_scope") || lowered.includes("providers:manage")) {
    return resolve(msg("This connection does not have permission to manage project secrets."));
  }
  if (lowered.includes("not found") || lowered.includes("resource_not_found")) {
    return resolve(msg("This project or secret was not found."));
  }
  if (lowered.includes("secret name")) {
    return resolve(
      msg(
        "Use letters, digits, dots, hyphens, or underscores, starting with a letter, digit, or underscore.",
      ),
    );
  }
  return message;
}
