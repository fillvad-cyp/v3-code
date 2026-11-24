// V3 Code permanently disables cloud relay linking and managed tunnels.
import type {
  EnvironmentCloudLinkStateResult,
  EnvironmentCloudPreferencesRequest,
  EnvironmentCloudRelayConfigResult,
} from "@t3tools/contracts";
import type {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentLinkProof,
  RelayEnvironmentMintResponse,
  RelayLinkProofRequest,
  RelayManagedEndpointRuntimeConfig,
  RelayOkResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type * as HttpClientError from "effect/http/HttpClientError";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type * as ManagedLimits from "../policy/managedLimits.ts";
import type { CliDesiredLinkMode } from "./CliState.ts";
import type * as CliTokenManager from "./CliTokenManager.ts";
import type * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import type { RelayRequestError } from "./relayResponse.ts";

const CLOUD_MINT_NONCE_PREFIX = "cloud-mint-nonce-";
const CLOUD_MINT_JTI_PREFIX = "cloud-mint-jti-";
const CLOUD_HEALTH_NONCE_PREFIX = "cloud-health-nonce-";
const CLOUD_HEALTH_JTI_PREFIX = "cloud-health-jti-";
export const CLOUD_REPLAY_MARKER_PREFIXES = [
  CLOUD_MINT_NONCE_PREFIX,
  CLOUD_MINT_JTI_PREFIX,
  CLOUD_HEALTH_NONCE_PREFIX,
  CLOUD_HEALTH_JTI_PREFIX,
] as const;

const RELAY_CONFIG_FIELD_MESSAGES = {
  relayUrl: "Cloud relay is permanently disabled in V3 Code.",
  relayIssuer: "Cloud relay is permanently disabled in V3 Code.",
  environmentCredential: "Cloud relay is permanently disabled in V3 Code.",
  cloudUserId: "Cloud relay is permanently disabled in V3 Code.",
  cloudMintPublicKey: "Cloud relay is permanently disabled in V3 Code.",
} as const;

export class CloudLinkRelayConfigInvalidError extends Schema.TaggedError<CloudLinkRelayConfigInvalidError>()(
  "CloudLinkRelayConfigInvalidError",
  {
    field: Schema.Literals([
      "relayUrl",
      "relayIssuer",
      "environmentCredential",
      "cloudUserId",
      "cloudMintPublicKey",
    ]),
  },
) {
  override get message(): string {
    return RELAY_CONFIG_FIELD_MESSAGES[this.field];
  }
}

export class CloudLinkOriginInvalidError extends Schema.TaggedError<CloudLinkOriginInvalidError>()(
  "CloudLinkOriginInvalidError",
  { origin: Schema.Literals(["endpoint", "local"]) },
) {
  override get message(): string {
    return this.origin === "endpoint"
      ? "Invalid managed endpoint origin."
      : "Could not resolve local environment origin.";
  }
}

export class CloudLinkNotLinkedError extends Schema.TaggedError<CloudLinkNotLinkedError>()(
  "CloudLinkNotLinkedError",
  {},
) {
  override get message(): string {
    return "Cloud relay is permanently disabled in V3 Code.";
  }
}

export class CloudLinkAccountMismatchError extends Schema.TaggedError<CloudLinkAccountMismatchError>()(
  "CloudLinkAccountMismatchError",
  {},
) {
  override get message(): string {
    return "Cloud relay is permanently disabled in V3 Code.";
  }
}

export class CloudLinkAuthorizationMissingError extends Schema.TaggedError<CloudLinkAuthorizationMissingError>()(
  "CloudLinkAuthorizationMissingError",
  {},
) {
  override get message(): string {
    return "Cloud relay is permanently disabled in V3 Code.";
  }
}

const SignedRelayRequest = Schema.Literals(["health", "mint"]);

export class CloudLinkProofRejectedError extends Schema.TaggedError<CloudLinkProofRejectedError>()(
  "CloudLinkProofRejectedError",
  { request: SignedRelayRequest },
) {
  override get message(): string {
    return `Invalid cloud ${this.request} request.`;
  }
}

export class CloudLinkProofReplayedError extends Schema.TaggedError<CloudLinkProofReplayedError>()(
  "CloudLinkProofReplayedError",
  { request: SignedRelayRequest },
) {
  override get message(): string {
    return `Cloud ${this.request} request was already consumed.`;
  }
}

export class CloudLinkTunnelSupersededError extends Schema.TaggedError<CloudLinkTunnelSupersededError>()(
  "CloudLinkTunnelSupersededError",
  {},
) {
  override get message(): string {
    return "Cloud relay is permanently disabled in V3 Code.";
  }
}

export class CloudLinkEndpointUnavailableError extends Schema.TaggedError<CloudLinkEndpointUnavailableError>()(
  "CloudLinkEndpointUnavailableError",
  {
    reason: Schema.Literals(["runtime-not-started", "origin-unconfirmed"]),
    endpointRuntimeStatus: Schema.Unknown,
  },
) {
  override get message(): string {
    return "Cloud relay is permanently disabled in V3 Code.";
  }
}

const INTERNAL_OPERATION_MESSAGES = {
  "relay-url-unconfigured": "Cloud relay is permanently disabled in V3 Code.",
  "generate-link-proof": "Cloud relay is permanently disabled in V3 Code.",
  "persist-relay-config": "Cloud relay is permanently disabled in V3 Code.",
  "register-endpoint-origin": "Cloud relay is permanently disabled in V3 Code.",
  "resolve-server-origin": "Cloud relay is permanently disabled in V3 Code.",
  "persist-desired-link": "Cloud relay is permanently disabled in V3 Code.",
  "sign-recovery-proof": "Cloud relay is permanently disabled in V3 Code.",
  "unsupported-recovered-tunnel": "Cloud relay is permanently disabled in V3 Code.",
  "persist-recovered-tunnel": "Cloud relay is permanently disabled in V3 Code.",
  "read-relay-config": "Cloud relay is permanently disabled in V3 Code.",
  "remove-relay-config": "Cloud relay is permanently disabled in V3 Code.",
  "update-live-activity-preference": "Cloud relay is permanently disabled in V3 Code.",
  "update-webhook-settings": "Cloud relay is permanently disabled in V3 Code.",
  "read-preferences": "Cloud relay is permanently disabled in V3 Code.",
  "persist-preferences": "Cloud relay is permanently disabled in V3 Code.",
  "answer-health": "Cloud relay is permanently disabled in V3 Code.",
  "issue-credential": "Cloud relay is permanently disabled in V3 Code.",
} as const;

export class CloudLinkInternalError extends Schema.TaggedError<CloudLinkInternalError>()(
  "CloudLinkInternalError",
  {
    operation: Schema.Literals(
      Object.keys(INTERNAL_OPERATION_MESSAGES) as [
        keyof typeof INTERNAL_OPERATION_MESSAGES,
        ...Array<keyof typeof INTERNAL_OPERATION_MESSAGES>,
      ],
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return INTERNAL_OPERATION_MESSAGES[this.operation];
  }
}

export const shouldRetryCloudLink = (_error: unknown): boolean => false;

export function consumeCloudReplayGuards(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly names: ReadonlyArray<string>;
  readonly value: Uint8Array;
}) {
  return Effect.forEach(
    input.names,
    (name) =>
      input.secrets.create(name, input.value).pipe(
        Effect.as(true),
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          ServerSecretStore.isSecretAlreadyExistsError(error)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      ),
    { concurrency: input.names.length },
  ).pipe(Effect.map((created) => created.every(Boolean)));
}

export type CloudLinkError =
  | CloudLinkAccountMismatchError
  | CloudLinkAuthorizationMissingError
  | CloudLinkEndpointUnavailableError
  | CloudLinkInternalError
  | CloudLinkNotLinkedError
  | CloudLinkOriginInvalidError
  | CloudLinkProofRejectedError
  | CloudLinkProofReplayedError
  | CloudLinkRelayConfigInvalidError
  | CloudLinkTunnelSupersededError;

type CloudLinkBackgroundError =
  | CloudLinkEndpointUnavailableError
  | CloudLinkInternalError
  | CloudLinkOriginInvalidError
  | RelayRequestError
  | ServerSecretStore.SecretStoreError
  | Schema.SchemaError
  | PlatformError.PlatformError;

type ManagedTunnelRegistration =
  | { readonly status: "not_linked" | "superseded" | "revoked" }
  | { readonly status: "recovery_required"; readonly config: RelayManagedEndpointRuntimeConfig }
  | {
      readonly status: "ready";
      readonly endpointRuntimeStatus: ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus;
    };

export class CloudLink extends Context.Service<
  CloudLink,
  {
    readonly linkProof: (
      request: RelayLinkProofRequest,
    ) => Effect.Effect<
      RelayEnvironmentLinkProof,
      | CloudLinkOriginInvalidError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
      | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly applyRelayConfig: (
      payload: RelayEnvironmentConfigRequest,
    ) => Effect.Effect<
      EnvironmentCloudRelayConfigResult,
      | CloudLinkAccountMismatchError
      | CloudLinkEndpointUnavailableError
      | CloudLinkInternalError
      | CloudLinkOriginInvalidError
      | CloudLinkRelayConfigInvalidError
      | CloudLinkTunnelSupersededError
      | EnvironmentAuth.ServerAuthInternalError
      | ManagedLimits.ManagedPolicyRefusedError
      | RelayRequestError
    >;
    readonly linkState: () => Effect.Effect<
      EnvironmentCloudLinkStateResult,
      CloudLinkInternalError
    >;
    readonly unlink: () => Effect.Effect<EnvironmentCloudRelayConfigResult, CloudLinkInternalError>;
    readonly updatePreferences: (
      input: EnvironmentCloudPreferencesRequest,
    ) => Effect.Effect<
      EnvironmentCloudLinkStateResult,
      CloudLinkNotLinkedError | CloudLinkInternalError | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly updateLiveActivityPreference: (
      enabled: boolean,
    ) => Effect.Effect<
      RelayOkResponse,
      CloudLinkInternalError | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly answerHealthRequest: (
      request: RelayCloudEnvironmentHealthRequest,
    ) => Effect.Effect<
      RelayEnvironmentHealthResponse,
      | CloudLinkProofRejectedError
      | CloudLinkProofReplayedError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
      | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly mintCredential: (
      request: RelayCloudMintCredentialRequest,
    ) => Effect.Effect<
      RelayEnvironmentMintResponse,
      | CloudLinkProofRejectedError
      | CloudLinkProofReplayedError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
      | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly reconcileDesiredLinkIfStillDesired: (
      localOrigin: string,
    ) => Effect.Effect<
      CliDesiredLinkMode | null,
      | CloudLinkBackgroundError
      | CloudLinkAccountMismatchError
      | CloudLinkAuthorizationMissingError
      | CloudLinkRelayConfigInvalidError
      | EnvironmentAuth.ServerAuthInternalError
      | CliTokenManager.CloudCliTokenManagerError
    >;
    readonly registerManagedTunnelRecovery: (
      localOrigin: string,
      options?: { readonly retryRuntimeFailures?: boolean },
    ) => Effect.Effect<ManagedTunnelRegistration, CloudLinkBackgroundError>;
    readonly recoverManagedTunnel: (
      localOrigin: string,
      expectedConfig?: RelayManagedEndpointRuntimeConfig,
      options?: { readonly retryRuntimeFailures?: boolean },
    ) => Effect.Effect<boolean, CloudLinkBackgroundError>;
    readonly startManagedTunnelIfOriginConfirmed: (
      localOrigin: string,
      options?: { readonly requireConfirmedOrigin?: boolean },
    ) => Effect.Effect<
      boolean,
      | CloudLinkEndpointUnavailableError
      | CloudLinkOriginInvalidError
      | ServerSecretStore.SecretStoreError
    >;
    readonly releaseManagedTunnelOnShutdown: () => Effect.Effect<
      boolean,
      | CloudLinkBackgroundError
      | CliTokenManager.CloudCliTokenManagerError
      | HttpClientError.HttpClientError
    >;
  }
>()("v3code/cloud/CloudLink") {}

const disabledLinkState: EnvironmentCloudLinkStateResult = {
  linked: false,
  cloudUserId: null,
  relayUrl: null,
  relayIssuer: null,
  publishAgentActivity: false,
  holdWebhooksWhileOffline: false,
  managedTunnelActive: false,
  linkRevoked: false,
};

export const layer = Layer.succeed(
  CloudLink,
  CloudLink.of({
    linkProof: Effect.fn("CloudLink.linkProof")(function* () {
      return yield* new CloudLinkInternalError({ operation: "generate-link-proof" });
    }),
    applyRelayConfig: Effect.fn("CloudLink.applyRelayConfig")(function* () {
      return yield* new CloudLinkInternalError({ operation: "persist-relay-config" });
    }),
    linkState: Effect.fn("CloudLink.linkState")(function* () {
      return disabledLinkState;
    }),
    unlink: Effect.fn("CloudLink.unlink")(function* () {
      return { ok: true, endpointRuntimeStatus: { status: "disabled" } };
    }),
    updatePreferences: Effect.fn("CloudLink.updatePreferences")(function* () {
      return yield* new CloudLinkNotLinkedError({});
    }),
    updateLiveActivityPreference: Effect.fn("CloudLink.updateLiveActivityPreference")(function* () {
      return yield* new CloudLinkInternalError({ operation: "update-live-activity-preference" });
    }),
    answerHealthRequest: Effect.fn("CloudLink.answerHealthRequest")(function* () {
      return yield* new CloudLinkProofRejectedError({ request: "health" });
    }),
    mintCredential: Effect.fn("CloudLink.mintCredential")(function* () {
      return yield* new CloudLinkProofRejectedError({ request: "mint" });
    }),
    reconcileDesiredLinkIfStillDesired: Effect.fn("CloudLink.reconcileDesiredLinkIfStillDesired")(
      function* () {
        return null;
      },
    ),
    registerManagedTunnelRecovery: Effect.fn("CloudLink.registerManagedTunnelRecovery")(
      function* () {
        return { status: "not_linked" as const };
      },
    ),
    recoverManagedTunnel: Effect.fn("CloudLink.recoverManagedTunnel")(function* () {
      return false;
    }),
    startManagedTunnelIfOriginConfirmed: Effect.fn("CloudLink.startManagedTunnelIfOriginConfirmed")(
      function* () {
        return false;
      },
    ),
    releaseManagedTunnelOnShutdown: Effect.fn("CloudLink.releaseManagedTunnelOnShutdown")(
      function* () {
        return false;
      },
    ),
  }),
);
