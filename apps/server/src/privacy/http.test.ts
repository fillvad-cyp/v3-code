import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthAccessWriteScope, AuthSessionId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { PRIVACY_PANIC_LOGOUT_PATH, PRIVACY_STATUS_PATH } from "@t3tools/shared/privacyShield";
import {
  PRIVACY_VAULT_ACTION_HEADER,
  PRIVACY_VAULT_PATH,
  PRIVACY_VAULT_PROXIES_PATH,
} from "@t3tools/shared/privacyVault";
import { describe, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as PrivacyHttp from "./http.ts";
import * as PrivacyVaultService from "./PrivacyVaultService.ts";

function makeTestLayer(options: {
  readonly authenticated: boolean;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly configOverrides?: Partial<ServerConfig.ServerConfig["Service"]>;
  readonly revokeClientSpy?: (id: AuthSessionId) => void;
  readonly revokeOtherSpy?: (id: AuthSessionId) => void;
  readonly revokeLinkSpy?: (id: string) => void;
}) {
  const sessionId = AuthSessionId.make("session-test-1");
  const authMock = EnvironmentAuth.EnvironmentAuth.of({
    authenticateHttpRequest: () =>
      options.authenticated
        ? Effect.succeed({
            sessionId,
            subject: "browser",
            method: "browser-session-cookie",
            scopes: options.scopes ?? [AuthAccessWriteScope],
          })
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
    revokeClient: (id: AuthSessionId) => {
      options.revokeClientSpy?.(id);
      return Effect.succeed(true);
    },
    revokeOtherClientSessions: (id: AuthSessionId) => {
      options.revokeOtherSpy?.(id);
      return Effect.succeed(2);
    },
    listPairingLinks: () => Effect.succeed([{ id: "link-1" }]),
    revokePairingLink: (id: string) => {
      options.revokeLinkSpy?.(id);
      return Effect.succeed(true);
    },
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);

  const sessionsMock = SessionStore.SessionStore.of({
    cookieName: "v3_session_test",
    legacyCookieName: "t3_session_legacy",
  } as unknown as SessionStore.SessionStore["Service"]);

  const baseConfigLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig.ServerConfig;
      return ServerConfig.make({
        ...base,
        ...options.configOverrides,
      });
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "v3-privacy-http-" })));

  return HttpRouter.serve(PrivacyHttp.layer, { disableLogger: true }).pipe(
    Layer.provide(PrivacyVaultService.layer),
    Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, authMock)),
    Layer.provide(Layer.succeed(SessionStore.SessionStore, sessionsMock)),
    Layer.provide(baseConfigLayer),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(NodeHttpPlatform.layer),
    Layer.provide(NodeServices.layer),
  );
}

