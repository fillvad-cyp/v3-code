import {
  AuthEnvironmentScope,
  type AuthSessionId,
  type MemberWithMemberships,
  type OwnerTransferResult,
  type Principal,
  type PrincipalCeilingTemplate,
  PrincipalId,
  ProjectId,
  type ProjectMembership,
  ProjectRole,
  boundProjectRole,
  ceilingScopes,
  roleAtLeast,
  roleFitsCeiling,
  roleHasCapability,
  roleScopes,
  scopesFitCeiling,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";

const OWNER_PRINCIPAL_ID = PrincipalId.make("owner");
const DEFAULT_INVITES_PER_HOUR = 10;
const isAuthEnvironmentScope = Schema.is(AuthEnvironmentScope);

const MembershipForbiddenReason = Schema.Literals([
  "not_authorized",
  "owner_required",
  "owner_protected",
  "owner_role_not_assignable",
]);

export class MembershipForbiddenError extends Schema.TaggedError<MembershipForbiddenError>()(
  "MembershipForbiddenError",
  {
    reason: MembershipForbiddenReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_authorized":
        return "You do not have permission to manage memberships for this project.";
      case "owner_required":
        return "Only the owner may perform this member management action.";
      case "owner_protected":
        return "The owner principal cannot be modified or removed by this action.";
      case "owner_role_not_assignable":
        return "The owner role cannot be assigned as a project membership.";
    }
  }
}

const MembershipNotFoundResource = Schema.Literals(["principal", "membership"]);

export class MembershipNotFoundError extends Schema.TaggedError<MembershipNotFoundError>()(
  "MembershipNotFoundError",
  {
    resource: MembershipNotFoundResource,
    principalId: PrincipalId,
    projectId: Schema.optionalKey(ProjectId),
  },
) {
  override get message(): string {
    return this.resource === "principal"
      ? "The requested member was not found."
      : "The requested project membership was not found.";
  }
}

const MembershipCeilingReason = Schema.Literals([
  "role_exceeds_actor_rank",
  "role_exceeds_actor_ceiling",
  "role_exceeds_principal_ceiling",
  "target_exceeds_actor_rank",
]);

export class MembershipCeilingError extends Schema.TaggedError<MembershipCeilingError>()(
  "MembershipCeilingError",
  {
    reason: MembershipCeilingReason,
    role: ProjectRole,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "role_exceeds_actor_rank":
        return `You cannot assign the ${this.role} role because it exceeds your own project role.`;
      case "role_exceeds_actor_ceiling":
        return `You cannot assign the ${this.role} role because it exceeds your scope ceiling.`;
      case "role_exceeds_principal_ceiling":
        return `The ${this.role} role exceeds this member's scope ceiling.`;
      case "target_exceeds_actor_rank":
        return `You cannot modify a member holding the ${this.role} role.`;
    }
  }
}

const MembershipInvalidInputReason = Schema.Literals([
  "empty_update",
  "project_id_required",
  "cannot_transfer_to_self",
  "invalid_transfer_target",
  "invalid_transfer_confirmation",
]);

export class MembershipInvalidInputError extends Schema.TaggedError<MembershipInvalidInputError>()(
  "MembershipInvalidInputError",
  {
    reason: MembershipInvalidInputReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "empty_update":
        return "At least one of role, state, or ceiling must be provided.";
      case "project_id_required":
        return "projectId is required when updating membership role.";
      case "cannot_transfer_to_self":
        return "Ownership cannot be transferred to the current owner.";
      case "invalid_transfer_target":
        return "Ownership can only be transferred to an active member.";
      case "invalid_transfer_confirmation":
        return 'Confirmation must match the target member ID, display name, or "TRANSFER".';
    }
  }
}

export class MembershipInternalError extends Schema.TaggedError<MembershipInternalError>()(
  "MembershipInternalError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Membership operation failed (${this.operation}).`;
  }
}

interface MembershipAuditContext {
  readonly sessionId?: AuthSessionId | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

interface SetRoleInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly projectId: ProjectId;
  readonly principalId: PrincipalId;
  readonly role: ProjectRole;
  readonly audit?: MembershipAuditContext;
}

interface SetMembershipStateInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly projectId: ProjectId;
  readonly principalId: PrincipalId;
  readonly state: "active" | "suspended";
  readonly audit?: MembershipAuditContext;
}

interface RemoveFromProjectInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly projectId: ProjectId;
  readonly principalId: PrincipalId;
  readonly audit?: MembershipAuditContext;
}

interface RemoveFromProjectResult {
  readonly membership: ProjectMembership;
  readonly promotedOwner: boolean;
}

interface RemovePrincipalInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly principalId: PrincipalId;
  readonly audit?: MembershipAuditContext;
}

interface RemovePrincipalResult {
  readonly principal: Principal;
  readonly revokedSessions: number;
  readonly revokedTokens: number;
}

interface SetCeilingInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly principalId: PrincipalId;
  readonly template: PrincipalCeilingTemplate;
  readonly audit?: MembershipAuditContext;
}

interface SuspendPrincipalInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly principalId: PrincipalId;
  readonly audit?: MembershipAuditContext;
}

interface SuspendPrincipalResult {
  readonly principal: Principal;
  readonly suspendedMemberships: number;
  readonly revokedSessions: number;
}

interface ReactivatePrincipalInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly principalId: PrincipalId;
  readonly audit?: MembershipAuditContext;
}

interface ReactivatePrincipalResult {
  readonly principal: Principal;
  readonly reactivatedMemberships: number;
}

interface UpdateMemberInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly principalId: PrincipalId;
  readonly projectId?: ProjectId;
  readonly role?: ProjectRole;
  readonly state?: "active" | "suspended";
  readonly ceiling?: PrincipalCeilingTemplate;
  readonly audit?: MembershipAuditContext;
}

interface GrantCreatorAdminInput {
  readonly projectId: ProjectId;
  readonly principalId: PrincipalId;
  readonly audit?: MembershipAuditContext;
}

interface UpsertFromInvitationInput {
  readonly projectId: ProjectId | null;
  readonly principalId: PrincipalId;
  readonly role: ProjectRole;
  readonly invitedBy: PrincipalId;
  readonly inviterIsOwner: boolean;
  readonly audit?: MembershipAuditContext;
}

interface UpsertFromInvitationResult {
  readonly principal: Principal;
  readonly memberships: ReadonlyArray<ProjectMembership>;
  readonly ceilingWidened: boolean;
}

interface TransferOwnershipInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly toPrincipalId: PrincipalId;
  readonly confirmation: string;
  readonly audit?: MembershipAuditContext;
}

type MembershipMutationError =
  | MembershipForbiddenError
  | MembershipNotFoundError
  | MembershipCeilingError
  | MembershipInternalError;

