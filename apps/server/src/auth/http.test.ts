import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentHttpApi,
  ProjectId,
  ceilingScopes,
  intersectScopes,
  roleScopes,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as InvitationService from "../identity/InvitationService.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as AuthHttp from "./http.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const layerIdentityRepositories = Layer.mergeAll(
  Principals.layer,
  Memberships.layer,
  Invitations.layer,
  AuditEvents.layer,
);
const layerIdentity = Layer.mergeAll(
  InvitationService.layer.pipe(
    Layer.provide(ProjectAccess.layer.pipe(Layer.provide(layerIdentityRepositories))),
    Layer.provide(layerIdentityRepositories),
  ),
  ProjectAccess.layer.pipe(Layer.provide(layerIdentityRepositories)),
  layerIdentityRepositories,
);
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provide(layerIdentity),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.promise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          expect(devCookies.filter((cookie) => /;\s*Secure/i.test(cookie))).toEqual([]);
          const httpsResponse = await environmentA.handler(
            postJson(
              "/api/auth/browser-session",
              { credential: DEV_TOKEN },
              { "x-forwarded-proto": "https" },
            ),
            requestContext,
          );
          const httpsCookies = httpsResponse.headers.getSetCookie();
          expect(httpsCookies).toHaveLength(2);
          for (const cookie of httpsCookies) expect(cookie).toMatch(/;\s*Secure/i);
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["DPoP", "dpop"])("challenges a refused %s request with DPoP", (scheme) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const refused = await environment.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { authorization: `${scheme} not-a-valid-token` },
            ),
            requestContext,
          );
          expect(refused.status).toBe(401);
          expect(refused.headers.get("www-authenticate")).toBe("DPoP");
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

