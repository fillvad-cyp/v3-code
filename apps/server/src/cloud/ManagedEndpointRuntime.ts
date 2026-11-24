// V3 Code permanently disables Cloudflare managed tunnel spawning and downloads.
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export type CloudManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
      readonly failure: "unsupported-platform" | "not-installed" | "spawn-failed";
      readonly reason: string;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "running";
      readonly providerKind: "cloudflare_tunnel";
      readonly pid: number;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "unsupported";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
    };

export interface ConnectorFacts {
  readonly pid: number;
  readonly readyConnections: number | null;
  readonly hostname: string | null;
  readonly origin: string | null;
  readonly protocol: string | null;
}

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
    readonly inspectConnector: Effect.Effect<ConnectorFacts | null>;
    readonly readinessChanged: Stream.Stream<void>;
    readonly recoveryRequests: Stream.Stream<RelayManagedEndpointRuntimeConfig>;
    readonly requestRecovery: (config: RelayManagedEndpointRuntimeConfig) => Effect.Effect<void>;
    readonly restartConnector: (
      pid: number,
      stillDead: Effect.Effect<boolean>,
    ) => Effect.Effect<boolean>;
    readonly tunnelConnected: Stream.Stream<void>;
    readonly withLinkStateLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("v3code/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

export const RELAY_CLIENT_LOG_FILE = "relay-client.ndjson";

export function classifyRelayClientOutput(
  _line: string,
): "connected" | "unregistered" | "warning" | "debug" {
  return "debug";
}

export function isRejectedRelayClientTunnelOutput(_line: string): boolean {
  return false;
}

export function isRetryableManagedEndpointRuntimeStatus(_status: unknown): boolean {
  return false;
}

/** @public */
export const make = Effect.succeed(
  CloudManagedEndpointRuntime.of({
    applyConfig: Effect.fn("CloudManagedEndpointRuntime.applyConfig")(function* () {
      return { status: "disabled" as const };
    }),
    inspectConnector: Effect.succeed(null),
    readinessChanged: Stream.empty,
    recoveryRequests: Stream.empty,
    requestRecovery: Effect.fn("CloudManagedEndpointRuntime.requestRecovery")(function* () {}),
    restartConnector: Effect.fn("CloudManagedEndpointRuntime.restartConnector")(function* () {
      return false;
    }),
    tunnelConnected: Stream.empty,
    withLinkStateLock: Effect.fn("CloudManagedEndpointRuntime.withLinkStateLock")(function* <
      A,
      E,
      R,
    >(effect: Effect.Effect<A, E, R>) {
      return yield* effect;
    }),
  }),
);

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