type OwnerMutationError =
  | MembershipForbiddenError
  | MembershipNotFoundError
  | MembershipInternalError;

type TransferOwnershipError =
  | MembershipForbiddenError
  | MembershipNotFoundError
  | MembershipInvalidInputError
  | MembershipInternalError;

type UpdateMemberError = MembershipInvalidInputError | MembershipMutationError;

export class MembershipService extends Context.Service<
  MembershipService,
  {
    readonly listForActor: (
      actor: ProjectAccess.AccessActor,
    ) => Effect.Effect<ReadonlyArray<MemberWithMemberships>, MembershipInternalError>;
    readonly setRole: (
      input: SetRoleInput,
    ) => Effect.Effect<ProjectMembership, MembershipMutationError>;
    readonly setMembershipState: (
      input: SetMembershipStateInput,
    ) => Effect.Effect<ProjectMembership, MembershipMutationError>;
    readonly removeFromProject: (
      input: RemoveFromProjectInput,
    ) => Effect.Effect<RemoveFromProjectResult, MembershipMutationError>;
    readonly removePrincipal: (
      input: RemovePrincipalInput,
    ) => Effect.Effect<RemovePrincipalResult, OwnerMutationError>;
    readonly setCeiling: (input: SetCeilingInput) => Effect.Effect<Principal, OwnerMutationError>;
    readonly suspendPrincipal: (
      input: SuspendPrincipalInput,
    ) => Effect.Effect<SuspendPrincipalResult, OwnerMutationError>;
    readonly reactivatePrincipal: (
      input: ReactivatePrincipalInput,
    ) => Effect.Effect<ReactivatePrincipalResult, OwnerMutationError>;
    readonly updateMember: (
      input: UpdateMemberInput,
    ) => Effect.Effect<MemberWithMemberships, UpdateMemberError>;
    readonly canIssueInvite: (
      principalId: PrincipalId,
    ) => Effect.Effect<boolean, MembershipInternalError>;
    readonly grantCreatorAdmin: (
      input: GrantCreatorAdminInput,
    ) => Effect.Effect<ProjectMembership, MembershipInternalError>;
    readonly upsertFromInvitation: (
      input: UpsertFromInvitationInput,
    ) => Effect.Effect<UpsertFromInvitationResult, MembershipMutationError>;
    readonly transferOwnership: (
      input: TransferOwnershipInput,
    ) => Effect.Effect<OwnerTransferResult, TransferOwnershipError>;
  }
>()("v3code/identity/MembershipService") {}

function actorRoleOnProject(
  actor: ProjectAccess.AccessActor,
  projectId: ProjectId,
): ProjectRole | undefined {
  if (actor.isOwner) return "owner";
  return actor.binding?._tag === "projects"
    ? boundProjectRole(actor.binding, projectId)
    : actor.roles.get(projectId);
}

function actorPrincipalId(actor: ProjectAccess.AccessActor): PrincipalId | null {
  return actor.principalId ?? (actor.isOwner ? OWNER_PRINCIPAL_ID : null);
}

function actorSessionId(
  actor: ProjectAccess.AccessActor,
  audit: MembershipAuditContext | undefined,
): AuthSessionId | null {
  return audit?.sessionId ?? actor.sessionId ?? null;
}

function mapTransactionError<E extends { readonly _tag: string }>(
  operation: string,
  allowedTags: ReadonlySet<string>,
) {
  return (error: E | unknown): E | MembershipInternalError => {
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      typeof (error as { readonly _tag: unknown })._tag === "string" &&
      allowedTags.has((error as { readonly _tag: string })._tag)
    ) {
      return error as E;
    }
    return new MembershipInternalError({ operation, cause: error });
  };
}