// The web handler runs on its own runtime, so proofs need wall-clock time.
it.live("checks token-endpoint DPoP proofs without writing replay state", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const written: Array<string> = [];
    const recordingSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: (name) => Effect.sync(() => void written.push(name)),
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, recordingSecretStore),
    );
    const url = "http://127.0.0.1/oauth/token";
    const key = makeDpopKey();
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const tokenRequest = (subjectToken: string, proof: string) =>
      new Request(url, {
        method: "POST",
        headers: { host: "127.0.0.1", dpop: proof },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: subjectToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const unknownToken = await environment.handler(
            tokenRequest("not-a-pairing-token", key.sign({ method: "POST", url, token: "", iat })),
            requestContext,
          );
          expect(unknownToken.status).toBe(401);
          expect(await unknownToken.json()).not.toHaveProperty("dpopFailureReason");

          const accepted = await environment.handler(
            tokenRequest(DEV_TOKEN, key.sign({ method: "POST", url, token: "", iat })),
            requestContext,
          );
          expect(accepted.status).toBe(200);
          expect(await accepted.json()).toMatchObject({ token_type: "DPoP" });

          const badProof = await environment.handler(
            tokenRequest(DEV_TOKEN, "not-a-proof"),
            requestContext,
          );
          expect(badProof.status).toBe(401);
          expect(badProof.headers.get("www-authenticate")).toBe("DPoP");
          expect(written).toEqual([]);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "issues, serves, accepts, and revokes invitations with principal-bound sessions over HTTP",
  () =>
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      let capturedSessions: SessionStore.SessionStore["Service"] | undefined;
      const captureSessionsLayer = Layer.effectDiscard(
        SessionStore.SessionStore.pipe(
          Effect.tap((sessions) =>
            Effect.sync(() => {
              capturedSessions = sessions;
            }),
          ),
        ),
      );
      const testLayer = captureSessionsLayer.pipe(
        Layer.provideMerge(layerRoutes),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const requestContext = Context.make(SecureRandom.SecureRandom, random);

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(testLayer, { disableLogger: true })),
        (environment) =>
          Effect.gen(function* () {
            const devResponse = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
                requestContext,
              ),
            );
            expect(devResponse.status).toBe(200);
            const ownerCookie =
              devResponse.headers
                .getSetCookie()
                .find((cookie) => cookie.startsWith("t3_dev_session_"))
                ?.split(";", 1)[0] ?? "";

            const projectId = ProjectId.make("kotcrm");
            const createResponse = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { kind: "staff", role: "developer", projectId },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(createResponse.status).toBe(200);
            const created = (yield* Effect.promise(() => createResponse.json())) as {
              invitation: { id: string; role: string; projectId: string | null };
              code: string;
            };
            expect(created.invitation.role).toBe("developer");
            expect(created.invitation.projectId).toBe(projectId);
            expect(created.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

            const listResponse = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/invitations", {
                  headers: { cookie: ownerCookie },
                }),
                requestContext,
              ),
            );
            expect(listResponse.status).toBe(200);
            const pending = (yield* Effect.promise(() => listResponse.json())) as Array<{
              id: string;
            }>;
            expect(pending.map((row) => row.id)).toEqual([created.invitation.id]);

            const pageResponse = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/invite/${encodeURIComponent(created.code)}`),
                requestContext,
              ),
            );
            expect(pageResponse.status).toBe(200);
            expect(pageResponse.headers.get("content-type")).toContain("text/html");
            const html = yield* Effect.promise(() => pageResponse.text());
            expect(html).toContain(created.code);
            expect(html).toContain("/api/auth/invitations/accept");
            expect(html).toContain("Ready - open the app");

            const acceptResponse = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/accept", {
                  code: created.code,
                  displayName: "Grace Hopper",
                }),
                requestContext,
              ),
            );
            expect(acceptResponse.status).toBe(200);
            const acceptBody = (yield* Effect.promise(() => acceptResponse.json())) as {
              authenticated: boolean;
              sessionMethod: string;
              binding_kind: string;
              binding: { _tag: string };
              role: string;
              permissions: Array<string>;
            };
            expect(acceptBody.authenticated).toBe(true);
            expect(acceptBody.sessionMethod).toBe("browser-session-cookie");
            expect(acceptBody.binding_kind).toBe("principal");
            expect(acceptBody.binding).toEqual({ _tag: "principal" });
            expect(acceptBody.role).toBe("developer");
            expect(acceptBody.permissions).toEqual(
              intersectScopes(roleScopes("developer"), ceilingScopes("staff")),
            );

            const sessionCookie = acceptResponse.headers
              .getSetCookie()
              .find((cookie) => cookie.startsWith("t3_session_"));
            expect(sessionCookie).toBeDefined();
            const cookiePair = sessionCookie!.split(";", 1)[0]!;
            const sessionToken = cookiePair.slice(cookiePair.indexOf("=") + 1);

            const verified = yield* capturedSessions!.verify(sessionToken);
            expect(verified.principalId).toBeDefined();
            expect(verified.subject).toBe(`principal:${verified.principalId}`);
            expect(verified.binding).toEqual({ _tag: "principal" });
            expect(verified.method).toBe("browser-session-cookie");

            // Double-accept fails with 409 Conflict.
            const doubleAccept = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/accept", {
                  code: created.code,
                  displayName: "Again",
                }),
                requestContext,
              ),
            );
            expect(doubleAccept.status).toBe(409);

            // Developer cannot issue invitations (403).
            const devInviteAttempt = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { kind: "staff", role: "viewer", projectId },
                  { cookie: cookiePair },
                ),
                requestContext,
              ),
            );
            expect(devInviteAttempt.status).toBe(403);

            // Owner lists members and sees owner + Grace Hopper with developer membership.
            const membersResponse = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/members", {
                  headers: { cookie: ownerCookie },
                }),
                requestContext,
              ),
            );
            expect(membersResponse.status).toBe(200);
            const members = (yield* Effect.promise(() => membersResponse.json())) as Array<{
              principal: { id: string; displayName: string; kind: string; status: string };
              memberships: Array<{ projectId: string; role: string; state: string }>;
            }>;
            const grace = members.find((entry) => entry.principal.id === verified.principalId);
            expect(grace).toBeDefined();
            expect(grace!.principal.displayName).toBe("Grace Hopper");
            expect(grace!.memberships).toEqual([
              expect.objectContaining({ projectId, role: "developer", state: "active" }),
            ]);

            // Create and revoke a second invitation, then confirm accept fails with 400.
            const secondCreate = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { kind: "staff", role: "viewer", projectId },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            const second = (yield* Effect.promise(() => secondCreate.json())) as {
              invitation: { id: string };
              code: string;
            };
            const revokeResponse = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/invitations/${second.invitation.id}`, {
                  method: "DELETE",
                  headers: { cookie: ownerCookie },
                }),
                requestContext,
              ),
            );
            expect(revokeResponse.status).toBe(200);
            expect(yield* Effect.promise(() => revokeResponse.json())).toEqual({ revoked: true });

            const revokedAccept = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/accept", {
                  code: second.code,
                  displayName: "Revoked",
                }),
                requestContext,
              ),
            );
            expect(revokedAccept.status).toBe(400);
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
