import {
  type ApiToken,
  type ApiTokenBindingInput,
  type ApiTokenCreateResult,
  ApiTokenId,
  type ApiTokenListItem,
  AuthAdministrativeClientScopes,
  AuthEnvironmentScope,
  AuthGrantScope,
  type AuthSessionId,
  PrincipalId,
  type ProjectRole,
  boundProjectRole,
  capabilitiesForRole,
  intersectScopes,
  roleAtLeast,
  roleHasCapability,
  roleScopes,
  scopesFitCeiling,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as ApiTokenCodes from "./ApiTokenCodes.ts";

const OWNER_PRINCIPAL_ID = PrincipalId.make("owner");
const DEFAULT_MAX_API_TOKENS = 10;

const isAuthGrantScope = Schema.is(AuthGrantScope);
const isAuthEnvironmentScope = Schema.is(AuthEnvironmentScope);

export const ApiTokenInvalidInputReason = Schema.Literals([
  "empty_scopes",
  "invalid_scope",
  "invalid_binding",
  "duplicate_project",
  "owner_role_not_bindable",
  "invalid_expiration",
  "principal_inactive",
]);
export type ApiTokenInvalidInputReason = typeof ApiTokenInvalidInputReason.Type;

export class ApiTokenInvalidInputError extends Schema.TaggedError<ApiTokenInvalidInputError>()(
  "ApiTokenInvalidInputError",
  {
    reason: ApiTokenInvalidInputReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "empty_scopes":
        return "An API token must grant at least one scope.";
      case "invalid_scope":
        return "One or more requested API token scopes are invalid.";
      case "invalid_binding":
        return "A project-bound API token must name at least one project.";
      case "duplicate_project":
        return "Each bound project may only appear once.";
      case "owner_role_not_bindable":
        return "The owner role cannot be used in a project binding.";
      case "invalid_expiration":
        return "The expiration timestamp must be a valid future ISO date.";
      case "principal_inactive":
        return "API tokens can only be created for an active principal.";
    }
  }
}

export const ApiTokenForbiddenReason = Schema.Literals([
  "not_authorized",
  "project_not_accessible",
  "role_exceeds_membership",
  "binding_exceeds_actor",
  "scope_exceeds_ceiling",
]);
export type ApiTokenForbiddenReason = typeof ApiTokenForbiddenReason.Type;

export class ApiTokenForbiddenError extends Schema.TaggedError<ApiTokenForbiddenError>()(
  "ApiTokenForbiddenError",
  {
    reason: ApiTokenForbiddenReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_authorized":
        return "You do not have permission to manage API tokens for this principal.";
      case "project_not_accessible":
        return "The target principal does not have active access to one or more bound projects.";
      case "role_exceeds_membership":
        return "A bound project role exceeds the principal's role on that project.";
      case "binding_exceeds_actor":
        return "A project-bound session cannot issue a wider API token binding.";
      case "scope_exceeds_ceiling":
        return "The requested scopes exceed the principal's allowed ceiling and roles.";
    }
  }
}

export class ApiTokenNotFoundError extends Schema.TaggedError<ApiTokenNotFoundError>()(
  "ApiTokenNotFoundError",
  {
    resource: Schema.Literals(["principal", "api_token"]),
  },
) {
  override get message(): string {
    return this.resource === "principal"
      ? "The target principal was not found."
      : "The requested API token was not found.";
  }
}

export class ApiTokenLimitExceededError extends Schema.TaggedError<ApiTokenLimitExceededError>()(
  "ApiTokenLimitExceededError",
  {
    principalId: PrincipalId,
    limit: Schema.Number,
  },
) {
  override get message(): string {
    return `Active API token limit reached (${this.limit}). Revoke an existing token before creating another.`;
  }
}

export class ApiTokenInternalError extends Schema.TaggedError<ApiTokenInternalError>()(
  "ApiTokenInternalError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `API token operation failed (${this.operation}).`;
  }
}

export interface ApiTokenAuditContext {
  readonly sessionId?: AuthSessionId | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface CreateApiTokenForActorInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly principalId?: PrincipalId;
  readonly scopes: ReadonlyArray<string>;
  readonly binding: ApiTokenBindingInput;
  readonly expiresAt?: string | null;
  readonly audit?: ApiTokenAuditContext;
}

export interface ListApiTokensForActorInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly principalId?: PrincipalId;
}

export interface RevokeApiTokenForActorInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly id: ApiTokenId;
  readonly audit?: ApiTokenAuditContext;
}

export type CreateApiTokenError =
  | ApiTokenInvalidInputError
  | ApiTokenForbiddenError
  | ApiTokenNotFoundError
  | ApiTokenLimitExceededError
  | ApiTokenInternalError;

