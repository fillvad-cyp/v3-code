import {
  AuthAdministrativeClientScopes,
  AuthEnvironmentScope,
  AuthSessionId,
  InvitationId,
  PrincipalId,
  type Invitation,
  type Principal,
  type ProjectId,
  type ProjectMembership,
  type ProjectRole,
  boundProjectRole,
  ceilingScopes,
  intersectScopes,
  roleAtLeast,
  roleFitsCeiling,
  roleHasCapability,
  roleScopes,
  scopesFitCeiling,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as InvitationCodes from "./InvitationCodes.ts";

export const OWNER_PRINCIPAL_ID = PrincipalId.make("owner");
const DEFAULT_INVITATION_TTL = Duration.days(7);
const isAuthEnvironmentScope = Schema.is(AuthEnvironmentScope);

export const InvitationInvalidReason = Schema.Literals([
  "malformed_code",
  "not_found",
  "revoked",
  "invalid_display_name",
]);
export type InvitationInvalidReason = typeof InvitationInvalidReason.Type;

export class InvitationInvalidError extends Schema.TaggedError<InvitationInvalidError>()(
  "InvitationInvalidError",
  {
    reason: InvitationInvalidReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "malformed_code":
        return "The invitation code format is invalid.";
      case "not_found":
        return "The invitation code was not found.";
      case "revoked":
        return "This invitation has been revoked.";
      case "invalid_display_name":
        return "A non-empty display name is required.";
    }
  }
}

export class InvitationExpiredError extends Schema.TaggedError<InvitationExpiredError>()(
  "InvitationExpiredError",
  {
    invitationId: Schema.optionalKey(InvitationId),
  },
) {
  override get message(): string {
    return "This invitation has expired.";
  }
}

export class InvitationAlreadyUsedError extends Schema.TaggedError<InvitationAlreadyUsedError>()(
  "InvitationAlreadyUsedError",
  {
    invitationId: Schema.optionalKey(InvitationId),
  },
) {
  override get message(): string {
    return "This invitation has already been used.";
  }
}

export const InvitationForbiddenReason = Schema.Literals([
  "not_authorized",
  "environment_invite_requires_owner",
  "owner_role_not_invitable",
  "role_exceeds_issuer",
  "ceiling_exceeds_issuer",
  "invitation_not_in_scope",
]);
export type InvitationForbiddenReason = typeof InvitationForbiddenReason.Type;

export class InvitationForbiddenError extends Schema.TaggedError<InvitationForbiddenError>()(
  "InvitationForbiddenError",
  {
    reason: InvitationForbiddenReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_authorized":
        return "You do not have permission to manage invitations for this project.";
      case "environment_invite_requires_owner":
        return "Only the owner may issue an environment-wide invitation.";
      case "owner_role_not_invitable":
        return "Invitations cannot grant the owner role.";
      case "role_exceeds_issuer":
        return "You cannot invite a member with a higher role than your own.";
      case "ceiling_exceeds_issuer":
        return "The requested role exceeds your scope ceiling.";
      case "invitation_not_in_scope":
        return "You do not have permission to manage this invitation.";
    }
  }
}

export class InvitationInternalError extends Schema.TaggedError<InvitationInternalError>()(
  "InvitationInternalError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invitation operation failed (${this.operation}).`;
  }
}