const MUTATION_ERROR_TAGS = new Set([
  "MembershipForbiddenError",
  "MembershipNotFoundError",
  "MembershipCeilingError",
  "MembershipInvalidInputError",
  "MembershipInternalError",
]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const principals = yield* Principals.PrincipalRepository;
  const memberships = yield* Memberships.MembershipRepository;
  const sessionPrincipals = yield* SessionPrincipals.SessionPrincipalRepository;
  const apiTokens = yield* ApiTokens.ApiTokenRepository;
  const auditEvents = yield* AuditEvents.AuditEventRepository;
  const memberLimits = yield* MemberLimits.MemberLimitsRepository;
  const invitations = yield* Invitations.InvitationRepository;
  const projectAccess = yield* ProjectAccess.ProjectAccess;
  const sessionStore = yield* SessionStore.SessionStore;

  const assertProjectMembersActor = (
    actor: ProjectAccess.AccessActor,
    projectId: ProjectId,
  ): Effect.Effect<ProjectRole, MembershipForbiddenError> => {
    if (actor.isOwner) {
      return Effect.succeed("owner");
    }
    const role = actorRoleOnProject(actor, projectId);
    if (
      role === undefined ||
      !projectAccess.can(actor, projectId, "project:members") ||
      !roleHasCapability(role, "project:members")
    ) {
      return Effect.fail(new MembershipForbiddenError({ reason: "not_authorized" }));
    }
    return Effect.succeed(role);
  };

  /* Runs inside the caller's transaction so orphan recovery stays atomic with removal. */
  const ensureProjectHasAdminTx = Effect.fnUntraced(function* (input: {
    readonly projectId: ProjectId;
    readonly removedPrincipalId: PrincipalId;
    readonly actor: ProjectAccess.AccessActor;
    readonly nowIso: string;
    readonly audit?: MembershipAuditContext;
    readonly operation: string;
  }) {
    const projectMemberships = yield* memberships
      .listForProject(input.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: input.operation, cause }),
        ),
      );
    if (projectMemberships.some((row) => row.role === "admin" && row.state === "active")) {
      return false;
    }

    const allPrincipals = yield* principals.list.pipe(
      Effect.mapError(
        (cause) => new MembershipInternalError({ operation: input.operation, cause }),
      ),
    );
    const owner = allPrincipals.find((row) => row.kind === "owner");
    if (owner === undefined || owner.id === input.removedPrincipalId) {
      return false;
    }

    const existingOwnerMembership = projectMemberships.find((row) => row.principalId === owner.id);
    yield* memberships
      .upsert({
        projectId: input.projectId,
        principalId: owner.id,
        role: "admin",
        state: "active",
        invitedBy: actorPrincipalId(input.actor),
        expiresAt: null,
        updatedAt: input.nowIso,
      })
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: input.operation, cause }),
        ),
      );
    yield* principals
      .bumpAccessRevision(owner.id, input.nowIso)
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: input.operation, cause }),
        ),
      );
    yield* auditEvents
      .append({
        at: input.nowIso,
        actorPrincipalId: actorPrincipalId(input.actor),
        actorSessionId: actorSessionId(input.actor, input.audit),
        action: "membership.role.changed",
        resourceType: "membership",
        resourceId: `${input.projectId}:${owner.id}`,
        projectId: input.projectId,
        ip: input.audit?.ip ?? null,
        userAgent: input.audit?.userAgent ?? null,
        outcome: "allow",
        metadata: {
          principalId: owner.id,
          previousRole: existingOwnerMembership?.role ?? null,
          role: "admin",
          reason: "last_admin_removed",
        },
      })
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: input.operation, cause }),
        ),
      );
    return true;
  });

  /* Runs outside SQL write transactions because SessionPrincipalRepository.listForPrincipal uses readOnly. */
  const revokePrincipalSessions = Effect.fnUntraced(
    function* (principalId: PrincipalId, _operation: string) {
      const sessionIds = yield* sessionPrincipals.listForPrincipal(principalId);
      let revokedSessions = 0;
      for (const sessionId of sessionIds) {
        const revoked = yield* sessionStore.revoke(sessionId);
        if (revoked) {
          revokedSessions += 1;
        }
      }
      const removedBindings = yield* sessionPrincipals.removeAllForPrincipal(principalId);
      return revokedSessions + removedBindings;
    },
    (effect, _principalId, operation) =>
      Effect.mapError(effect, (cause) => new MembershipInternalError({ operation, cause })),
  );

  /* Shared transactional body for setRole and updateMember. */
  const setRoleTx = Effect.fnUntraced(function* (input: SetRoleInput, nowIso: string) {
    const actorRole = yield* assertProjectMembersActor(input.actor, input.projectId);
    if (!input.actor.isOwner) {
      if (!roleAtLeast(actorRole, input.role)) {
        return yield* new MembershipCeilingError({
          reason: "role_exceeds_actor_rank",
          role: input.role,
        });
      }
      const actorCeiling = input.actor.ceiling ?? projectAccess.effectiveScopes(input.actor);
      if (
        !roleFitsCeiling(actorCeiling, input.role) ||
        !scopesFitCeiling(projectAccess.effectiveScopes(input.actor), roleScopes(input.role))
      ) {
        return yield* new MembershipCeilingError({
          reason: "role_exceeds_actor_ceiling",
          role: input.role,
        });
      }
    }
    if (input.role === "owner") {
      return yield* new MembershipForbiddenError({ reason: "owner_role_not_assignable" });
    }

    const maybeMembership = yield* memberships
      .get(input.projectId, input.principalId)
      .pipe(
        Effect.mapError((cause) => new MembershipInternalError({ operation: "setRole", cause })),
      );
    if (Option.isNone(maybeMembership) || maybeMembership.value.state === "removed") {
      return yield* new MembershipNotFoundError({
        resource: "membership",
        projectId: input.projectId,
        principalId: input.principalId,
      });
    }
    const existing = maybeMembership.value;

    const maybePrincipal = yield* principals
      .get(input.principalId)
      .pipe(
        Effect.mapError((cause) => new MembershipInternalError({ operation: "setRole", cause })),
      );
    if (Option.isNone(maybePrincipal) || maybePrincipal.value.status === "removed") {
      return yield* new MembershipNotFoundError({
        resource: "principal",
        principalId: input.principalId,
      });
    }
    const targetPrincipal = maybePrincipal.value;

    if (targetPrincipal.kind === "owner" && !input.actor.isOwner) {
      return yield* new MembershipForbiddenError({ reason: "owner_protected" });
    }
    if (!input.actor.isOwner && !roleAtLeast(actorRole, existing.role)) {
      return yield* new MembershipCeilingError({
        reason: "target_exceeds_actor_rank",
        role: existing.role,
      });
    }
    // The owner principal is ceiling-free even though its migration row stores `[]`.
    if (targetPrincipal.kind !== "owner") {
      const targetCeiling = targetPrincipal.ceiling.filter(isAuthEnvironmentScope);
      if (!roleFitsCeiling(targetCeiling, input.role)) {
        return yield* new MembershipCeilingError({
          reason: "role_exceeds_principal_ceiling",
          role: input.role,
        });
      }
    }

    yield* memberships
      .setRole({
        projectId: input.projectId,
        principalId: input.principalId,
        role: input.role,
        updatedAt: nowIso,
      })
      .pipe(
        Effect.mapError((cause) => new MembershipInternalError({ operation: "setRole", cause })),
      );
    yield* principals
      .bumpAccessRevision(input.principalId, nowIso)
      .pipe(
        Effect.mapError((cause) => new MembershipInternalError({ operation: "setRole", cause })),
      );
    yield* auditEvents
      .append({
        at: nowIso,
        actorPrincipalId: actorPrincipalId(input.actor),
        actorSessionId: actorSessionId(input.actor, input.audit),
        action: "membership.role.changed",
        resourceType: "membership",
        resourceId: `${input.projectId}:${input.principalId}`,
        projectId: input.projectId,
        ip: input.audit?.ip ?? null,
        userAgent: input.audit?.userAgent ?? null,
        outcome: "allow",
        metadata: {
          principalId: input.principalId,
          previousRole: existing.role,
          role: input.role,
        },
      })
      .pipe(
        Effect.mapError((cause) => new MembershipInternalError({ operation: "setRole", cause })),
      );

    return {
      ...existing,
      role: input.role,
      updatedAt: nowIso,
    } satisfies ProjectMembership;
  });

  /* Shared transactional body for setMembershipState and updateMember. */
  const setMembershipStateTx = Effect.fnUntraced(function* (
    input: SetMembershipStateInput,
    nowIso: string,
  ) {
    const actorRole = yield* assertProjectMembersActor(input.actor, input.projectId);

    const maybeMembership = yield* memberships
      .get(input.projectId, input.principalId)
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "setMembershipState", cause }),
        ),
      );
    if (Option.isNone(maybeMembership) || maybeMembership.value.state === "removed") {
      return yield* new MembershipNotFoundError({
        resource: "membership",
        projectId: input.projectId,
        principalId: input.principalId,
      });
    }
    const existing = maybeMembership.value;

    const maybePrincipal = yield* principals
      .get(input.principalId)
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "setMembershipState", cause }),
        ),
      );
    if (Option.isNone(maybePrincipal) || maybePrincipal.value.status === "removed") {
      return yield* new MembershipNotFoundError({
        resource: "principal",
        principalId: input.principalId,
      });
    }
    const targetPrincipal = maybePrincipal.value;

    if (targetPrincipal.kind === "owner" && !input.actor.isOwner) {
      return yield* new MembershipForbiddenError({ reason: "owner_protected" });
    }
    if (!input.actor.isOwner && !roleAtLeast(actorRole, existing.role)) {
      return yield* new MembershipCeilingError({
        reason: "target_exceeds_actor_rank",
        role: existing.role,
      });
    }

    yield* memberships
      .setState({
        projectId: input.projectId,
        principalId: input.principalId,
        state: input.state,
        updatedAt: nowIso,
      })
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "setMembershipState", cause }),
        ),
      );
    yield* principals
      .bumpAccessRevision(input.principalId, nowIso)
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "setMembershipState", cause }),
        ),
      );

    if (input.state === "suspended") {
      yield* auditEvents
        .append({
          at: nowIso,
          actorPrincipalId: actorPrincipalId(input.actor),
          actorSessionId: actorSessionId(input.actor, input.audit),
          action: "membership.suspended",
          resourceType: "membership",
          resourceId: `${input.projectId}:${input.principalId}`,
          projectId: input.projectId,
          ip: input.audit?.ip ?? null,
          userAgent: input.audit?.userAgent ?? null,
          outcome: "allow",
          metadata: {
            principalId: input.principalId,
            previousState: existing.state,
            state: input.state,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) => new MembershipInternalError({ operation: "setMembershipState", cause }),
          ),
        );
    } else if (existing.state === "suspended") {
      yield* auditEvents
        .append({
          at: nowIso,
          actorPrincipalId: actorPrincipalId(input.actor),
          actorSessionId: actorSessionId(input.actor, input.audit),
          action: "member.reactivated",
          resourceType: "membership",
          resourceId: `${input.projectId}:${input.principalId}`,
          projectId: input.projectId,
          ip: input.audit?.ip ?? null,
          userAgent: input.audit?.userAgent ?? null,
          outcome: "allow",
          metadata: {
            principalId: input.principalId,
            previousState: existing.state,
            state: input.state,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) => new MembershipInternalError({ operation: "setMembershipState", cause }),
          ),
        );
    }

    return {
      ...existing,
      state: input.state,
      updatedAt: nowIso,
    } satisfies ProjectMembership;
  });

  /* Shared transactional body for setCeiling and updateMember. */
  const setCeilingTx = Effect.fnUntraced(function* (input: SetCeilingInput, nowIso: string) {
    if (!input.actor.isOwner) {
      return yield* new MembershipForbiddenError({ reason: "owner_required" });
    }
    const maybePrincipal = yield* principals
      .get(input.principalId)
      .pipe(
        Effect.mapError((cause) => new MembershipInternalError({ operation: "setCeiling", cause })),
      );
    if (Option.isNone(maybePrincipal) || maybePrincipal.value.status === "removed") {
      return yield* new MembershipNotFoundError({
        resource: "principal",
        principalId: input.principalId,
      });
    }
    const targetPrincipal = maybePrincipal.value;
    if (targetPrincipal.kind === "owner") {
      return yield* new MembershipForbiddenError({ reason: "owner_protected" });
    }

    const nextCeiling = [...ceilingScopes(input.template)];
    yield* principals
      .update({
        id: input.principalId,
        ceiling: nextCeiling,
        updatedAt: nowIso,
        bumpAccessRevision: true,
      })
      .pipe(
        Effect.mapError((cause) => new MembershipInternalError({ operation: "setCeiling", cause })),
      );

    yield* auditEvents
      .append({
        at: nowIso,
        actorPrincipalId: actorPrincipalId(input.actor),
        actorSessionId: actorSessionId(input.actor, input.audit),
        action: "membership.role.changed",
        resourceType: "principal",
        resourceId: input.principalId,
        projectId: null,
        ip: input.audit?.ip ?? null,
        userAgent: input.audit?.userAgent ?? null,
        outcome: "allow",
        metadata: {
          principalId: input.principalId,
          change: "ceiling",
          template: input.template,
          previousCeiling: targetPrincipal.ceiling,
          ceiling: nextCeiling,
        },
      })
      .pipe(
        Effect.mapError((cause) => new MembershipInternalError({ operation: "setCeiling", cause })),
      );

    return {
      ...targetPrincipal,
      ceiling: nextCeiling,
      accessRevision: targetPrincipal.accessRevision + 1,
      updatedAt: nowIso,
    } satisfies Principal;
  });

  const listForActor = Effect.fn("MembershipService.listForActor")(function* (
    actor: ProjectAccess.AccessActor,
  ) {
    const accessibleProjects = projectAccess.accessibleProjectIds(actor);
    const allPrincipals = yield* principals.list.pipe(
      Effect.mapError((cause) => new MembershipInternalError({ operation: "listForActor", cause })),
    );
    const rows = yield* Effect.forEach(allPrincipals, (principal) =>
      memberships.listForPrincipal(principal.id).pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "listForActor", cause }),
        ),
        Effect.map((principalMemberships): MemberWithMemberships => ({
          principal,
          memberships:
            accessibleProjects === undefined
              ? principalMemberships
              : principalMemberships.filter((entry) => accessibleProjects.has(entry.projectId)),
        })),
      ),
    );
    if (accessibleProjects === undefined) {
      return rows;
    }
    return rows.filter(
      (row) => row.principal.id === actor.principalId || row.memberships.length > 0,
    );
  });

  const setRole = Effect.fn("MembershipService.setRole")(function* (input: SetRoleInput) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(setRoleTx(input, nowIso))
      .pipe(
        Effect.mapError(
          mapTransactionError<MembershipMutationError>("setRole", MUTATION_ERROR_TAGS),
        ),
      );
  });

  const setMembershipState = Effect.fn("MembershipService.setMembershipState")(function* (
    input: SetMembershipStateInput,
  ) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(setMembershipStateTx(input, nowIso))
      .pipe(
        Effect.mapError(
          mapTransactionError<MembershipMutationError>("setMembershipState", MUTATION_ERROR_TAGS),
        ),
      );
  });

  const removeFromProject = Effect.fn("MembershipService.removeFromProject")(function* (
    input: RemoveFromProjectInput,
  ) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const actorRole = yield* assertProjectMembersActor(input.actor, input.projectId);

          const maybeMembership = yield* memberships
            .get(input.projectId, input.principalId)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "removeFromProject", cause }),
              ),
            );
          if (Option.isNone(maybeMembership) || maybeMembership.value.state === "removed") {
            return yield* new MembershipNotFoundError({
              resource: "membership",
              projectId: input.projectId,
              principalId: input.principalId,
            });
          }
          const existing = maybeMembership.value;

          const maybePrincipal = yield* principals
            .get(input.principalId)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "removeFromProject", cause }),
              ),
            );
          if (Option.isNone(maybePrincipal)) {
            return yield* new MembershipNotFoundError({
              resource: "principal",
              principalId: input.principalId,
            });
          }
          const targetPrincipal = maybePrincipal.value;

          if (targetPrincipal.kind === "owner" && !input.actor.isOwner) {
            return yield* new MembershipForbiddenError({ reason: "owner_protected" });
          }
          if (!input.actor.isOwner && !roleAtLeast(actorRole, existing.role)) {
            return yield* new MembershipCeilingError({
              reason: "target_exceeds_actor_rank",
              role: existing.role,
            });
          }

          yield* memberships
            .setState({
              projectId: input.projectId,
              principalId: input.principalId,
              state: "removed",
              updatedAt: nowIso,
            })
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "removeFromProject", cause }),
              ),
            );
          yield* principals
            .bumpAccessRevision(input.principalId, nowIso)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "removeFromProject", cause }),
              ),
            );
          yield* auditEvents
            .append({
              at: nowIso,
              actorPrincipalId: actorPrincipalId(input.actor),
              actorSessionId: actorSessionId(input.actor, input.audit),
              action: "membership.removed",
              resourceType: "membership",
              resourceId: `${input.projectId}:${input.principalId}`,
              projectId: input.projectId,
              ip: input.audit?.ip ?? null,
              userAgent: input.audit?.userAgent ?? null,
              outcome: "allow",
              metadata: {
                principalId: input.principalId,
                previousRole: existing.role,
                previousState: existing.state,
              },
            })
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "removeFromProject", cause }),
              ),
            );

          const promotedOwner =
            existing.role === "admin" && existing.state === "active"
              ? yield* ensureProjectHasAdminTx({
                  projectId: input.projectId,
                  removedPrincipalId: input.principalId,
                  actor: input.actor,
                  nowIso,
                  ...(input.audit === undefined ? {} : { audit: input.audit }),
                  operation: "removeFromProject",
                })
              : false;

          return {
            membership: {
              ...existing,
              state: "removed",
              updatedAt: nowIso,
            },
            promotedOwner,
          } satisfies RemoveFromProjectResult;
        }),
      )
      .pipe(
        Effect.mapError(
          mapTransactionError<MembershipMutationError>("removeFromProject", MUTATION_ERROR_TAGS),
        ),
      );
  });

  const removePrincipal = Effect.fn("MembershipService.removePrincipal")(function* (
    input: RemovePrincipalInput,
  ) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const txResult = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (!input.actor.isOwner) {
            return yield* new MembershipForbiddenError({ reason: "owner_required" });
          }

          const maybePrincipal = yield* principals
            .get(input.principalId)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "removePrincipal", cause }),
              ),
            );
          if (Option.isNone(maybePrincipal) || maybePrincipal.value.status === "removed") {
            return yield* new MembershipNotFoundError({
              resource: "principal",
              principalId: input.principalId,
            });
          }
          const targetPrincipal = maybePrincipal.value;
          if (targetPrincipal.kind === "owner") {
            return yield* new MembershipForbiddenError({ reason: "owner_protected" });
          }

          const principalMemberships = yield* memberships
            .listForPrincipal(input.principalId)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "removePrincipal", cause }),
              ),
            );
          const adminProjectIds: Array<ProjectId> = [];
          for (const membership of principalMemberships) {
            if (membership.role === "admin" && membership.state === "active") {
              adminProjectIds.push(membership.projectId);
            }
            if (membership.state !== "removed") {
              yield* memberships
                .setState({
                  projectId: membership.projectId,
                  principalId: input.principalId,
                  state: "removed",
                  updatedAt: nowIso,
                })
                .pipe(
                  Effect.mapError(
                    (cause) => new MembershipInternalError({ operation: "removePrincipal", cause }),
                  ),
                );
            }
          }

          for (const projectId of adminProjectIds) {
            yield* ensureProjectHasAdminTx({
              projectId,
              removedPrincipalId: input.principalId,
              actor: input.actor,
              nowIso,
              ...(input.audit === undefined ? {} : { audit: input.audit }),
              operation: "removePrincipal",
            });
          }

          const revokedTokens = yield* apiTokens
            .revokeAllForPrincipal(input.principalId, nowIso)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "removePrincipal", cause }),
              ),
            );

          yield* principals
            .update({
              id: input.principalId,
              status: "removed",
              removedAt: nowIso,
              updatedAt: nowIso,
              bumpAccessRevision: true,
            })
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "removePrincipal", cause }),
              ),
            );

          yield* auditEvents
            .append({
              at: nowIso,
              actorPrincipalId: actorPrincipalId(input.actor),
              actorSessionId: actorSessionId(input.actor, input.audit),
              action: "member.removed",
              resourceType: "principal",
              resourceId: input.principalId,
              projectId: null,
              ip: input.audit?.ip ?? null,
              userAgent: input.audit?.userAgent ?? null,
              outcome: "allow",
              metadata: {
                principalId: input.principalId,
                displayName: targetPrincipal.displayName,
                revokedTokens,
              },
            })
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "removePrincipal", cause }),
              ),
            );

          return {
            principal: {
              ...targetPrincipal,
              status: "removed",
              removedAt: nowIso,
              accessRevision: targetPrincipal.accessRevision + 1,
              updatedAt: nowIso,
            } satisfies Principal,
            revokedTokens,
          };
        }),
      )
      .pipe(
        Effect.mapError(
          mapTransactionError<OwnerMutationError>("removePrincipal", MUTATION_ERROR_TAGS),
        ),
      );

    const revokedSessions = yield* revokePrincipalSessions(input.principalId, "removePrincipal");
    return {
      principal: txResult.principal,
      revokedSessions,
      revokedTokens: txResult.revokedTokens,
    } satisfies RemovePrincipalResult;
  });

  const setCeiling = Effect.fn("MembershipService.setCeiling")(function* (input: SetCeilingInput) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(setCeilingTx(input, nowIso))
      .pipe(
        Effect.mapError(mapTransactionError<OwnerMutationError>("setCeiling", MUTATION_ERROR_TAGS)),
      );
  });

  /* Shared transactional body for suspendPrincipal and updateMember. */
  const suspendPrincipalTx = Effect.fnUntraced(function* (
    input: SuspendPrincipalInput,
    nowIso: string,
  ) {
    if (!input.actor.isOwner) {
      return yield* new MembershipForbiddenError({ reason: "owner_required" });
    }

    const maybePrincipal = yield* principals
      .get(input.principalId)
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "suspendPrincipal", cause }),
        ),
      );
    if (Option.isNone(maybePrincipal) || maybePrincipal.value.status === "removed") {
      return yield* new MembershipNotFoundError({
        resource: "principal",
        principalId: input.principalId,
      });
    }
    const targetPrincipal = maybePrincipal.value;
    if (targetPrincipal.kind === "owner") {
      return yield* new MembershipForbiddenError({ reason: "owner_protected" });
    }

    const principalMemberships = yield* memberships
      .listForPrincipal(input.principalId)
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "suspendPrincipal", cause }),
        ),
      );
    let suspendedMemberships = 0;
    for (const membership of principalMemberships) {
      if (membership.state !== "removed" && membership.state !== "suspended") {
        yield* memberships
          .setState({
            projectId: membership.projectId,
            principalId: input.principalId,
            state: "suspended",
            updatedAt: nowIso,
          })
          .pipe(
            Effect.mapError(
              (cause) => new MembershipInternalError({ operation: "suspendPrincipal", cause }),
            ),
          );
        suspendedMemberships += 1;
      }
    }

    yield* principals
      .update({
        id: input.principalId,
        status: "suspended",
        updatedAt: nowIso,
        bumpAccessRevision: true,
      })
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "suspendPrincipal", cause }),
        ),
      );

    yield* auditEvents
      .append({
        at: nowIso,
        actorPrincipalId: actorPrincipalId(input.actor),
        actorSessionId: actorSessionId(input.actor, input.audit),
        action: "member.suspended",
        resourceType: "principal",
        resourceId: input.principalId,
        projectId: null,
        ip: input.audit?.ip ?? null,
        userAgent: input.audit?.userAgent ?? null,
        outcome: "allow",
        metadata: {
          principalId: input.principalId,
          displayName: targetPrincipal.displayName,
          suspendedMemberships,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "suspendPrincipal", cause }),
        ),
      );

    return {
      principal: {
        ...targetPrincipal,
        status: "suspended",
        accessRevision: targetPrincipal.accessRevision + 1,
        updatedAt: nowIso,
      } satisfies Principal,
      suspendedMemberships,
    };
  });

  /* Shared transactional body for reactivatePrincipal and updateMember. */
  const reactivatePrincipalTx = Effect.fnUntraced(function* (
    input: ReactivatePrincipalInput,
    nowIso: string,
  ) {
    if (!input.actor.isOwner) {
      return yield* new MembershipForbiddenError({ reason: "owner_required" });
    }

    const maybePrincipal = yield* principals
      .get(input.principalId)
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "reactivatePrincipal", cause }),
        ),
      );
    if (Option.isNone(maybePrincipal) || maybePrincipal.value.status === "removed") {
      return yield* new MembershipNotFoundError({
        resource: "principal",
        principalId: input.principalId,
      });
    }
    const targetPrincipal = maybePrincipal.value;
    if (targetPrincipal.kind === "owner") {
      return yield* new MembershipForbiddenError({ reason: "owner_protected" });
    }

    const principalMemberships = yield* memberships
      .listForPrincipal(input.principalId)
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "reactivatePrincipal", cause }),
        ),
      );
    let reactivatedMemberships = 0;
    for (const membership of principalMemberships) {
      if (membership.state === "suspended") {
        yield* memberships
          .setState({
            projectId: membership.projectId,
            principalId: input.principalId,
            state: "active",
            updatedAt: nowIso,
          })
          .pipe(
            Effect.mapError(
              (cause) => new MembershipInternalError({ operation: "reactivatePrincipal", cause }),
            ),
          );
        reactivatedMemberships += 1;
      }
    }

    yield* principals
      .update({
        id: input.principalId,
        status: "active",
        updatedAt: nowIso,
        bumpAccessRevision: true,
      })
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "reactivatePrincipal", cause }),
        ),
      );

    yield* auditEvents
      .append({
        at: nowIso,
        actorPrincipalId: actorPrincipalId(input.actor),
        actorSessionId: actorSessionId(input.actor, input.audit),
        action: "member.reactivated",
        resourceType: "principal",
        resourceId: input.principalId,
        projectId: null,
        ip: input.audit?.ip ?? null,
        userAgent: input.audit?.userAgent ?? null,
        outcome: "allow",
        metadata: {
          principalId: input.principalId,
          displayName: targetPrincipal.displayName,
          reactivatedMemberships,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "reactivatePrincipal", cause }),
        ),
      );

    return {
      principal: {
        ...targetPrincipal,
        status: "active",
        accessRevision: targetPrincipal.accessRevision + 1,
        updatedAt: nowIso,
      } satisfies Principal,
      reactivatedMemberships,
    };
  });

  const suspendPrincipal = Effect.fn("MembershipService.suspendPrincipal")(function* (
    input: SuspendPrincipalInput,
  ) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const txResult = yield* sql
      .withTransaction(suspendPrincipalTx(input, nowIso))
      .pipe(
        Effect.mapError(
          mapTransactionError<OwnerMutationError>("suspendPrincipal", MUTATION_ERROR_TAGS),
        ),
      );

    const revokedSessions = yield* revokePrincipalSessions(input.principalId, "suspendPrincipal");
    return {
      principal: txResult.principal,
      suspendedMemberships: txResult.suspendedMemberships,
      revokedSessions,
    } satisfies SuspendPrincipalResult;
  });

  const reactivatePrincipal = Effect.fn("MembershipService.reactivatePrincipal")(function* (
    input: ReactivatePrincipalInput,
  ) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(reactivatePrincipalTx(input, nowIso))
      .pipe(
        Effect.mapError(
          mapTransactionError<OwnerMutationError>("reactivatePrincipal", MUTATION_ERROR_TAGS),
        ),
      );
  });

  const updateMember = Effect.fn("MembershipService.updateMember")(function* (
    input: UpdateMemberInput,
  ) {
    if (input.ceiling === undefined && input.role === undefined && input.state === undefined) {
      return yield* new MembershipInvalidInputError({ reason: "empty_update" });
    }
    if (input.role !== undefined && input.projectId === undefined) {
      return yield* new MembershipInvalidInputError({ reason: "project_id_required" });
    }

    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const shouldRevokeSessions = input.projectId === undefined && input.state === "suspended";
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (input.ceiling !== undefined) {
            yield* setCeilingTx(
              {
                actor: input.actor,
                principalId: input.principalId,
                template: input.ceiling,
                ...(input.audit === undefined ? {} : { audit: input.audit }),
              },
              nowIso,
            );
          }
          if (input.role !== undefined && input.projectId !== undefined) {
            yield* setRoleTx(
              {
                actor: input.actor,
                projectId: input.projectId,
                principalId: input.principalId,
                role: input.role,
                ...(input.audit === undefined ? {} : { audit: input.audit }),
              },
              nowIso,
            );
          }
          if (input.state !== undefined) {
            if (input.projectId !== undefined) {
              yield* setMembershipStateTx(
                {
                  actor: input.actor,
                  projectId: input.projectId,
                  principalId: input.principalId,
                  state: input.state,
                  ...(input.audit === undefined ? {} : { audit: input.audit }),
                },
                nowIso,
              );
            } else if (input.state === "suspended") {
              yield* suspendPrincipalTx(
                {
                  actor: input.actor,
                  principalId: input.principalId,
                  ...(input.audit === undefined ? {} : { audit: input.audit }),
                },
                nowIso,
              );
            } else {
              yield* reactivatePrincipalTx(
                {
                  actor: input.actor,
                  principalId: input.principalId,
                  ...(input.audit === undefined ? {} : { audit: input.audit }),
                },
                nowIso,
              );
            }
          }

          const updatedPrincipal = yield* principals
            .get(input.principalId)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "updateMember", cause }),
              ),
            );
          if (Option.isNone(updatedPrincipal)) {
            return yield* new MembershipNotFoundError({
              resource: "principal",
              principalId: input.principalId,
            });
          }
          const principalMemberships = yield* memberships
            .listForPrincipal(input.principalId)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "updateMember", cause }),
              ),
            );
          const accessibleProjects = projectAccess.accessibleProjectIds(input.actor);
          return {
            principal: updatedPrincipal.value,
            memberships:
              accessibleProjects === undefined
                ? principalMemberships
                : principalMemberships.filter((entry) => accessibleProjects.has(entry.projectId)),
          } satisfies MemberWithMemberships;
        }),
      )
      .pipe(
        Effect.mapError(
          mapTransactionError<UpdateMemberError>("updateMember", MUTATION_ERROR_TAGS),
        ),
      );

    if (shouldRevokeSessions) {
      yield* revokePrincipalSessions(input.principalId, "updateMember");
    }
    return result;
  });

  const canIssueInvite = Effect.fn("MembershipService.canIssueInvite")(function* (
    principalId: PrincipalId,
  ) {
    const now = yield* DateTime.now;
    const sinceIso = DateTime.formatIso(DateTime.subtractDuration(now, Duration.hours(1)));
    const [limits, recentCount] = yield* Effect.all([
      memberLimits.get(principalId),
      invitations.countCreatedBySince(principalId, sinceIso),
    ]).pipe(
      Effect.mapError(
        (cause) => new MembershipInternalError({ operation: "canIssueInvite", cause }),
      ),
    );
    const limit = limits?.invitesPerHour ?? DEFAULT_INVITES_PER_HOUR;
    return recentCount < limit;
  });

  const grantCreatorAdmin = Effect.fn("MembershipService.grantCreatorAdmin")(function* (
    input: GrantCreatorAdminInput,
  ) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* memberships.upsert({
            projectId: input.projectId,
            principalId: input.principalId,
            role: "admin",
            state: "active",
            invitedBy: null,
            expiresAt: null,
            updatedAt: nowIso,
          });
          yield* principals.bumpAccessRevision(input.principalId, nowIso);
          yield* auditEvents.append({
            at: nowIso,
            actorPrincipalId: input.principalId,
            actorSessionId: input.audit?.sessionId ?? null,
            action: "membership.role.changed",
            resourceType: "membership",
            resourceId: input.principalId,
            projectId: input.projectId,
            ip: input.audit?.ip ?? null,
            userAgent: input.audit?.userAgent ?? null,
            outcome: "allow",
            metadata: { role: "admin", reason: "project_creator" },
          });
          const created = yield* memberships.get(input.projectId, input.principalId);
          return Option.getOrElse(created, () => ({
            projectId: input.projectId,
            principalId: input.principalId,
            role: "admin" as const,
            state: "active" as const,
            invitedBy: null,
            expiresAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          }));
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) => new MembershipInternalError({ operation: "grantCreatorAdmin", cause }),
        ),
      );
  });

  const upsertFromInvitation = Effect.fn("MembershipService.upsertFromInvitation")(function* (
    input: UpsertFromInvitationInput,
  ) {
    if (input.role === "owner") {
      return yield* new MembershipForbiddenError({ reason: "owner_role_not_assignable" });
    }
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const maybePrincipal = yield* principals
            .get(input.principalId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new MembershipInternalError({ operation: "upsertFromInvitation", cause }),
              ),
            );
          if (Option.isNone(maybePrincipal) || maybePrincipal.value.status === "removed") {
            return yield* new MembershipNotFoundError({
              resource: "principal",
              principalId: input.principalId,
            });
          }
          const targetPrincipal = maybePrincipal.value;
          if (targetPrincipal.kind === "owner") {
            return yield* new MembershipForbiddenError({ reason: "owner_protected" });
          }
          if (targetPrincipal.status !== "active") {
            return yield* new MembershipForbiddenError({ reason: "not_authorized" });
          }

          const currentCeiling = targetPrincipal.ceiling.filter(isAuthEnvironmentScope);
          let nextCeiling: ReadonlyArray<AuthEnvironmentScope> = currentCeiling;
          let ceilingWidened = false;

          if (!roleFitsCeiling(currentCeiling, input.role)) {
            if (!input.inviterIsOwner) {
              return yield* new MembershipCeilingError({
                reason: "role_exceeds_principal_ceiling",
                role: input.role,
              });
            }
            nextCeiling = [...new Set([...currentCeiling, ...roleScopes(input.role)])].sort();
            ceilingWidened = true;
            yield* principals
              .update({
                id: input.principalId,
                ceiling: [...nextCeiling],
                updatedAt: nowIso,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new MembershipInternalError({ operation: "upsertFromInvitation", cause }),
                ),
              );
          }

          if (input.projectId !== null) {
            const existingMembership = yield* memberships
              .get(input.projectId, input.principalId)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new MembershipInternalError({ operation: "upsertFromInvitation", cause }),
                ),
              );
            yield* memberships
              .upsert({
                projectId: input.projectId,
                principalId: input.principalId,
                role: input.role,
                state: "active",
                invitedBy: input.invitedBy,
                expiresAt: null,
                updatedAt: nowIso,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new MembershipInternalError({ operation: "upsertFromInvitation", cause }),
                ),
              );
            yield* auditEvents
              .append({
                at: nowIso,
                actorPrincipalId: input.invitedBy,
                actorSessionId: input.audit?.sessionId ?? null,
                action: "membership.role.changed",
                resourceType: "membership",
                resourceId: `${input.projectId}:${input.principalId}`,
                projectId: input.projectId,
                ip: input.audit?.ip ?? null,
                userAgent: input.audit?.userAgent ?? null,
                outcome: "allow",
                metadata: {
                  principalId: input.principalId,
                  previousRole: Option.isSome(existingMembership)
                    ? existingMembership.value.role
                    : null,
                  role: input.role,
                  reason: "invitation_accepted",
                  ...(ceilingWidened ? { ceilingWidened: true } : {}),
                },
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new MembershipInternalError({ operation: "upsertFromInvitation", cause }),
                ),
              );
          }

          const nextRevision = yield* principals
            .bumpAccessRevision(input.principalId, nowIso)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new MembershipInternalError({ operation: "upsertFromInvitation", cause }),
              ),
            );
          const principalMemberships = yield* memberships
            .listForPrincipal(input.principalId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new MembershipInternalError({ operation: "upsertFromInvitation", cause }),
              ),
            );

          return {
            principal: {
              ...targetPrincipal,
              ceiling: [...nextCeiling],
              accessRevision: nextRevision,
              updatedAt: nowIso,
            },
            memberships: principalMemberships,
            ceilingWidened,
          } satisfies UpsertFromInvitationResult;
        }),
      )
      .pipe(
        Effect.mapError(
          mapTransactionError<MembershipMutationError>("upsertFromInvitation", MUTATION_ERROR_TAGS),
        ),
      );
  });

  const transferOwnership = Effect.fn("MembershipService.transferOwnership")(function* (
    input: TransferOwnershipInput,
  ) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (!input.actor.isOwner) {
            return yield* new MembershipForbiddenError({ reason: "owner_required" });
          }

          const maybeOwner = yield* principals.getOwner.pipe(
            Effect.mapError(
              (cause) => new MembershipInternalError({ operation: "transferOwnership", cause }),
            ),
          );
          if (Option.isNone(maybeOwner)) {
            return yield* new MembershipInternalError({
              operation: "transferOwnership",
              cause: new Error("Environment has no owner principal."),
            });
          }
          const currentOwner = maybeOwner.value;
          if (currentOwner.id === input.toPrincipalId) {
            return yield* new MembershipInvalidInputError({ reason: "cannot_transfer_to_self" });
          }

          const maybeTarget = yield* principals
            .get(input.toPrincipalId)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "transferOwnership", cause }),
              ),
            );
          if (Option.isNone(maybeTarget) || maybeTarget.value.status === "removed") {
            return yield* new MembershipNotFoundError({
              resource: "principal",
              principalId: input.toPrincipalId,
            });
          }
          const targetPrincipal = maybeTarget.value;
          if (targetPrincipal.status !== "active" || targetPrincipal.kind !== "member") {
            return yield* new MembershipInvalidInputError({ reason: "invalid_transfer_target" });
          }

          const trimmedConfirmation = input.confirmation.trim();
          const confirmationMatches =
            trimmedConfirmation === targetPrincipal.id ||
            trimmedConfirmation === targetPrincipal.displayName ||
            trimmedConfirmation === "TRANSFER";
          if (!confirmationMatches) {
            return yield* new MembershipInvalidInputError({
              reason: "invalid_transfer_confirmation",
            });
          }

          const projectRows = yield* sql<{ readonly projectId: string }>`
            SELECT project_id AS "projectId"
            FROM projection_projects
            WHERE deleted_at IS NULL
            ORDER BY project_id
          `.pipe(
            Effect.mapError(
              (cause) => new MembershipInternalError({ operation: "transferOwnership", cause }),
            ),
          );
          const existingOwnerMemberships = yield* memberships
            .listForPrincipal(currentOwner.id)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "transferOwnership", cause }),
              ),
            );

          const adminProjectSet = new Set<ProjectId>();
          for (const row of projectRows) {
            adminProjectSet.add(ProjectId.make(row.projectId));
          }
          for (const membership of existingOwnerMemberships) {
            if (membership.state !== "removed") {
              adminProjectSet.add(membership.projectId);
            }
          }
          const adminProjectIds = [...adminProjectSet].toSorted();

          for (const projectId of adminProjectIds) {
            yield* memberships
              .upsert({
                projectId,
                principalId: currentOwner.id,
                role: "admin",
                state: "active",
                invitedBy: currentOwner.id,
                expiresAt: null,
                updatedAt: nowIso,
              })
              .pipe(
                Effect.mapError(
                  (cause) => new MembershipInternalError({ operation: "transferOwnership", cause }),
                ),
              );
          }

          const staffCeiling = [...ceilingScopes("staff")];
          // Demote the outgoing owner first so the partial unique index (kind = 'owner') never collides.
          yield* principals
            .update({
              id: currentOwner.id,
              kind: "member",
              status: "active",
              ceiling: staffCeiling,
              updatedAt: nowIso,
              bumpAccessRevision: true,
            })
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "transferOwnership", cause }),
              ),
            );
          // Downgrade environment-bound sessions so live sessions immediately honor the new member role.
          yield* sessionPrincipals
            .downgradeEnvironmentBindingsForPrincipal(currentOwner.id)
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "transferOwnership", cause }),
              ),
            );
          yield* principals
            .update({
              id: targetPrincipal.id,
              kind: "owner",
              status: "active",
              ceiling: [],
              updatedAt: nowIso,
              bumpAccessRevision: true,
            })
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "transferOwnership", cause }),
              ),
            );

          const ownerCount = yield* principals.countOwners.pipe(
            Effect.mapError(
              (cause) => new MembershipInternalError({ operation: "transferOwnership", cause }),
            ),
          );
          if (ownerCount !== 1) {
            return yield* new MembershipInternalError({
              operation: "transferOwnership",
              cause: new Error(`Expected exactly 1 owner after transfer, found ${ownerCount}.`),
            });
          }

          yield* auditEvents
            .append({
              at: nowIso,
              actorPrincipalId: currentOwner.id,
              actorSessionId: actorSessionId(input.actor, input.audit),
              action: "owner.transferred",
              resourceType: "principal",
              resourceId: targetPrincipal.id,
              projectId: null,
              ip: input.audit?.ip ?? null,
              userAgent: input.audit?.userAgent ?? null,
              outcome: "allow",
              metadata: {
                fromPrincipalId: currentOwner.id,
                toPrincipalId: targetPrincipal.id,
                adminProjectIds,
              },
            })
            .pipe(
              Effect.mapError(
                (cause) => new MembershipInternalError({ operation: "transferOwnership", cause }),
              ),
            );

          const previousOwner: Principal = {
            ...currentOwner,
            kind: "member",
            status: "active",
            ceiling: staffCeiling,
            accessRevision: currentOwner.accessRevision + 1,
            updatedAt: nowIso,
          };
          const newOwner: Principal = {
            ...targetPrincipal,
            kind: "owner",
            status: "active",
            ceiling: [],
            accessRevision: targetPrincipal.accessRevision + 1,
            updatedAt: nowIso,
          };

          return {
            previousOwner,
            newOwner,
            adminProjectIds,
          } satisfies OwnerTransferResult;
        }),
      )
      .pipe(
        Effect.mapError(
          mapTransactionError<TransferOwnershipError>("transferOwnership", MUTATION_ERROR_TAGS),
        ),
      );
  });

  return MembershipService.of({
    listForActor,
    setRole,
    setMembershipState,
    removeFromProject,
    removePrincipal,
    setCeiling,
    suspendPrincipal,
    reactivatePrincipal,
    updateMember,
    canIssueInvite,
    grantCreatorAdmin,
    upsertFromInvitation,
    transferOwnership,
  });
});

export const layer = Layer.effect(MembershipService, make);