describe("Privacy HTTP routes", () => {
  it.effect("rejects unauthenticated GET /api/privacy/status with 401", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(HttpClientRequest.get(PRIVACY_STATUS_PATH));
      expect(response.status).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }).pipe(Effect.provide(makeTestLayer({ authenticated: false }))),
  );

  it.effect("returns redacted PrivacyShieldStatus for authenticated requests", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(HttpClientRequest.get(PRIVACY_STATUS_PATH));
      const body = yield* response.json;
      expect(response.status).toBe(200);
      expect(body).toEqual({
        ephemeral: true,
        ephemeralStorage: "ram",
        noLogs: true,
        strictPrivacy: true,
        telemetryOptOutCount: 20,
        scrubbedEnvCount: 3,
        proxyEnabled: true,
        proxyDisplay: "socks5h://127.0.0.1:9050",
        zeroTelemetry: true,
        autoUpdatesDisabled: true,
      });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          authenticated: true,
          configOverrides: {
            ephemeral: true,
            ephemeralStorage: "ram",
            noLogs: true,
            strictPrivacy: true,
            proxyUrl: "socks5h://user:secret@127.0.0.1:9050",
            privacyTelemetryOptOutCount: 20,
            privacyScrubbedEnvCount: 3,
          },
        }),
      ),
    ),
  );

  it.effect("returns 401 and expires cookies on unauthenticated panic logout", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(PRIVACY_PANIC_LOGOUT_PATH).pipe(
          HttpClientRequest.setHeader("x-v3-panic-confirm", "1"),
        ),
      );
      expect(response.status).toBe(401);
      expect(String(response.headers["set-cookie"])).toContain("v3_session_test=");
    }).pipe(Effect.provide(makeTestLayer({ authenticated: false }))),
  );

  it.effect("enforces access:write scope when revokeAll is requested", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(PRIVACY_PANIC_LOGOUT_PATH).pipe(
          HttpClientRequest.setHeader("x-v3-panic-confirm", "1"),
          HttpClientRequest.bodyJsonUnsafe({ revokeAll: true }),
        ),
      );
      expect(response.status).toBe(403);
    }).pipe(Effect.provide(makeTestLayer({ authenticated: true, scopes: [] }))),
  );

  it.effect(
    "requires confirmation header, revokes devices + pairing links, and expires cookies",
    () => {
      const revokeClientSpy = vi.fn();
      const revokeOtherSpy = vi.fn();
      const revokeLinkSpy = vi.fn();
      const layer = makeTestLayer({
        authenticated: true,
        revokeClientSpy,
        revokeOtherSpy,
        revokeLinkSpy,
      });

      return Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const rejected = yield* client.execute(HttpClientRequest.post(PRIVACY_PANIC_LOGOUT_PATH));
        expect(rejected.status).toBe(400);

        const accepted = yield* client.execute(
          HttpClientRequest.post(PRIVACY_PANIC_LOGOUT_PATH).pipe(
            HttpClientRequest.setHeader("x-v3-panic-confirm", "1"),
            HttpClientRequest.bodyJsonUnsafe({ revokeAll: true }),
          ),
        );
        const body = yield* accepted.json;
        expect(accepted.status).toBe(200);
        expect(body).toEqual({
          ok: true,
          revokedSessions: 3,
          revokedPairingLinks: 1,
          revokedAll: true,
          keptCurrentSession: false,
        });
        expect(revokeClientSpy).toHaveBeenCalledTimes(1);
        expect(revokeOtherSpy).toHaveBeenCalledTimes(1);
        expect(revokeLinkSpy).toHaveBeenCalledWith("link-1");
        expect(String(accepted.headers["set-cookie"])).toContain("v3_session_test=");
        expect(String(accepted.headers["set-cookie"])).toContain("t3_session_legacy=");

        const keepSelf = yield* client.execute(
          HttpClientRequest.post(PRIVACY_PANIC_LOGOUT_PATH).pipe(
            HttpClientRequest.setHeader("x-v3-panic-confirm", "1"),
            HttpClientRequest.bodyJsonUnsafe({ revokeAll: true, keepCurrentSession: true }),
          ),
        );
        const keepBody = yield* keepSelf.json;
        expect(keepSelf.status).toBe(200);
        expect(keepBody).toEqual({
          ok: true,
          revokedSessions: 2,
          revokedPairingLinks: 1,
          revokedAll: true,
          keptCurrentSession: true,
        });
        expect(revokeClientSpy).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("gates privacy vault endpoints by auth and confirmation header", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const initial = yield* client.execute(HttpClientRequest.get(PRIVACY_VAULT_PATH));
      expect(initial.status).toBe(200);

      const missingHeader = yield* client.execute(
        HttpClientRequest.post(PRIVACY_VAULT_PROXIES_PATH).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            action: "add",
            name: "Tor",
            url: "socks5h://u:p@127.0.0.1:9050",
          }),
        ),
      );
      expect(missingHeader.status).toBe(400);

      const added = yield* client.execute(
        HttpClientRequest.post(PRIVACY_VAULT_PROXIES_PATH).pipe(
          HttpClientRequest.setHeader(PRIVACY_VAULT_ACTION_HEADER, "1"),
          HttpClientRequest.bodyJsonUnsafe({
            action: "add",
            name: "Tor",
            url: "socks5h://u:p@127.0.0.1:9050",
          }),
        ),
      );
      expect(added.status).toBe(200);
      const body = (yield* added.json) as {
        readonly ok: boolean;
        readonly snapshot: { readonly proxies: ReadonlyArray<{ readonly displayUrl: string }> };
      };
      expect(body.ok).toBe(true);
      expect(body.snapshot.proxies[0]?.displayUrl).toBe("socks5h://u:***@127.0.0.1:9050");
    }).pipe(Effect.provide(makeTestLayer({ authenticated: true }))),
  );
});
