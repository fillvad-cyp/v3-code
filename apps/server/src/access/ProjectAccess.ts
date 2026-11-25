import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AuthEnvironmentScope,
  type AuthSessionId,
  PrincipalId,
  type ProjectCapability,
  ProjectForbiddenError,
  ProjectId,
  type ProjectRole,
  type SessionBinding,
  boundProjectIds,
  boundProjectRole,
  intersectScopes,
  passesProjectChecks,
  roleHasCapability,
} from "@t3tools/contracts";

import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

const isAuthEnvironmentScope = Schema.is(AuthEnvironmentScope);

const AccessResolveFailureReason = Schema.Literals([
  "principal_not_found",
  "principal_suspended",
  "principal_removed",
  "repository_error",
]);

export class AccessResolveError extends Schema.TaggedError<AccessResolveError>()(
  "AccessResolveError",
  {
    reason: AccessResolveFailureReason,
    principalId: Schema.optional(PrincipalId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "principal_not_found":
        return "The session principal no longer exists.";
      case "principal_suspended":
        return "The session principal is suspended.";
      case "principal_removed":
        return "The session principal has been removed.";
      case "repository_error":
        return "Failed to resolve access for the session principal.";
    }
  }
}

export interface AccessSessionInput {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly principalId?: PrincipalId | undefined;
  readonly binding?: SessionBinding | undefined;
}

export type AccessActor = {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly principalId?: PrincipalId;
  readonly binding?: SessionBinding;
  readonly isOwner: boolean;
  readonly ceiling?: ReadonlyArray<AuthEnvironmentScope>;
  readonly roles: ReadonlyMap<ProjectId | string, ProjectRole>;
  readonly ownedProjectIds?: ReadonlySet<string>;
};

function canActor(
  actor: AccessActor,
  projectId: ProjectId | string,
  capability: ProjectCapability,
): boolean {
  if (actor.isOwner || passesProjectChecks(actor.binding)) {
    return true;
  }
  const role =
    actor.binding?._tag === "projects"
      ? boundProjectRole(actor.binding, projectId)
      : actor.roles.get(projectId);
  return role !== undefined && roleHasCapability(role, capability);
}

export function accessibleProjectIdsForActor(actor: AccessActor): ReadonlySet<string> | undefined {
  if (actor.isOwner || passesProjectChecks(actor.binding)) {
    return undefined;
  }
  if (actor.binding?._tag === "projects") {
    return boundProjectIds(actor.binding);
  }
  const ids = new Set<string>(actor.roles.keys());
  if (actor.ownedProjectIds !== undefined) {
    for (const projectId of actor.ownedProjectIds) {
      ids.add(projectId);
    }
  }
  return ids;
}

function effectiveScopesForActor(actor: AccessActor): ReadonlyArray<AuthEnvironmentScope> {
  if (actor.isOwner || actor.ceiling === undefined) {
    return actor.scopes;
  }
  return intersectScopes(actor.scopes, actor.ceiling);
}

export class ProjectAccess extends Context.Service<
  ProjectAccess,
  {
    readonly resolve: (
      session: AccessSessionInput,
    ) => Effect.Effect<AccessActor, AccessResolveError>;
    readonly can: (
      actor: AccessActor,
      projectId: ProjectId | string,
      capability: ProjectCapability,
    ) => boolean;
    readonly accessibleProjectIds: (actor: AccessActor) => ReadonlySet<string> | undefined;
    readonly assert: (
      actor: AccessActor,
      projectId: ProjectId | string,
      capability: ProjectCapability,
    ) => Effect.Effect<void, ProjectForbiddenError>;
    readonly effectiveScopes: (actor: AccessActor) => ReadonlyArray<AuthEnvironmentScope>;
  }
>()("v3code/access/ProjectAccess") {}