export type ListApiTokensError = ApiTokenForbiddenError | ApiTokenInternalError;

export type RevokeApiTokenError = ApiTokenForbiddenError | ApiTokenInternalError;

export class ApiTokenService extends Context.Service<
  ApiTokenService,
  {
    readonly create: (
      input: CreateApiTokenForActorInput,
    ) => Effect.Effect<ApiTokenCreateResult, CreateApiTokenError>;
    readonly listForActor: (
      input: ListApiTokensForActorInput,
    ) => Effect.Effect<ReadonlyArray<ApiTokenListItem>, ListApiTokensError>;
    readonly revoke: (
      input: RevokeApiTokenForActorInput,
    ) => Effect.Effect<boolean, RevokeApiTokenError>;
  }
>()("v3code/identity/ApiTokenService") {}

/** Checks both role rank and capability inclusion so sibling roles (`operator` vs `manager`) cannot cross-grant. */
function roleFitsGrantedRole(granted: ProjectRole, requested: ProjectRole): boolean {
  return (
    roleAtLeast(granted, requested) &&
    capabilitiesForRole(requested).every((capability) => roleHasCapability(granted, capability))
  );
}

function actorPrincipalIdOf(actor: ProjectAccess.AccessActor): PrincipalId {
  return actor.principalId ?? OWNER_PRINCIPAL_ID;
}