export interface InvitationAuditContext {
  readonly sessionId?: AuthSessionId | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface IssueInvitationInput {
  readonly kind?: "staff";
  readonly role: ProjectRole;
  readonly projectId: ProjectId | null;
  readonly ceiling?: ReadonlyArray<AuthEnvironmentScope>;
  readonly createdBy: PrincipalId;
  /** Resolved session actor when called from HTTP, preserving any session binding limits. */
  readonly actor?: ProjectAccess.AccessActor;
  readonly ttl?: Duration.Duration;
  readonly audit?: InvitationAuditContext;
}

export interface IssuedInvitation {
  readonly invitation: Invitation;
  readonly code: string;
}

export interface ConsumeInvitationInput {
  readonly code: string;
  readonly displayName: string;
  readonly audit?: InvitationAuditContext;
}

export interface ConsumedInvitation {
  readonly invitation: Invitation;
  readonly principal: Principal;
  readonly memberships: ReadonlyArray<ProjectMembership>;
}

export interface ListPendingInvitationsInput {
  readonly actorId: PrincipalId;
  readonly actor?: ProjectAccess.AccessActor;
  readonly projectId?: ProjectId;
}

export interface RevokeInvitationInput {
  readonly id: InvitationId;
  readonly revokedBy: PrincipalId;
  readonly actor?: ProjectAccess.AccessActor;
  readonly audit?: InvitationAuditContext;
}

export type IssueInvitationError = InvitationForbiddenError | InvitationInternalError;
export type ConsumeInvitationError =
  | InvitationInvalidError
  | InvitationExpiredError
  | InvitationAlreadyUsedError
  | InvitationInternalError;
export type ListPendingInvitationsError = InvitationForbiddenError | InvitationInternalError;
export type RevokeInvitationError = InvitationForbiddenError | InvitationInternalError;

export class InvitationService extends Context.Service<
  InvitationService,
  {
    readonly issue: (
      input: IssueInvitationInput,
    ) => Effect.Effect<IssuedInvitation, IssueInvitationError>;
    readonly consume: (
      input: ConsumeInvitationInput,
    ) => Effect.Effect<ConsumedInvitation, ConsumeInvitationError>;
    readonly listPending: (
      input: ListPendingInvitationsInput,
    ) => Effect.Effect<ReadonlyArray<Invitation>, ListPendingInvitationsError>;
    readonly revoke: (
      input: RevokeInvitationInput,
    ) => Effect.Effect<boolean, RevokeInvitationError>;
  }
>()("v3code/identity/InvitationService") {}

function actorRoleOnProject(
  actor: ProjectAccess.AccessActor,
  projectId: ProjectId,
): ProjectRole | undefined {
  if (actor.isOwner) return "owner";
  return actor.binding?._tag === "projects"
    ? boundProjectRole(actor.binding, projectId)
    : actor.roles.get(projectId);
}

function actorAdminProjects(
  projectAccess: ProjectAccess.ProjectAccess["Service"],
  actor: ProjectAccess.AccessActor,
): ReadonlyArray<string> {
  const candidates =
    actor.binding?._tag === "projects"
      ? actor.binding.projects.map((entry) => entry.projectId)
      : [...actor.roles.keys()];
  return candidates.filter((projectId) => projectAccess.can(actor, projectId, "project:members"));
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const invitations = yield* Invitations.InvitationRepository;
  const principals = yield* Principals.PrincipalRepository;
  const memberships = yield* Memberships.MembershipRepository;
  const auditEvents = yield* AuditEvents.AuditEventRepository;
  const projectAccess = yield* ProjectAccess.ProjectAccess;
  const codes = yield* InvitationCodes.make();

  const resolveActor = Effect.fnUntraced(function* (
    principalId: PrincipalId,
    providedActor: ProjectAccess.AccessActor | undefined,
    operation: string,
  ): Effect.fn.Return<
    ProjectAccess.AccessActor,
    InvitationForbiddenError | InvitationInternalError
  > {
    if (providedActor !== undefined) {
      return providedActor;
    }
    return yield* projectAccess
      .resolve({
        sessionId: AuthSessionId.make("invitation-actor"),
        subject: `principal:${principalId}`,
        scopes: AuthAdministrativeClientScopes,
        principalId,
        binding: { _tag: "principal" },
      })
      .pipe(
        Effect.mapError((error) =>
          error.reason === "repository_error"
            ? new InvitationInternalError({ operation, cause: error })
            : new InvitationForbiddenError({ reason: "not_authorized" }),
        ),
      );
  });

  const issue = Effect.fn("InvitationService.issue")(function* (input: IssueInvitationInput) {
    if (input.role === "owner") {
      return yield* new InvitationForbiddenError({ reason: "owner_role_not_invitable" });
    }

    const actor = yield* resolveActor(input.createdBy, input.actor, "issue");
    const requestedCeiling = input.ceiling ?? ceilingScopes("staff");
    let effectiveCeiling: ReadonlyArray<AuthEnvironmentScope> = requestedCeiling;

    if (!actor.isOwner) {
      if (input.projectId === null) {
        return yield* new InvitationForbiddenError({ reason: "environment_invite_requires_owner" });
      }
      const actorRole = actorRoleOnProject(actor, input.projectId);
      if (
        actorRole === undefined ||
        !projectAccess.can(actor, input.projectId, "project:members") ||
        !roleHasCapability(actorRole, "project:members")
      ) {
        return yield* new InvitationForbiddenError({ reason: "not_authorized" });
      }
      if (!roleAtLeast(actorRole, input.role)) {
        return yield* new InvitationForbiddenError({ reason: "role_exceeds_issuer" });
      }
      const issuerCeiling = actor.ceiling ?? projectAccess.effectiveScopes(actor);
      if (!roleFitsCeiling(issuerCeiling, input.role)) {
        return yield* new InvitationForbiddenError({ reason: "ceiling_exceeds_issuer" });
      }
      if (
        input.actor !== undefined &&
        !scopesFitCeiling(projectAccess.effectiveScopes(actor), roleScopes(input.role))
      ) {
        return yield* new InvitationForbiddenError({ reason: "ceiling_exceeds_issuer" });
      }
      effectiveCeiling = intersectScopes(requestedCeiling, issuerCeiling);
      if (!roleFitsCeiling(effectiveCeiling, input.role)) {
        return yield* new InvitationForbiddenError({ reason: "ceiling_exceeds_issuer" });
      }
    }

    const id = InvitationId.make(
      yield* random
        .uuidV4()
        .pipe(
          Effect.mapError((cause) => new InvitationInternalError({ operation: "issue", cause })),
        ),
    );
    const { code, tokenHash } = yield* codes
      .generate()
      .pipe(Effect.mapError((cause) => new InvitationInternalError({ operation: "issue", cause })));

    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);
    const expiresAt = DateTime.formatIso(
      DateTime.addDuration(now, input.ttl ?? DEFAULT_INVITATION_TTL),
    );
    const kind = input.kind ?? "staff";

    yield* invitations
      .create({
        id,
        tokenHash,
        email: null,
        kind,
        role: input.role,
        projectId: input.projectId,
        ceiling: [...effectiveCeiling],
        createdBy: input.createdBy,
        createdAt,
        expiresAt,
      })
      .pipe(Effect.mapError((cause) => new InvitationInternalError({ operation: "issue", cause })));

    yield* auditEvents
      .append({
        at: createdAt,
        actorPrincipalId: input.createdBy,
        actorSessionId: input.audit?.sessionId ?? null,
        action: "invitation.created",
        resourceType: "invitation",
        resourceId: id,
        projectId: input.projectId,
        ip: input.audit?.ip ?? null,
        userAgent: input.audit?.userAgent ?? null,
        outcome: "allow",
        metadata: {
          kind,
          role: input.role,
          projectId: input.projectId,
        },
      })
      .pipe(Effect.mapError((cause) => new InvitationInternalError({ operation: "issue", cause })));

    const invitation: Invitation = {
      id,
      email: null,
      kind,
      role: input.role,
      projectId: input.projectId,
      ceiling: [...effectiveCeiling],
      createdBy: input.createdBy,
      createdAt,
      expiresAt,
      acceptedAt: null,
      revokedAt: null,
    };

    return { invitation, code } satisfies IssuedInvitation;
  });