const make = Effect.gen(function* () {
  const principals = yield* Principals.PrincipalRepository;
  const memberships = yield* Memberships.MembershipRepository;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const resolve = Effect.fn("ProjectAccess.resolve")(function* (session: AccessSessionInput) {
    const bindingProps = session.binding === undefined ? {} : { binding: session.binding };

    if (session.principalId === undefined) {
      if (passesProjectChecks(session.binding)) {
        return {
          sessionId: session.sessionId,
          subject: session.subject,
          scopes: session.scopes,
          ...bindingProps,
          isOwner: true,
          roles: new Map<ProjectId | string, ProjectRole>(),
        } satisfies AccessActor;
      }
      const roles =
        session.binding?._tag === "projects"
          ? new Map<ProjectId | string, ProjectRole>(
              session.binding.projects.map((entry) => [entry.projectId, entry.role]),
            )
          : new Map<ProjectId | string, ProjectRole>();
      return {
        sessionId: session.sessionId,
        subject: session.subject,
        scopes: session.scopes,
        ...bindingProps,
        isOwner: false,
        roles,
      } satisfies AccessActor;
    }

    const principalId = session.principalId;
    const maybePrincipal = yield* principals.get(principalId).pipe(
      Effect.mapError(
        (cause) =>
          new AccessResolveError({
            reason: "repository_error",
            principalId,
            cause,
          }),
      ),
    );
    if (Option.isNone(maybePrincipal)) {
      return yield* new AccessResolveError({
        reason: "principal_not_found",
        principalId,
      });
    }

    const principal = maybePrincipal.value;
    if (principal.status === "suspended") {
      return yield* new AccessResolveError({
        reason: "principal_suspended",
        principalId: principal.id,
      });
    }
    if (principal.status === "removed") {
      return yield* new AccessResolveError({
        reason: "principal_removed",
        principalId: principal.id,
      });
    }

    const isOwner = principal.kind === "owner";
    // The owner principal is ceiling-free even though its migration row stores `[]`.
    const ceiling = isOwner ? undefined : principal.ceiling.filter(isAuthEnvironmentScope);

    const roles = new Map<ProjectId | string, ProjectRole>();
    let ownedProjectIds: ReadonlySet<string> | undefined;
    if (!isOwner && !passesProjectChecks(session.binding)) {
      if (session.binding?._tag === "projects") {
        for (const entry of session.binding.projects) {
          roles.set(entry.projectId, entry.role);
        }
      } else if (session.binding?._tag === "principal") {
        const [rows, ownedRows] = yield* Effect.all([
          memberships.listForPrincipal(principal.id),
          projects.listOwnedByPrincipal(principal.id),
        ]).pipe(
          Effect.mapError(
            (cause) =>
              new AccessResolveError({
                reason: "repository_error",
                principalId: principal.id,
                cause,
              }),
          ),
        );
        for (const row of rows) {
          if (row.state === "active") {
            roles.set(row.projectId, row.role);
          }
        }
        if (ownedRows.length > 0) {
          ownedProjectIds = new Set<string>(ownedRows);
        }
      }
    }

    return {
      sessionId: session.sessionId,
      subject: session.subject,
      scopes: session.scopes,
      principalId: principal.id,
      ...bindingProps,
      isOwner,
      ...(ceiling === undefined ? {} : { ceiling }),
      roles,
      ...(ownedProjectIds === undefined ? {} : { ownedProjectIds }),
    } satisfies AccessActor;
  });

  const assert = Effect.fn("ProjectAccess.assert")(function* (
    actor: AccessActor,
    projectId: ProjectId | string,
    capability: ProjectCapability,
  ) {
    if (canActor(actor, projectId, capability)) {
      return;
    }
    return yield* new ProjectForbiddenError({
      message: `Missing required capability ${capability} on project ${projectId}.`,
      projectId: ProjectId.make(projectId),
      requiredPermission: capability,
    });
  });

  return ProjectAccess.of({
    resolve,
    can: canActor,
    accessibleProjectIds: accessibleProjectIdsForActor,
    assert,
    effectiveScopes: effectiveScopesForActor,
  });
});

export const layer = Layer.effect(ProjectAccess, make);
