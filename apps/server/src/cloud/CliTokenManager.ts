// V3 Code removes Clerk OAuth and cloud CLI token management.
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Terminal from "effect/Terminal";

export type LoopbackAuthorizationResult =
  | { readonly _tag: "AuthorizationCode"; readonly code: string }
  | { readonly _tag: "HeadlessRequested" };

const PersistedToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  identity: Schema.optional(Schema.String),
});
export type PersistedToken = typeof PersistedToken.Type;

const OAuthRefreshErrorCode = Schema.Literals([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_request",
  "invalid_scope",
  "access_denied",
]);

const isPermanentRefreshStatus = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

export class CloudCliCredentialRemovalError extends Schema.TaggedError<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Cloud CLI credentials are disabled in V3 Code.";
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedError<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  {
    cause: Schema.Defect(),
    status: Schema.optional(Schema.Number),
    oauthErrorCode: Schema.optional(OAuthRefreshErrorCode),
  },
) {
  get requiresLogin(): boolean {
    return this.status !== undefined && isPermanentRefreshStatus(this.status);
  }

  override get message(): string {
    return "Cloud CLI credentials are disabled in V3 Code.";
  }
}

export const isCloudCliCredentialRefreshError = Schema.is(CloudCliCredentialRefreshError);

export class CloudCliCredentialReadError extends Schema.TaggedError<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Cloud CLI credentials are disabled in V3 Code.";
  }
}

export class CloudCliAuthorizationError extends Schema.TaggedError<CloudCliAuthorizationError>()(
  "CloudCliAuthorizationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Cloud relay authentication is permanently disabled in V3 Code.";
  }
}

export class CloudCliAuthorizationTimeoutError extends Schema.TaggedError<CloudCliAuthorizationTimeoutError>()(
  "CloudCliAuthorizationTimeoutError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Cloud relay authentication is permanently disabled in V3 Code.";
  }
}

export class CloudCliAuthorizationDeniedError extends Schema.TaggedError<CloudCliAuthorizationDeniedError>()(
  "CloudCliAuthorizationDeniedError",
  {},
) {
  override get message(): string {
    return "Cloud relay authentication is permanently disabled in V3 Code.";
  }
}

export const CloudCliTokenManagerError = Schema.Union([
  CloudCliCredentialRemovalError,
  CloudCliCredentialRefreshError,
  CloudCliCredentialReadError,
  CloudCliAuthorizationError,
  CloudCliAuthorizationTimeoutError,
  CloudCliAuthorizationDeniedError,
]);
export type CloudCliTokenManagerError = typeof CloudCliTokenManagerError.Type;

export class CloudCliTokenManager extends Context.Service<
  CloudCliTokenManager,
  {
    readonly get: Effect.Effect<
      | { readonly _tag: "Authorized"; readonly token: PersistedToken }
      | { readonly _tag: "HeadlessRequested" },
      CloudCliTokenManagerError | Terminal.QuitError
    >;
    readonly getExisting: Effect.Effect<Option.Option<PersistedToken>, CloudCliTokenManagerError>;
    readonly hasCredential: Effect.Effect<boolean, CloudCliTokenManagerError>;
    readonly store: (token: PersistedToken) => Effect.Effect<void, CloudCliTokenManagerError>;
    readonly clear: Effect.Effect<void, CloudCliTokenManagerError>;
  }
>()("v3code/cloud/CliTokenManager/CloudCliTokenManager") {}

export interface DeviceAuthorizationPrompt {
  readonly verificationUri: string;
  readonly verificationUriComplete: string | undefined;
  readonly userCode: string;
  readonly expiresIn: Duration.Duration;
}

export const deviceAuthorizationLogin = Effect.fn("cloud.cli_token.device_authorization_login")(
  function* <E, R>(
    _showPrompt: (prompt: DeviceAuthorizationPrompt) => Effect.Effect<void, E, R>,
  ): Effect.fn.Return<
    { readonly token: PersistedToken; readonly identity: string | null },
    CloudCliTokenManagerError
  > {
    return yield* new CloudCliAuthorizationError({
      cause: "Cloud relay authentication is permanently disabled in V3 Code.",
    });
  },
);

/** @public */
export const make = Effect.succeed(
  CloudCliTokenManager.of({
    get: Effect.fail(
      new CloudCliAuthorizationError({
        cause: "Cloud relay authentication is permanently disabled in V3 Code.",
      }),
    ),
    getExisting: Effect.succeedNone,
    hasCredential: Effect.succeed(false),
    store: Effect.fn("CloudCliTokenManager.store")(function* (_token) {}),
    clear: Effect.void,
  }),
);

export const layer = Layer.effect(CloudCliTokenManager, make);
