// @effect-diagnostics nodeBuiltinImport:off - node:crypto provides scrypt and timingSafeEqual, which effect/crypto does not expose.
import * as NodeCrypto from "node:crypto";
import {
  type AuthSessionId,
  type Principal,
  PrincipalId,
  type ProjectMembership,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as ProjectAccess from "../access/ProjectAccess.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as RecoveryCodes from "../persistence/RecoveryCodes.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";
import * as InvitationCodes from "./InvitationCodes.ts";

export const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
  saltBytes: 32,
} as const;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;
export const INVALID_CREDENTIALS_MESSAGE = "Invalid credentials.";
export const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const LOGIN_RATE_LIMIT_WINDOW = Duration.minutes(15);
const DEFAULT_RECOVERY_CODE_TTL = Duration.minutes(15);

const MAX_RATE_LIMIT_KEYS = 10_000;
const HEX_PATTERN = /^[0-9a-f]+$/i;
// Fixed valid salt+hash pair used when verifying unknown or passwordless principals so
// response timing stays indistinguishable from a real password check.
const DUMMY_SALT_HEX = "5a".repeat(SCRYPT_PARAMS.saltBytes);
const DUMMY_HASH_HEX = "a5".repeat(SCRYPT_PARAMS.keylen);

export class PasswordCryptoError extends Schema.TaggedError<PasswordCryptoError>()(
  "PasswordCryptoError",
  {
    operation: Schema.Literals(["hash", "verify"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Password cryptographic operation failed (${this.operation}).`;
  }
}

const PasswordValidationReason = Schema.Literals(["too_short", "too_long", "principal_inactive"]);

export class PasswordValidationError extends Schema.TaggedError<PasswordValidationError>()(
  "PasswordValidationError",
  {
    reason: PasswordValidationReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "too_short":
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
      case "too_long":
        return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
      case "principal_inactive":
        return "This member account is not active.";
    }
  }
}

const PasswordForbiddenReason = Schema.Literals([
  "principal_required",
  "owner_required",
  "not_authorized",
]);

export class PasswordForbiddenError extends Schema.TaggedError<PasswordForbiddenError>()(
  "PasswordForbiddenError",
  {
    reason: PasswordForbiddenReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "principal_required":
        return "An authenticated principal is required to set a password.";
      case "owner_required":
        return "Only the owner may set another member's password.";
      case "not_authorized":
        return "You do not have permission to issue a recovery code for this member.";
    }
  }
}

export class PasswordNotFoundError extends Schema.TaggedError<PasswordNotFoundError>()(
  "PasswordNotFoundError",
  {
    principalId: PrincipalId,
  },
) {
  override get message(): string {
    return "The target member was not found.";
  }
}

export class PasswordAuthFailedError extends Schema.TaggedError<PasswordAuthFailedError>()(
  "PasswordAuthFailedError",
  {},
) {
  override get message(): string {
    return INVALID_CREDENTIALS_MESSAGE;
  }
}

export class PasswordRateLimitedError extends Schema.TaggedError<PasswordRateLimitedError>()(
  "PasswordRateLimitedError",
  {},
) {
  override get message(): string {
    return "Too many failed login attempts. Try again later.";
  }
}

const PasswordRecoveryInvalidReason = Schema.Literals([
  "malformed_code",
  "not_found",
  "revoked",
  "principal_not_found",
  "principal_inactive",
]);

export class PasswordRecoveryInvalidError extends Schema.TaggedError<PasswordRecoveryInvalidError>()(
  "PasswordRecoveryInvalidError",
  {
    reason: PasswordRecoveryInvalidReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "malformed_code":
        return "The recovery code format is invalid.";
      case "not_found":
        return "The recovery code was not found.";
      case "revoked":
        return "This recovery code has been revoked.";
      case "principal_not_found":
        return "The target member was not found.";
      case "principal_inactive":
        return "This member account is not active.";
    }
  }
}

export class PasswordRecoveryExpiredError extends Schema.TaggedError<PasswordRecoveryExpiredError>()(
  "PasswordRecoveryExpiredError",
  {},
) {
  override get message(): string {
    return "This recovery code has expired.";
  }
}

export class PasswordRecoveryAlreadyUsedError extends Schema.TaggedError<PasswordRecoveryAlreadyUsedError>()(
  "PasswordRecoveryAlreadyUsedError",
  {},
) {
  override get message(): string {
    return "This recovery code has already been used.";
  }
}

export class PasswordInternalError extends Schema.TaggedError<PasswordInternalError>()(
  "PasswordInternalError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Password operation failed (${this.operation}).`;
  }
}

export interface PasswordHashRecord {
  readonly algo: "scrypt";
  readonly salt: string;
  readonly hash: string;
}

export interface PasswordAuditContext {
  readonly sessionId?: AuthSessionId | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface SetOwnPasswordInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly password: string;
  readonly audit?: PasswordAuditContext;
}

export interface SetMemberPasswordInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly principalId: PrincipalId;
  readonly password: string;
  readonly audit?: PasswordAuditContext;
}

export type VerifyLoginInput = (
  | { readonly email: string }
  | { readonly principalId: PrincipalId }
) & {
  readonly password: string;
  readonly audit?: PasswordAuditContext;
};

export interface VerifiedPasswordLogin {
  readonly principal: Principal;
  readonly memberships: ReadonlyArray<ProjectMembership>;
}

export interface IssueRecoveryCodeInput {
  readonly actor: ProjectAccess.AccessActor;
  readonly principalId?: PrincipalId;
  readonly ttl?: Duration.Duration;
  readonly audit?: PasswordAuditContext;
}

export interface IssuedRecoveryCode {
  readonly code: string;
  readonly expiresAt: string;
  readonly principalId: PrincipalId;
}

export interface ConfirmRecoveryInput {
  readonly code: string;
  readonly password: string;
  readonly audit?: PasswordAuditContext;
}

export interface ConfirmedRecovery {
  readonly recovered: true;
  readonly principalId: PrincipalId;
  readonly revokedSessions: number;
  readonly revokedDevices: number;
  readonly revokedTokens: number;
}

type SetPasswordError =
  | PasswordValidationError
  | PasswordForbiddenError
  | PasswordNotFoundError
  | PasswordInternalError;

type VerifyLoginError = PasswordAuthFailedError | PasswordRateLimitedError | PasswordInternalError;

type IssueRecoveryCodeError =
  | PasswordValidationError
  | PasswordForbiddenError
  | PasswordNotFoundError
  | PasswordInternalError;

type ConfirmRecoveryError =
  | PasswordValidationError
  | PasswordRecoveryInvalidError
  | PasswordRecoveryExpiredError
  | PasswordRecoveryAlreadyUsedError
  | PasswordInternalError;

function deriveScryptKey(
  password: string,
  salt: Buffer,
  operation: "hash" | "verify",
): Effect.Effect<Buffer, PasswordCryptoError> {
  return Effect.callback<Buffer, PasswordCryptoError>((resume) => {
    NodeCrypto.scrypt(
      password,
      salt,
      SCRYPT_PARAMS.keylen,
      {
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
      },
      (error, derivedKey) => {
        if (error !== null) {
          resume(Effect.fail(new PasswordCryptoError({ operation, cause: error })));
        } else {
          resume(Effect.succeed(derivedKey));
        }
      },
    );
  });
}

export const hashPassword = Effect.fn("Passwords.hashPassword")(function* (password: string) {
  const salt = yield* Effect.try({
    try: () => NodeCrypto.randomBytes(SCRYPT_PARAMS.saltBytes),
    catch: (cause) => new PasswordCryptoError({ operation: "hash", cause }),
  });
  const derived = yield* deriveScryptKey(password, salt, "hash");
  return {
    algo: "scrypt",
    salt: salt.toString("hex"),
    hash: derived.toString("hex"),
  } satisfies PasswordHashRecord;
});

export const verifyPasswordHash = Effect.fn("Passwords.verifyPasswordHash")(function* (
  password: string,
  record: { readonly algo?: string; readonly salt: string; readonly hash: string },
) {
  if (record.algo !== undefined && record.algo !== "scrypt") {
    return false;
  }
  if (
    record.salt.length !== SCRYPT_PARAMS.saltBytes * 2 ||
    record.hash.length !== SCRYPT_PARAMS.keylen * 2 ||
    !HEX_PATTERN.test(record.salt) ||
    !HEX_PATTERN.test(record.hash)
  ) {
    return false;
  }
  const salt = Buffer.from(record.salt, "hex");
  const expected = Buffer.from(record.hash, "hex");
  if (salt.length !== SCRYPT_PARAMS.saltBytes || expected.length !== SCRYPT_PARAMS.keylen) {
    return false;
  }
  const derived = yield* deriveScryptKey(password, salt, "verify");
  if (derived.length !== expected.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(derived, expected);
});

const verifyDummyPassword = (password: string) =>
  verifyPasswordHash(password, {
    algo: "scrypt",
    salt: DUMMY_SALT_HEX,
    hash: DUMMY_HASH_HEX,
  }).pipe(Effect.as(false));

function validatePassword(password: string): Effect.Effect<void, PasswordValidationError> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return Effect.fail(new PasswordValidationError({ reason: "too_short" }));
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return Effect.fail(new PasswordValidationError({ reason: "too_long" }));
  }
  return Effect.void;
}