  const consume = Effect.fn("InvitationService.consume")(function* (input: ConsumeInvitationInput) {
    const displayName = input.displayName.trim();
    if (displayName.length === 0) {
      return yield* new InvitationInvalidError({ reason: "invalid_display_name" });
    }
    const canonical = InvitationCodes.normalizeInvitationCode(input.code);
    if (canonical === undefined) {
      return yield* new InvitationInvalidError({ reason: "malformed_code" });
    }

    const tokenHash = yield* codes
      .hash(canonical)
      .pipe(
        Effect.mapError((cause) => new InvitationInternalError({ operation: "consume", cause })),
      );
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const consumed = yield* invitations
            .consume({ tokenHash, now: nowIso })
            .pipe(
              Effect.mapError(
                (cause) => new InvitationInternalError({ operation: "consume", cause }),
              ),
            );

          if (Option.isNone(consumed)) {
            const existing = yield* invitations
              .getByTokenHash(tokenHash)
              .pipe(
                Effect.mapError(
                  (cause) => new InvitationInternalError({ operation: "consume", cause }),
                ),
              );
            if (Option.isNone(existing)) {
              return yield* new InvitationInvalidError({ reason: "not_found" });
            }
            if (existing.value.acceptedAt !== null) {
              return yield* new InvitationAlreadyUsedError({ invitationId: existing.value.id });
            }
            if (existing.value.revokedAt !== null) {
              return yield* new InvitationInvalidError({ reason: "revoked" });
            }
            return yield* new InvitationExpiredError({ invitationId: existing.value.id });
          }

          const invitation = consumed.value;
          const principalId = PrincipalId.make(
            yield* random
              .uuidV4()
              .pipe(
                Effect.mapError(
                  (cause) => new InvitationInternalError({ operation: "consume", cause }),
                ),
              ),
          );
          const invitationCeiling = invitation.ceiling.filter(isAuthEnvironmentScope);
          const principalCeiling =
            invitationCeiling.length > 0 ? invitationCeiling : [...ceilingScopes("staff")];

          yield* principals
            .create({
              id: principalId,
              kind: invitation.kind === "client" ? "external" : "member",
              displayName,
              email: invitation.email,
              status: "active",
              ceiling: [...principalCeiling],
              createdAt: nowIso,
            })
            .pipe(
              Effect.mapError(
                (cause) => new InvitationInternalError({ operation: "consume", cause }),
              ),
            );

          if (invitation.projectId !== null) {
            yield* memberships
              .upsert({
                projectId: invitation.projectId,
                principalId,
                role: invitation.role,
                state: "active",
                invitedBy: invitation.createdBy,
                expiresAt: null,
                updatedAt: nowIso,
              })
              .pipe(
                Effect.mapError(
                  (cause) => new InvitationInternalError({ operation: "consume", cause }),
                ),
              );
          }

          const principalMemberships = yield* memberships
            .listForPrincipal(principalId)
            .pipe(
              Effect.mapError(
                (cause) => new InvitationInternalError({ operation: "consume", cause }),
              ),
            );

          yield* auditEvents
            .append({
              at: nowIso,
              actorPrincipalId: principalId,
              actorSessionId: input.audit?.sessionId ?? null,
              action: "invitation.accepted",
              resourceType: "invitation",
              resourceId: invitation.id,
              projectId: invitation.projectId,
              ip: input.audit?.ip ?? null,
              userAgent: input.audit?.userAgent ?? null,
              outcome: "allow",
              metadata: {
                principalId,
                role: invitation.role,
                projectId: invitation.projectId,
              },
            })
            .pipe(
              Effect.mapError(
                (cause) => new InvitationInternalError({ operation: "consume", cause }),
              ),
            );

          const principal: Principal = {
            id: principalId,
            kind: invitation.kind === "client" ? "external" : "member",
            displayName,
            email: invitation.email,
            status: "active",
            ceiling: [...principalCeiling],
            accessRevision: 0,
            createdAt: nowIso,
            updatedAt: nowIso,
            removedAt: null,
          };

          return {
            invitation,
            principal,
            memberships: principalMemberships,
          } satisfies ConsumedInvitation;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "InvitationInvalidError" ||
          error._tag === "InvitationExpiredError" ||
          error._tag === "InvitationAlreadyUsedError" ||
          error._tag === "InvitationInternalError"
            ? error
            : new InvitationInternalError({ operation: "consume", cause: error }),
        ),
      );
  });

  const listPending = Effect.fn("InvitationService.listPending")(function* (
    input: ListPendingInvitationsInput,
  ) {
    const actor = yield* resolveActor(input.actorId, input.actor, "listPending");
    const nowIso = DateTime.formatIso(yield* DateTime.now);

    if (actor.isOwner) {
      return yield* invitations
        .listPending({
          now: nowIso,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        })
        .pipe(
          Effect.mapError(
            (cause) => new InvitationInternalError({ operation: "listPending", cause }),
          ),
        );
    }

    if (input.projectId !== undefined) {
      if (!projectAccess.can(actor, input.projectId, "project:members")) {
        return yield* new InvitationForbiddenError({ reason: "not_authorized" });
      }
      return yield* invitations
        .listPending({ now: nowIso, projectId: input.projectId })
        .pipe(
          Effect.mapError(
            (cause) => new InvitationInternalError({ operation: "listPending", cause }),
          ),
        );
    }

    const adminProjects = new Set(actorAdminProjects(projectAccess, actor));
    if (adminProjects.size === 0) {
      return yield* new InvitationForbiddenError({ reason: "not_authorized" });
    }
    const allPending = yield* invitations
      .listPending({ now: nowIso })
      .pipe(
        Effect.mapError(
          (cause) => new InvitationInternalError({ operation: "listPending", cause }),
        ),
      );
    return allPending.filter(
      (invitation) => invitation.projectId !== null && adminProjects.has(invitation.projectId),
    );
  });

  const revoke = Effect.fn("InvitationService.revoke")(function* (input: RevokeInvitationInput) {
    const actor = yield* resolveActor(input.revokedBy, input.actor, "revoke");
    const existing = yield* invitations
      .getById(input.id)
      .pipe(
        Effect.mapError((cause) => new InvitationInternalError({ operation: "revoke", cause })),
      );

    if (Option.isNone(existing)) {
      if (!actor.isOwner && actorAdminProjects(projectAccess, actor).length === 0) {
        return yield* new InvitationForbiddenError({ reason: "not_authorized" });
      }
      return false;
    }

    const target = existing.value;
    if (!actor.isOwner) {
      if (
        target.projectId === null ||
        !projectAccess.can(actor, target.projectId, "project:members")
      ) {
        return yield* new InvitationForbiddenError({ reason: "invitation_not_in_scope" });
      }
    }

    const revokedAt = DateTime.formatIso(yield* DateTime.now);
    const revoked = yield* invitations
      .revoke({ id: input.id, revokedAt })
      .pipe(
        Effect.mapError((cause) => new InvitationInternalError({ operation: "revoke", cause })),
      );

    if (revoked) {
      yield* auditEvents
        .append({
          at: revokedAt,
          actorPrincipalId: input.revokedBy,
          actorSessionId: input.audit?.sessionId ?? null,
          action: "invitation.revoked",
          resourceType: "invitation",
          resourceId: target.id,
          projectId: target.projectId,
          ip: input.audit?.ip ?? null,
          userAgent: input.audit?.userAgent ?? null,
          outcome: "allow",
          metadata: {
            role: target.role,
            projectId: target.projectId,
          },
        })
        .pipe(
          Effect.mapError((cause) => new InvitationInternalError({ operation: "revoke", cause })),
        );
    }

    return revoked;
  });

  return InvitationService.of({
    issue,
    consume,
    listPending,
    revoke,
  });
});

export const layer = Layer.effect(InvitationService, make);