function auditProjectIdForBinding(binding: ApiToken["binding"]) {
  return binding._tag === "projects" && binding.projects.length === 1
    ? binding.projects[0]!.projectId
    : null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const apiTokens = yield* ApiTokens.ApiTokenRepository;
  const principals = yield* Principals.PrincipalRepository;
  const memberships = yield* Memberships.MembershipRepository;
  const memberLimits = yield* MemberLimits.MemberLimitsRepository;
  const auditEvents = yield* AuditEvents.AuditEventRepository;
  const projectAccess = yield* ProjectAccess.ProjectAccess;
  const codes = yield* ApiTokenCodes.make();

  const create = Effect.fn("ApiTokenService.create")(function* (
    input: CreateApiTokenForActorInput,
  ) {
    const actorPrincipalId = actorPrincipalIdOf(input.actor);
    const targetPrincipalId = input.principalId ?? actorPrincipalId;

    if (!input.actor.isOwner && targetPrincipalId !== actorPrincipalId) {
      return yield* new ApiTokenForbiddenError({ reason: "not_authorized" });
    }

    const dedupedScopes: Array<AuthGrantScope> = [];
    const seenScopes = new Set<string>();
    for (const rawScope of input.scopes) {
      if (!isAuthGrantScope(rawScope)) {
        return yield* new ApiTokenInvalidInputError({ reason: "invalid_scope" });
      }
      if (!seenScopes.has(rawScope)) {
        seenScopes.add(rawScope);
        dedupedScopes.push(rawScope);
      }
    }
    if (dedupedScopes.length === 0) {
      return yield* new ApiTokenInvalidInputError({ reason: "empty_scopes" });
    }

    const now = yield* DateTime.now;
    const nowMs = now.epochMilliseconds;
    const nowIso = DateTime.formatIso(now);

    let normalizedExpiresAt: string | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      const parsedMs = Date.parse(input.expiresAt);
      if (!Number.isFinite(parsedMs) || parsedMs <= nowMs) {
        return yield* new ApiTokenInvalidInputError({ reason: "invalid_expiration" });
      }
      normalizedExpiresAt = DateTime.formatIso(DateTime.makeUnsafe(parsedMs));
    }

    if (input.binding._tag === "projects") {
      if (input.binding.projects.length === 0) {
        return yield* new ApiTokenInvalidInputError({ reason: "invalid_binding" });
      }
      const seenProjects = new Set<string>();
      for (const entry of input.binding.projects) {
        if (seenProjects.has(entry.projectId)) {
          return yield* new ApiTokenInvalidInputError({ reason: "duplicate_project" });
        }
        seenProjects.add(entry.projectId);
        if (entry.role === "owner") {
          return yield* new ApiTokenInvalidInputError({ reason: "owner_role_not_bindable" });
        }
      }
    }

    if (input.actor.binding?._tag === "projects") {
      if (input.binding._tag !== "projects") {
        return yield* new ApiTokenForbiddenError({ reason: "binding_exceeds_actor" });
      }
      for (const entry of input.binding.projects) {
        const actorRole = boundProjectRole(input.actor.binding, entry.projectId);
        if (actorRole === undefined) {
          return yield* new ApiTokenForbiddenError({ reason: "binding_exceeds_actor" });
        }
        if (!roleFitsGrantedRole(actorRole, entry.role)) {
          return yield* new ApiTokenForbiddenError({ reason: "role_exceeds_membership" });
        }
      }
    }

    const maybeTarget = yield* principals
      .get(targetPrincipalId)
      .pipe(Effect.mapError((cause) => new ApiTokenInternalError({ operation: "create", cause })));
    if (Option.isNone(maybeTarget)) {
      return yield* new ApiTokenNotFoundError({ resource: "principal" });
    }
    const targetPrincipal = maybeTarget.value;
    if (targetPrincipal.status !== "active") {
      return yield* new ApiTokenInvalidInputError({ reason: "principal_inactive" });
    }

    let allowedScopes: ReadonlyArray<AuthEnvironmentScope>;
    if (targetPrincipal.kind === "owner") {
      if (input.binding._tag === "projects") {
        allowedScopes = [
          ...new Set(input.binding.projects.flatMap((entry) => roleScopes(entry.role))),
        ];
      } else {
        allowedScopes = AuthAdministrativeClientScopes;
      }
    } else {
      const targetCeiling = targetPrincipal.ceiling.filter(isAuthEnvironmentScope);
      const membershipRows = yield* memberships
        .listForPrincipal(targetPrincipal.id)
        .pipe(
          Effect.mapError((cause) => new ApiTokenInternalError({ operation: "create", cause })),
        );
      const activeByProject = new Map(
        membershipRows
          .filter((row) => row.state === "active")
          .map((row) => [row.projectId, row.role] as const),
      );

      if (input.binding._tag === "projects") {
        for (const entry of input.binding.projects) {
          const boundRole = boundProjectRole(input.binding, entry.projectId);
          const liveRole = activeByProject.get(entry.projectId);
          if (boundRole === undefined || liveRole === undefined) {
            return yield* new ApiTokenForbiddenError({ reason: "project_not_accessible" });
          }
          if (!roleFitsGrantedRole(liveRole, boundRole)) {
            return yield* new ApiTokenForbiddenError({ reason: "role_exceeds_membership" });
          }
        }
        const boundScopeUnion = [
          ...new Set(input.binding.projects.flatMap((entry) => roleScopes(entry.role))),
        ];
        allowedScopes = intersectScopes(boundScopeUnion, targetCeiling);
      } else {
        const activeRoleUnion = [
          ...new Set([...activeByProject.values()].flatMap((role) => roleScopes(role))),
        ];
        allowedScopes = intersectScopes(activeRoleUnion, targetCeiling);
      }
    }

    const actorEffectiveScopes = projectAccess.effectiveScopes(input.actor);
    if (!input.actor.isOwner || targetPrincipal.id === actorPrincipalId) {
      allowedScopes = intersectScopes(allowedScopes, actorEffectiveScopes);
    }

    if (!scopesFitCeiling(allowedScopes, dedupedScopes)) {
      return yield* new ApiTokenForbiddenError({ reason: "scope_exceeds_ceiling" });
    }

    const id = ApiTokenId.make(
      yield* random
        .uuidV4()
        .pipe(
          Effect.mapError((cause) => new ApiTokenInternalError({ operation: "create", cause })),
        ),
    );
    const { rawToken, tokenHmac } = yield* codes
      .generate()
      .pipe(Effect.mapError((cause) => new ApiTokenInternalError({ operation: "create", cause })));

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (targetPrincipal.kind !== "owner") {
            const [limits, existingTokens] = yield* Effect.all([
              memberLimits.get(targetPrincipal.id),
              apiTokens.listForPrincipal(targetPrincipal.id),
            ]).pipe(
              Effect.mapError((cause) => new ApiTokenInternalError({ operation: "create", cause })),
            );

            const maxApiTokens = limits?.maxApiTokens ?? DEFAULT_MAX_API_TOKENS;
            const activeCount = existingTokens.filter(
              (token) =>
                token.revokedAt === null &&
                (token.expiresAt === null || Date.parse(token.expiresAt) > nowMs),
            ).length;

            if (activeCount >= maxApiTokens) {
              return yield* new ApiTokenLimitExceededError({
                principalId: targetPrincipal.id,
                limit: maxApiTokens,
              });
            }
          }

          yield* apiTokens
            .create({
              id,
              principalId: targetPrincipal.id,
              tokenHmac,
              scopes: dedupedScopes,
              binding: input.binding,
              expiresAt: normalizedExpiresAt,
              createdAt: nowIso,
            })
            .pipe(
              Effect.mapError((cause) => new ApiTokenInternalError({ operation: "create", cause })),
            );

          yield* auditEvents
            .append({
              at: nowIso,
              actorPrincipalId,
              actorSessionId: input.audit?.sessionId ?? null,
              action: "token.created",
              resourceType: "api_token",
              resourceId: id,
              projectId: auditProjectIdForBinding(input.binding),
              ip: input.audit?.ip ?? null,
              userAgent: input.audit?.userAgent ?? null,
              outcome: "allow",
              metadata: {
                principalId: targetPrincipal.id,
                bindingKind: input.binding._tag,
                ...(input.binding._tag === "projects"
                  ? { projectIds: input.binding.projects.map((entry) => entry.projectId) }
                  : {}),
                scopes: dedupedScopes,
                expiresAt: normalizedExpiresAt,
              },
            })
            .pipe(
              Effect.mapError((cause) => new ApiTokenInternalError({ operation: "create", cause })),
            );

          const apiToken: ApiToken = {
            id,
            principalId: targetPrincipal.id,
            scopes: dedupedScopes,
            binding: input.binding,
            expiresAt: normalizedExpiresAt,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: nowIso,
          };

          return { apiToken, token: rawToken } satisfies ApiTokenCreateResult;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ApiTokenLimitExceededError" || error._tag === "ApiTokenInternalError"
            ? error
            : new ApiTokenInternalError({ operation: "create", cause: error }),
        ),
      );
  });

  const listForActor = Effect.fn("ApiTokenService.listForActor")(function* (
    input: ListApiTokensForActorInput,
  ) {
    const actorPrincipalId = actorPrincipalIdOf(input.actor);

    if (!input.actor.isOwner) {
      if (input.principalId !== undefined && input.principalId !== actorPrincipalId) {
        return yield* new ApiTokenForbiddenError({ reason: "not_authorized" });
      }
      const [tokens, maybePrincipal] = yield* Effect.all([
        apiTokens.listForPrincipal(actorPrincipalId),
        principals.get(actorPrincipalId),
      ]).pipe(
        Effect.mapError((cause) => new ApiTokenInternalError({ operation: "listForActor", cause })),
      );
      const displayName = Option.isSome(maybePrincipal)
        ? maybePrincipal.value.displayName
        : undefined;
      return tokens.map((token): ApiTokenListItem => ({
        ...token,
        ...(displayName === undefined ? {} : { principalDisplayName: displayName }),
      }));
    }

    const [tokens, allPrincipals] = yield* Effect.all([
      input.principalId === undefined
        ? apiTokens.listAll
        : apiTokens.listForPrincipal(input.principalId),
      principals.list,
    ]).pipe(
      Effect.mapError((cause) => new ApiTokenInternalError({ operation: "listForActor", cause })),
    );
    const displayNameById = new Map(
      allPrincipals.map((principal) => [principal.id, principal.displayName] as const),
    );
    return tokens.map((token): ApiTokenListItem => {
      const displayName = displayNameById.get(token.principalId);
      return {
        ...token,
        ...(displayName === undefined ? {} : { principalDisplayName: displayName }),
      };
    });
  });

  const revoke = Effect.fn("ApiTokenService.revoke")(function* (
    input: RevokeApiTokenForActorInput,
  ) {
    const actorPrincipalId = actorPrincipalIdOf(input.actor);
    const existing = yield* apiTokens
      .getById(input.id)
      .pipe(Effect.mapError((cause) => new ApiTokenInternalError({ operation: "revoke", cause })));

    if (Option.isNone(existing)) {
      return false;
    }

    const target = existing.value;
    if (!input.actor.isOwner && target.principalId !== actorPrincipalId) {
      return yield* new ApiTokenForbiddenError({ reason: "not_authorized" });
    }

    const revokedAt = DateTime.formatIso(yield* DateTime.now);
    const revoked = yield* apiTokens
      .revoke(target.id, revokedAt)
      .pipe(Effect.mapError((cause) => new ApiTokenInternalError({ operation: "revoke", cause })));

    if (revoked) {
      yield* auditEvents
        .append({
          at: revokedAt,
          actorPrincipalId,
          actorSessionId: input.audit?.sessionId ?? null,
          action: "token.revoked",
          resourceType: "api_token",
          resourceId: target.id,
          projectId: auditProjectIdForBinding(target.binding),
          ip: input.audit?.ip ?? null,
          userAgent: input.audit?.userAgent ?? null,
          outcome: "allow",
          metadata: {
            principalId: target.principalId,
            bindingKind: target.binding._tag,
          },
        })
        .pipe(
          Effect.mapError((cause) => new ApiTokenInternalError({ operation: "revoke", cause })),
        );
    }

    return revoked;
  });

  return ApiTokenService.of({
    create,
    listForActor,
    revoke,
  });
});

export const layer = Layer.effect(ApiTokenService, make);