export class Passwords extends Context.Service<
  Passwords,
  {
    readonly setOwnPassword: (
      input: SetOwnPasswordInput,
    ) => Effect.Effect<{ readonly updated: true }, SetPasswordError>;
    readonly setMemberPassword: (
      input: SetMemberPasswordInput,
    ) => Effect.Effect<{ readonly updated: true }, SetPasswordError>;
    readonly verifyLogin: (
      input: VerifyLoginInput,
    ) => Effect.Effect<VerifiedPasswordLogin, VerifyLoginError>;
    readonly issueRecoveryCode: (
      input: IssueRecoveryCodeInput,
    ) => Effect.Effect<IssuedRecoveryCode, IssueRecoveryCodeError>;
    readonly confirmRecovery: (
      input: ConfirmRecoveryInput,
    ) => Effect.Effect<ConfirmedRecovery, ConfirmRecoveryError>;
  }
>()("v3code/identity/Passwords") {}

const CONFIRM_RECOVERY_ERROR_TAGS = new Set([
  "PasswordValidationError",
  "PasswordRecoveryInvalidError",
  "PasswordRecoveryExpiredError",
  "PasswordRecoveryAlreadyUsedError",
  "PasswordInternalError",
]);

function mapConfirmTransactionError(error: unknown): ConfirmRecoveryError {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as { readonly _tag: unknown })._tag === "string" &&
    CONFIRM_RECOVERY_ERROR_TAGS.has((error as { readonly _tag: string })._tag)
  ) {
    return error as ConfirmRecoveryError;
  }
  return new PasswordInternalError({ operation: "confirmRecovery", cause: error });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const principals = yield* Principals.PrincipalRepository;
  const memberships = yield* Memberships.MembershipRepository;
  const recoveryCodes = yield* RecoveryCodes.RecoveryCodeRepository;
  const sessionPrincipals = yield* SessionPrincipals.SessionPrincipalRepository;
  const apiTokens = yield* ApiTokens.ApiTokenRepository;
  const auditEvents = yield* AuditEvents.AuditEventRepository;
  const sessionStore = yield* SessionStore.SessionStore;
  const pairingGrantStore = yield* PairingGrantStore.PairingGrantStore;
  const codes = yield* InvitationCodes.make();

  // In-memory sliding-window limiter keyed by normalized login identifier + client IP.
  // Avoids SQLite write-lock contention during brute-force floods; resets on server restart.
  const loginFailuresByKey = new Map<string, Array<number>>();
  const windowMs = Duration.toMillis(LOGIN_RATE_LIMIT_WINDOW);

  const pruneWindow = (key: string, nowMs: number): Array<number> => {
    const cutoff = nowMs - windowMs;
    const existing = loginFailuresByKey.get(key);
    if (existing === undefined) {
      return [];
    }
    const fresh = existing.filter((timestamp) => timestamp > cutoff);
    if (fresh.length === 0) {
      loginFailuresByKey.delete(key);
    } else if (fresh.length !== existing.length) {
      loginFailuresByKey.set(key, fresh);
    }
    return fresh;
  };

  const recordLoginFailure = (key: string, nowMs: number): void => {
    const fresh = pruneWindow(key, nowMs);
    if (!loginFailuresByKey.has(key) && loginFailuresByKey.size >= MAX_RATE_LIMIT_KEYS) {
      const cutoff = nowMs - windowMs;
      for (const [entryKey, timestamps] of loginFailuresByKey) {
        if (!timestamps.some((timestamp) => timestamp > cutoff)) {
          loginFailuresByKey.delete(entryKey);
        }
      }
      if (loginFailuresByKey.size >= MAX_RATE_LIMIT_KEYS) {
        const oldestKey = loginFailuresByKey.keys().next().value;
        if (oldestKey !== undefined) {
          loginFailuresByKey.delete(oldestKey);
        }
      }
    }
    fresh.push(nowMs);
    loginFailuresByKey.set(key, fresh);
  };

  const resolveActorPrincipalId = Effect.fnUntraced(function* (
    actor: ProjectAccess.AccessActor,
    operation: string,
  ): Effect.fn.Return<PrincipalId, PasswordForbiddenError | PasswordInternalError> {
    if (actor.principalId !== undefined) {
      return actor.principalId;
    }
    if (actor.isOwner) {
      const owner = yield* principals.getOwner.pipe(
        Effect.mapError((cause) => new PasswordInternalError({ operation, cause })),
      );
      if (Option.isSome(owner)) {
        return owner.value.id;
      }
    }
    return yield* new PasswordForbiddenError({ reason: "principal_required" });
  });

  const storePasswordForPrincipal = Effect.fnUntraced(function* (
    principalId: PrincipalId,
    password: string,
    operation: string,
  ): Effect.fn.Return<
    { readonly updated: true },
    PasswordValidationError | PasswordNotFoundError | PasswordInternalError
  > {
    yield* validatePassword(password);
    const maybePrincipal = yield* principals
      .get(principalId)
      .pipe(Effect.mapError((cause) => new PasswordInternalError({ operation, cause })));
    if (Option.isNone(maybePrincipal) || maybePrincipal.value.status === "removed") {
      return yield* new PasswordNotFoundError({ principalId });
    }
    if (maybePrincipal.value.status !== "active") {
      return yield* new PasswordValidationError({ reason: "principal_inactive" });
    }

    const hashed = yield* hashPassword(password).pipe(
      Effect.mapError((cause) => new PasswordInternalError({ operation, cause })),
    );
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    yield* principals
      .setCredential({
        principalId,
        salt: hashed.salt,
        hash: hashed.hash,
        updatedAt: nowIso,
      })
      .pipe(Effect.mapError((cause) => new PasswordInternalError({ operation, cause })));

    return { updated: true } as const;
  });

  const setOwnPassword = Effect.fn("Passwords.setOwnPassword")(function* (
    input: SetOwnPasswordInput,
  ) {
    const principalId = yield* resolveActorPrincipalId(input.actor, "setOwnPassword");
    return yield* storePasswordForPrincipal(principalId, input.password, "setOwnPassword");
  });

  const setMemberPassword = Effect.fn("Passwords.setMemberPassword")(function* (
    input: SetMemberPasswordInput,
  ) {
    if (!input.actor.isOwner) {
      return yield* new PasswordForbiddenError({ reason: "owner_required" });
    }
    return yield* storePasswordForPrincipal(input.principalId, input.password, "setMemberPassword");
  });

  const verifyLogin = Effect.fn("Passwords.verifyLogin")(function* (input: VerifyLoginInput) {
    const ip = input.audit?.ip ?? null;
    const userAgent = input.audit?.userAgent ?? null;
    const normalizedIdentifier =
      "email" in input
        ? `email:${input.email.trim().toLowerCase()}`
        : `principal:${input.principalId.trim()}`;
    const rateLimitKey = `${normalizedIdentifier}\0${ip ?? "unknown"}`;

    const nowMs = yield* Clock.currentTimeMillis;
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));

    if (pruneWindow(rateLimitKey, nowMs).length >= LOGIN_RATE_LIMIT_MAX_FAILURES) {
      yield* auditEvents
        .append({
          at: nowIso,
          actorPrincipalId: null,
          actorSessionId: null,
          action: "login.failed",
          resourceType: "principal",
          resourceId: null,
          projectId: null,
          ip,
          userAgent,
          outcome: "deny",
          metadata: { method: "password", reason: "rate_limited" },
        })
        .pipe(
          Effect.mapError(
            (cause) => new PasswordInternalError({ operation: "verifyLogin", cause }),
          ),
        );
      return yield* new PasswordRateLimitedError();
    }

    const maybePrincipal = yield* (
      "email" in input
        ? principals.getByEmail(input.email.trim())
        : principals.get(input.principalId)
    ).pipe(
      Effect.mapError((cause) => new PasswordInternalError({ operation: "verifyLogin", cause })),
    );

    const activePrincipal =
      Option.isSome(maybePrincipal) && maybePrincipal.value.status === "active"
        ? maybePrincipal.value
        : undefined;

    const maybeCredential =
      activePrincipal === undefined
        ? Option.none()
        : yield* principals
            .getCredential(activePrincipal.id)
            .pipe(
              Effect.mapError(
                (cause) => new PasswordInternalError({ operation: "verifyLogin", cause }),
              ),
            );

    const verified =
      activePrincipal !== undefined && Option.isSome(maybeCredential)
        ? yield* verifyPasswordHash(input.password, maybeCredential.value).pipe(
            Effect.mapError(
              (cause) => new PasswordInternalError({ operation: "verifyLogin", cause }),
            ),
          )
        : yield* verifyDummyPassword(input.password).pipe(
            Effect.mapError(
              (cause) => new PasswordInternalError({ operation: "verifyLogin", cause }),
            ),
          );

    if (!verified || activePrincipal === undefined) {
      recordLoginFailure(rateLimitKey, nowMs);
      yield* auditEvents
        .append({
          at: nowIso,
          actorPrincipalId: activePrincipal?.id ?? null,
          actorSessionId: null,
          action: "login.failed",
          resourceType: "principal",
          resourceId: activePrincipal?.id ?? null,
          projectId: null,
          ip,
          userAgent,
          outcome: "deny",
          metadata: { method: "password" },
        })
        .pipe(
          Effect.mapError(
            (cause) => new PasswordInternalError({ operation: "verifyLogin", cause }),
          ),
        );
      return yield* new PasswordAuthFailedError();
    }

    loginFailuresByKey.delete(rateLimitKey);

    const principalMemberships = yield* memberships
      .listForPrincipal(activePrincipal.id)
      .pipe(
        Effect.mapError((cause) => new PasswordInternalError({ operation: "verifyLogin", cause })),
      );

    yield* auditEvents
      .append({
        at: nowIso,
        actorPrincipalId: activePrincipal.id,
        actorSessionId: null,
        action: "login.succeeded",
        resourceType: "principal",
        resourceId: activePrincipal.id,
        projectId: null,
        ip,
        userAgent,
        outcome: "allow",
        metadata: { method: "password" },
      })
      .pipe(
        Effect.mapError((cause) => new PasswordInternalError({ operation: "verifyLogin", cause })),
      );

    return {
      principal: activePrincipal,
      memberships: principalMemberships,
    } satisfies VerifiedPasswordLogin;
  });

  const issueRecoveryCode = Effect.fn("Passwords.issueRecoveryCode")(function* (
    input: IssueRecoveryCodeInput,
  ) {
    const actorPrincipalId = yield* resolveActorPrincipalId(input.actor, "issueRecoveryCode");
    const targetPrincipalId = input.principalId ?? actorPrincipalId;
    if (!input.actor.isOwner && actorPrincipalId !== targetPrincipalId) {
      return yield* new PasswordForbiddenError({ reason: "not_authorized" });
    }

    const maybePrincipal = yield* principals
      .get(targetPrincipalId)
      .pipe(
        Effect.mapError(
          (cause) => new PasswordInternalError({ operation: "issueRecoveryCode", cause }),
        ),
      );
    if (Option.isNone(maybePrincipal) || maybePrincipal.value.status === "removed") {
      return yield* new PasswordNotFoundError({ principalId: targetPrincipalId });
    }
    if (maybePrincipal.value.status !== "active") {
      return yield* new PasswordValidationError({ reason: "principal_inactive" });
    }

    const id = yield* random
      .uuidV4()
      .pipe(
        Effect.mapError(
          (cause) => new PasswordInternalError({ operation: "issueRecoveryCode", cause }),
        ),
      );
    const { code, tokenHash } = yield* codes
      .generate()
      .pipe(
        Effect.mapError(
          (cause) => new PasswordInternalError({ operation: "issueRecoveryCode", cause }),
        ),
      );

    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);
    const expiresAt = DateTime.formatIso(
      DateTime.addDuration(now, input.ttl ?? DEFAULT_RECOVERY_CODE_TTL),
    );

    yield* recoveryCodes
      .create({
        id,
        tokenHash,
        principalId: targetPrincipalId,
        createdBy: actorPrincipalId,
        createdAt,
        expiresAt,
      })
      .pipe(
        Effect.mapError(
          (cause) => new PasswordInternalError({ operation: "issueRecoveryCode", cause }),
        ),
      );

    return {
      code,
      expiresAt,
      principalId: targetPrincipalId,
    } satisfies IssuedRecoveryCode;
  });

  const confirmRecovery = Effect.fn("Passwords.confirmRecovery")(function* (
    input: ConfirmRecoveryInput,
  ) {
    yield* validatePassword(input.password);
    const canonical = InvitationCodes.normalizeInvitationCode(input.code);
    if (canonical === undefined) {
      return yield* new PasswordRecoveryInvalidError({ reason: "malformed_code" });
    }

    const tokenHash = yield* codes
      .hash(canonical)
      .pipe(
        Effect.mapError(
          (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
        ),
      );
    // Hash before opening the SQLite write transaction so scrypt CPU time never holds the DB lock.
    const hashed = yield* hashPassword(input.password).pipe(
      Effect.mapError(
        (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
      ),
    );

    const nowIso = DateTime.formatIso(yield* DateTime.now);

    const txResult = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const consumed = yield* recoveryCodes
            .consume({ tokenHash, now: nowIso })
            .pipe(
              Effect.mapError(
                (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
              ),
            );

          if (Option.isNone(consumed)) {
            const existing = yield* recoveryCodes
              .getByTokenHash(tokenHash)
              .pipe(
                Effect.mapError(
                  (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
                ),
              );
            if (Option.isNone(existing)) {
              return yield* new PasswordRecoveryInvalidError({ reason: "not_found" });
            }
            if (existing.value.consumedAt !== null) {
              return yield* new PasswordRecoveryAlreadyUsedError();
            }
            if (existing.value.revokedAt !== null) {
              return yield* new PasswordRecoveryInvalidError({ reason: "revoked" });
            }
            return yield* new PasswordRecoveryExpiredError();
          }

          const record = consumed.value;
          const maybePrincipal = yield* principals
            .get(record.principalId)
            .pipe(
              Effect.mapError(
                (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
              ),
            );
          if (Option.isNone(maybePrincipal)) {
            return yield* new PasswordRecoveryInvalidError({ reason: "principal_not_found" });
          }
          const principal = maybePrincipal.value;
          if (principal.status !== "active") {
            return yield* new PasswordRecoveryInvalidError({ reason: "principal_inactive" });
          }

          yield* principals
            .setCredential({
              principalId: principal.id,
              salt: hashed.salt,
              hash: hashed.hash,
              updatedAt: nowIso,
            })
            .pipe(
              Effect.mapError(
                (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
              ),
            );
          yield* principals
            .bumpAccessRevision(principal.id, nowIso)
            .pipe(
              Effect.mapError(
                (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
              ),
            );
          const revokedTokens = yield* apiTokens
            .revokeAllForPrincipal(principal.id, nowIso)
            .pipe(
              Effect.mapError(
                (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
              ),
            );
          yield* recoveryCodes
            .revokePendingForPrincipal(principal.id, nowIso)
            .pipe(
              Effect.mapError(
                (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
              ),
            );

          return {
            principal,
            revokedTokens,
            recoveryCodeId: record.id,
          };
        }),
      )
      .pipe(Effect.mapError(mapConfirmTransactionError));

    // Session revocation runs outside the SQL write transaction because listForPrincipal uses
    // readOnly and SessionStore.revoke publishes live WebSocket invalidations.
    const sessionIds = yield* sessionPrincipals
      .listForPrincipal(txResult.principal.id)
      .pipe(
        Effect.mapError(
          (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
        ),
      );

    const thumbprints = new Set<string>();
    let revokedSessions = 0;
    for (const sessionId of sessionIds) {
      const thumbprint = yield* sessionStore
        .proofKeyThumbprintOf(sessionId)
        .pipe(
          Effect.mapError(
            (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
          ),
        );
      if (Option.isSome(thumbprint)) {
        thumbprints.add(thumbprint.value);
      }
      const revoked = yield* sessionStore
        .revoke(sessionId)
        .pipe(
          Effect.mapError(
            (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
          ),
        );
      if (revoked) {
        revokedSessions += 1;
      }
    }
    yield* sessionPrincipals
      .removeAllForPrincipal(txResult.principal.id)
      .pipe(
        Effect.mapError(
          (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
        ),
      );

    let revokedDevices = 0;
    if (txResult.principal.kind === "owner") {
      revokedDevices = yield* pairingGrantStore
        .revokeConnectDevicesExcept(null)
        .pipe(
          Effect.mapError(
            (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
          ),
        );
    } else {
      for (const thumbprint of thumbprints) {
        const removed = yield* pairingGrantStore
          .revokeConnectDevice(thumbprint)
          .pipe(
            Effect.mapError(
              (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
            ),
          );
        if (removed) {
          revokedDevices += 1;
        }
      }
    }

    yield* auditEvents
      .append({
        at: nowIso,
        actorPrincipalId: txResult.principal.id,
        actorSessionId: input.audit?.sessionId ?? null,
        action: "member.recovered",
        resourceType: "principal",
        resourceId: txResult.principal.id,
        projectId: null,
        ip: input.audit?.ip ?? null,
        userAgent: input.audit?.userAgent ?? null,
        outcome: "allow",
        metadata: {
          principalId: txResult.principal.id,
          recoveryCodeId: txResult.recoveryCodeId,
          revokedSessions,
          revokedDevices,
          revokedTokens: txResult.revokedTokens,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) => new PasswordInternalError({ operation: "confirmRecovery", cause }),
        ),
      );

    return {
      recovered: true,
      principalId: txResult.principal.id,
      revokedSessions,
      revokedDevices,
      revokedTokens: txResult.revokedTokens,
    } satisfies ConfirmedRecovery;
  });

  return Passwords.of({
    setOwnPassword,
    setMemberPassword,
    verifyLogin,
    issueRecoveryCode,
    confirmRecovery,
  });
});

export const layer = Layer.effect(Passwords, make);
