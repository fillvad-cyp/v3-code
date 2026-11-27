import {
  DEFAULT_MEMBER_INVITES_PER_HOUR,
  DEFAULT_MEMBER_MAX_API_TOKENS,
  DEFAULT_MEMBER_MAX_PREVIEW_TABS,
  DEFAULT_MEMBER_MAX_SESSIONS,
  DEFAULT_MEMBER_MAX_TERMINALS,
  NonNegativeInt,
  PositiveInt,
  PrincipalId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Principals from "../persistence/Principals.ts";

export const DEFAULT_LIMIT_RETRY_AFTER_SECONDS = 60;

export interface ResolvedMemberLimits {
  readonly maxSessions: number;
  readonly maxTerminals: number;
  readonly maxPreviewTabs: number;
  readonly invitesPerHour: number;
  readonly maxApiTokens: number;
}

export class ApiTokenLimitExceededError extends Schema.TaggedError<ApiTokenLimitExceededError>()(
  "ApiTokenLimitExceededError",
  {
    status: Schema.Literal(429),
    principalId: PrincipalId,
    limit: NonNegativeInt,
    activeCount: NonNegativeInt,
    retryAfterSeconds: PositiveInt,
  },
) {
  override get message(): string {
    return `Personal access token limit (${this.limit}) reached for principal ${this.principalId} (${this.activeCount} active). Revoke an unused token and retry after ${this.retryAfterSeconds}s.`;
  }
}

export class PrincipalLimitsInternalError extends Schema.TaggedError<PrincipalLimitsInternalError>()(
  "PrincipalLimitsInternalError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Principal limits operation failed (${this.operation}).`;
  }
}

export class PrincipalLimitsService extends Context.Service<
  PrincipalLimitsService,
  {
    /** Returns null when the principal is an owner (exempt from member limits). */
    readonly resolveForPrincipal: (
      principalId: PrincipalId,
    ) => Effect.Effect<ResolvedMemberLimits | null, PrincipalLimitsInternalError>;
    readonly assertApiTokenLimit: (
      principalId: PrincipalId,
    ) => Effect.Effect<void, ApiTokenLimitExceededError | PrincipalLimitsInternalError>;
  }
>()("v3code/identity/PrincipalLimitsService") {}

const make = Effect.gen(function* () {
  const principals = yield* Principals.PrincipalRepository;
  const memberLimits = yield* MemberLimits.MemberLimitsRepository;
  const apiTokens = yield* ApiTokens.ApiTokenRepository;

  const resolveForPrincipal: PrincipalLimitsService["Service"]["resolveForPrincipal"] = Effect.fn(
    "PrincipalLimitsService.resolveForPrincipal",
  )(function* (principalId) {
    const maybePrincipal = yield* principals
      .get(principalId)
      .pipe(
        Effect.mapError(
          (cause) => new PrincipalLimitsInternalError({ operation: "getPrincipal", cause }),
        ),
      );
    if (Option.isSome(maybePrincipal) && maybePrincipal.value.kind === "owner") {
      return null;
    }
    const row = yield* memberLimits
      .get(principalId)
      .pipe(
        Effect.mapError(
          (cause) => new PrincipalLimitsInternalError({ operation: "getMemberLimits", cause }),
        ),
      );
    return {
      maxSessions: row?.maxSessions ?? DEFAULT_MEMBER_MAX_SESSIONS,
      maxTerminals: row?.maxTerminals ?? DEFAULT_MEMBER_MAX_TERMINALS,
      maxPreviewTabs: row?.maxPreviewTabs ?? DEFAULT_MEMBER_MAX_PREVIEW_TABS,
      invitesPerHour: row?.invitesPerHour ?? DEFAULT_MEMBER_INVITES_PER_HOUR,
      maxApiTokens: row?.maxApiTokens ?? DEFAULT_MEMBER_MAX_API_TOKENS,
    };
  });

  const assertApiTokenLimit: PrincipalLimitsService["Service"]["assertApiTokenLimit"] = Effect.fn(
    "PrincipalLimitsService.assertApiTokenLimit",
  )(function* (principalId) {
    const resolved = yield* resolveForPrincipal(principalId);
    if (resolved === null) {
      return;
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const activeCount = yield* apiTokens
      .countActiveForPrincipal(principalId, nowMs)
      .pipe(
        Effect.mapError(
          (cause) => new PrincipalLimitsInternalError({ operation: "countActiveApiTokens", cause }),
        ),
      );
    if (activeCount >= resolved.maxApiTokens) {
      return yield* new ApiTokenLimitExceededError({
        status: 429,
        principalId,
        limit: resolved.maxApiTokens,
        activeCount,
        retryAfterSeconds: DEFAULT_LIMIT_RETRY_AFTER_SECONDS,
      });
    }
  });

  return PrincipalLimitsService.of({
    resolveForPrincipal,
    assertApiTokenLimit,
  });
});

export const layer = Layer.effect(PrincipalLimitsService, make).pipe(
  Layer.provideMerge(Principals.layer),
  Layer.provideMerge(MemberLimits.layer),
  Layer.provideMerge(ApiTokens.layer),
);
