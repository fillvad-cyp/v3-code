import { describe, expect, it } from "@effect/vitest";
import {
  Connection,
  ConnectionOnboarding,
  Connectivity,
  CredentialStore,
  EnvironmentRegistry,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import {
  ClientCapabilities,
  Persistence,
  PlatformConnectionSource,
} from "@t3tools/client-runtime/platform";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION, PrincipalId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Socket from "effect/socket/Socket";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import * as MobileStorage from "../../connection/storage";
import * as MobileSecureStorage from "../../persistence/mobile-secure-storage";

function makeMemorySecureStorage() {
  const values = new Map<string, string>();
  const service = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  });
  return { values, layer: Layer.succeed(MobileSecureStorage.MobileSecureStorage, service) };
}

function makeMultiUserHttpClient(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly token: string;
}) {
  const calls: Array<{ readonly url: string; readonly method: string }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      calls.push({ url: request.url, method: request.method });
      const pathname = new URL(request.url).pathname;
      if (pathname === "/.well-known/t3/environment") {
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              environmentId: input.environmentId,
              label: input.label,
              platform: { os: "linux", arch: "x64" },
              serverVersion: "1.0.0",
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
              authMode: "multi-user",
              capabilities: {
                repositoryIdentity: true,
                members: true,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (pathname === "/api/auth/invitations/login") {
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              authenticated: true,
              token: input.token,
              expiresAt: "2027-01-01T00:00:00.000Z",
              scopes: ["orchestration:read", "orchestration:operate"],
              permissions: ["orchestration:read", "orchestration:operate"],
              sessionMethod: "bearer-access-token",
              binding_kind: "principal",
              binding: { _tag: "principal" },
              role: "developer",
              principal: {
                id: PrincipalId.make("member-1"),
                kind: "member",
                displayName: "Alex",
                email: null,
                status: "active",
                ceiling: ["orchestration:read", "orchestration:operate"],
                accessRevision: 1,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                removedAt: null,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 }));
    }),
  );
  return { calls, layer: Layer.succeed(HttpClient.HttpClient, client) };
}

describe("mobile one-time-code login rehydration", () => {
  it.effect("persists the bearer session from registerLoginCode and rehydrates it on restart", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("env-team-hub");
      const storage = makeMemorySecureStorage();
      const http = makeMultiUserHttpClient({
        environmentId,
        label: "Team Hub",
        token: "bearer-session-token-123",
      });

      const buildRuntimeLayer = () => {
        const persistenceLayer = MobileStorage.layer.pipe(Layer.provide(storage.layer));
        const platformLayer = Layer.mergeAll(
          persistenceLayer,
          http.layer,
          // Keep connectivity offline so background supervisors stay parked during persistence checks.
          Connectivity.layer({ status: Effect.succeed("offline"), changes: Stream.never }),
          Layer.succeed(
            Wakeups.ConnectionWakeups,
            Wakeups.ConnectionWakeups.of({ changes: Stream.never }),
          ),
          Layer.mock(Persistence.EnvironmentCacheStore)({}),
          Layer.mock(Persistence.EnvironmentOwnedDataCleanup)({}),
          Layer.mock(ClientCapabilities.SshEnvironmentGateway)({}),
          Layer.mock(ClientCapabilities.ClientPresentation)({ metadata: {} }),
          Layer.mock(ClientCapabilities.PrimaryEnvironmentAuth)({}),
          Layer.succeed(
            ClientCapabilities.CloudSession,
            ClientCapabilities.CloudSession.of({
              identity: Effect.succeedNone,
              clerkToken: Effect.die("unused"),
            }),
          ),
          Layer.succeed(
            ClientCapabilities.RelayDeviceIdentity,
            ClientCapabilities.RelayDeviceIdentity.of({
              deviceId: Effect.succeedNone,
            }),
          ),
          Layer.succeed(
            PlatformConnectionSource.PlatformConnectionSource,
            PlatformConnectionSource.PlatformConnectionSource.of({
              registrations: Stream.empty,
            }),
          ),
          Layer.mock(ManagedRelay.ManagedRelayClient)({ relayUrl: "http://relay.invalid" }),
          Layer.mock(ManagedRelay.ManagedRelayDpopSigner)({}),
          Layer.succeed(Socket.WebSocketConstructor, () => {
            throw new Error("Unexpected WebSocket connection");
          }),
        );
        return Connection.layer.pipe(Layer.provideMerge(platformLayer));
      };

      // Session 1: sign in via one-time login code and register in mobile secure storage.
      const registeredId = yield* Effect.gen(function* () {
        const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
        return yield* onboarding.registerLoginCode({
          host: "https://hub.example.test",
          code: "LOGIN-CODE-999",
        });
      }).pipe(Effect.provide(buildRuntimeLayer()));

      expect(registeredId).toBe(environmentId);
      expect(http.calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/.well-known/t3/environment",
        "/api/auth/invitations/login",
      ]);

      // Session 2 (cold restart): build a fresh registry and storage layer over the same
      // persisted secure storage and confirm target, profile, and bearer token rehydrate.
      const rehydrated = yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const credentials = yield* CredentialStore.ConnectionCredentialStore;
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        if (entry === undefined) return null;
        if (entry.target._tag !== "BearerConnectionTarget") return null;
        const credential = yield* credentials.get(entry.target.connectionId);
        return { entry, credential };
      }).pipe(Effect.provide(buildRuntimeLayer()));

      expect(rehydrated).not.toBeNull();
      expect(rehydrated!.entry.enabled).toBe(true);
      expect(rehydrated!.entry.target.label).toBe("Team Hub");
      expect(Option.isSome(rehydrated!.entry.profile)).toBe(true);
      if (
        Option.isSome(rehydrated!.entry.profile) &&
        rehydrated!.entry.profile.value._tag === "BearerConnectionProfile"
      ) {
        expect(rehydrated!.entry.profile.value.httpBaseUrl).toBe("https://hub.example.test/");
      }
      expect(Option.isSome(rehydrated!.credential)).toBe(true);
      if (Option.isSome(rehydrated!.credential)) {
        expect(rehydrated!.credential.value._tag).toBe("BearerConnectionCredential");
        if (rehydrated!.credential.value._tag === "BearerConnectionCredential") {
          expect(rehydrated!.credential.value.token).toBe("bearer-session-token-123");
        }
      }
    }),
  );
});
