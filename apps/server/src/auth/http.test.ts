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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ApiTokenService from "../identity/ApiTokenService.ts";
import * as AuditService from "../identity/AuditService.ts";
import * as InvitationService from "../identity/InvitationService.ts";
import * as MembershipService from "../identity/MembershipService.ts";
import * as Passwords from "../identity/Passwords.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as RecoveryCodes from "../persistence/RecoveryCodes.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";
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

const layerIdentityRepositories = Layer.mergeAll(
  Principals.layer,
  Memberships.layer,
  Invitations.layer,
  AuditEvents.layer,
  ApiTokens.layer,
  MemberLimits.layer,
  RecoveryCodes.layer,
  SessionPrincipals.layer,
);
const makeLayerEnvironmentAuth = (settingsOverrides?: { readonly multiUser?: boolean }) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest(settingsOverrides)),
    Layer.provide(layerIdentityRepositories),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
  );
const layerAccess = ProjectAccess.layer.pipe(
  Layer.provide(layerIdentityRepositories),
  Layer.provide(ProjectStore.layer),
);
const layerMembership = MembershipService.layer.pipe(
  Layer.provide(layerAccess),
  Layer.provide(layerIdentityRepositories),
);
const layerIdentity = Layer.mergeAll(
  InvitationService.layer.pipe(
    Layer.provide(layerMembership),
    Layer.provide(layerAccess),
    Layer.provide(layerIdentityRepositories),
  ),
  Passwords.layer.pipe(Layer.provide(layerIdentityRepositories)),
  AuditService.layer.pipe(
    Layer.provide(layerAccess),
    Layer.provide(layerIdentityRepositories),
    Layer.provide(ServerSettings.layerTest()),
  ),
  ApiTokenService.layer.pipe(Layer.provide(layerAccess), Layer.provide(layerIdentityRepositories)),
  layerMembership,
  layerAccess,
  layerIdentityRepositories,
);
const makeLayerRoutes = (settingsOverrides?: { readonly multiUser?: boolean }) => {
  const authLayer = makeLayerEnvironmentAuth(settingsOverrides);
  return HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provideMerge(layerIdentity),
    Layer.provideMerge(authLayer),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};
const layerRoutes = makeLayerRoutes();

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });
const patchJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "PATCH",
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

it.effect(
  "manages members via PATCH and DELETE /api/auth/members/:principalId with 400/403/404 enforcement",
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

            const projectA = ProjectId.make("project-alpha");
            const projectB = ProjectId.make("project-beta");

            const inviteAndAccept = (
              role: "admin" | "developer" | "operator" | "viewer",
              projectId: ProjectId,
              displayName: string,
            ) =>
              Effect.gen(function* () {
                const createResp = yield* Effect.promise(() =>
                  environment.handler(
                    postJson(
                      "/api/auth/invitations",
                      { kind: "staff", role, projectId },
                      { cookie: ownerCookie },
                    ),
                    requestContext,
                  ),
                );
                expect(createResp.status).toBe(200);
                const created = (yield* Effect.promise(() => createResp.json())) as {
                  code: string;
                };
                const acceptResp = yield* Effect.promise(() =>
                  environment.handler(
                    postJson("/api/auth/invitations/accept", {
                      code: created.code,
                      displayName,
                    }),
                    requestContext,
                  ),
                );
                expect(acceptResp.status).toBe(200);
                const cookie = acceptResp.headers
                  .getSetCookie()
                  .find((entry) => entry.startsWith("t3_session_"))!
                  .split(";", 1)[0]!;
                const token = cookie.slice(cookie.indexOf("=") + 1);
                const verified = yield* capturedSessions!.verify(token);
                return { principalId: verified.principalId!, cookie };
              });

            const adminA = yield* inviteAndAccept("admin", projectA, "Admin A");
            const devA = yield* inviteAndAccept("developer", projectA, "Dev A");
            const devB = yield* inviteAndAccept("developer", projectB, "Dev B");

            // 400 when role/state is sent without projectId or when body is empty.
            const missingProjectResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${devA.principalId}`,
                  { role: "operator" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(missingProjectResp.status).toBe(400);

            const emptyPatchResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(`/api/auth/members/${devA.principalId}`, {}, { cookie: ownerCookie }),
                requestContext,
              ),
            );
            expect(emptyPatchResp.status).toBe(400);

            // Developer lacks access:write and gets 403 on PATCH and DELETE.
            const devPatchResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${adminA.principalId}`,
                  { projectId: projectA, role: "viewer" },
                  { cookie: devA.cookie },
                ),
                requestContext,
              ),
            );
            expect(devPatchResp.status).toBe(403);

            const devDeleteResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(
                  `http://127.0.0.1/api/auth/members/${adminA.principalId}?projectId=${projectA}`,
                  {
                    method: "DELETE",
                    headers: { cookie: devA.cookie },
                  },
                ),
                requestContext,
              ),
            );
            expect(devDeleteResp.status).toBe(403);

            // Project A admin updates Dev A role and state on Project A.
            const adminPatchResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${devA.principalId}`,
                  { projectId: projectA, role: "operator", state: "suspended" },
                  { cookie: adminA.cookie },
                ),
                requestContext,
              ),
            );
            expect(adminPatchResp.status).toBe(200);
            const updatedByAdmin = (yield* Effect.promise(() => adminPatchResp.json())) as {
              principal: { id: string; accessRevision: number };
              memberships: Array<{ projectId: string; role: string; state: string }>;
            };
            expect(updatedByAdmin.principal.accessRevision).toBeGreaterThanOrEqual(2);
            expect(updatedByAdmin.memberships).toEqual([
              expect.objectContaining({
                projectId: projectA,
                role: "operator",
                state: "suspended",
              }),
            ]);

            // Project A admin cannot set ceiling (owner-only -> 403) or manage Project B (403).
            const adminCeilingResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${devA.principalId}`,
                  { ceiling: "restricted" },
                  { cookie: adminA.cookie },
                ),
                requestContext,
              ),
            );
            expect(adminCeilingResp.status).toBe(403);

            const adminOtherProjectResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${devB.principalId}`,
                  { projectId: projectB, role: "viewer" },
                  { cookie: adminA.cookie },
                ),
                requestContext,
              ),
            );
            expect(adminOtherProjectResp.status).toBe(403);

            // Project A admin cannot remove a whole principal (owner-only -> 403).
            const adminDeletePrincipalResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/members/${devA.principalId}`, {
                  method: "DELETE",
                  headers: { cookie: adminA.cookie },
                }),
                requestContext,
              ),
            );
            expect(adminDeletePrincipalResp.status).toBe(403);

            // Owner lowers Dev A's ceiling to restricted, then attempting developer role fails with 403.
            const ownerCeilingResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${devA.principalId}`,
                  { ceiling: "restricted" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(ownerCeilingResp.status).toBe(200);
            const afterCeiling = (yield* Effect.promise(() => ownerCeilingResp.json())) as {
              principal: { ceiling: Array<string> };
            };
            expect(afterCeiling.principal.ceiling).toEqual([...ceilingScopes("restricted")]);

            const exceedCeilingResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${devA.principalId}`,
                  { projectId: projectA, role: "developer" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(exceedCeilingResp.status).toBe(403);

            // 404 for unknown principal or missing membership.
            const missingPrincipalPatch = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  "/api/auth/members/does-not-exist",
                  { ceiling: "staff" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(missingPrincipalPatch.status).toBe(404);
            expect(yield* Effect.promise(() => missingPrincipalPatch.json())).toMatchObject({
              reason: "member_not_found",
            });

            const missingMembershipDelete = yield* Effect.promise(() =>
              environment.handler(
                new Request(
                  `http://127.0.0.1/api/auth/members/${devA.principalId}?projectId=${projectB}`,
                  {
                    method: "DELETE",
                    headers: { cookie: ownerCookie },
                  },
                ),
                requestContext,
              ),
            );
            expect(missingMembershipDelete.status).toBe(404);
            expect(yield* Effect.promise(() => missingMembershipDelete.json())).toMatchObject({
              reason: "membership_not_found",
            });

            // Removing the last active admin of Project A promotes owner to admin.
            const removeLastAdminResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(
                  `http://127.0.0.1/api/auth/members/${adminA.principalId}?projectId=${projectA}`,
                  {
                    method: "DELETE",
                    headers: { cookie: ownerCookie },
                  },
                ),
                requestContext,
              ),
            );
            expect(removeLastAdminResp.status).toBe(200);
            expect(yield* Effect.promise(() => removeLastAdminResp.json())).toEqual({
              removed: true,
              promotedOwner: true,
            });

            // Owner cannot delete the owner principal (403).
            const deleteOwnerResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/members/owner", {
                  method: "DELETE",
                  headers: { cookie: ownerCookie },
                }),
                requestContext,
              ),
            );
            expect(deleteOwnerResp.status).toBe(403);

            // Project A admin cannot suspend/reactivate a whole principal (owner-only -> 403).
            const adminSuspendPrincipalResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${devA.principalId}`,
                  { state: "suspended" },
                  { cookie: adminA.cookie },
                ),
                requestContext,
              ),
            );
            expect(adminSuspendPrincipalResp.status).toBe(403);

            // Owner cannot suspend the owner principal (403).
            const suspendOwnerResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  "/api/auth/members/owner",
                  { state: "suspended" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(suspendOwnerResp.status).toBe(403);

            // Owner suspends Dev B at the principal level without projectId -> 200,
            // principal + memberships suspended, and Dev B's session is revoked (401).
            const ownerSuspendResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${devB.principalId}`,
                  { state: "suspended" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(ownerSuspendResp.status).toBe(200);
            const suspendedDevB = (yield* Effect.promise(() => ownerSuspendResp.json())) as {
              principal: { status: string; accessRevision: number };
              memberships: Array<{ projectId: string; state: string }>;
            };
            expect(suspendedDevB.principal.status).toBe("suspended");
            expect(suspendedDevB.principal.accessRevision).toBeGreaterThanOrEqual(1);
            expect(suspendedDevB.memberships).toEqual([
              expect.objectContaining({ projectId: projectB, state: "suspended" }),
            ]);

            const suspendedSessionCheck = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/members", {
                  headers: { cookie: devB.cookie },
                }),
                requestContext,
              ),
            );
            expect(suspendedSessionCheck.status).toBe(401);

            // Owner reactivates Dev B without projectId -> 200, principal + memberships active,
            // while the previously revoked session remains invalid (must sign in again).
            const ownerReactivateResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${devB.principalId}`,
                  { state: "active" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(ownerReactivateResp.status).toBe(200);
            const reactivatedDevB = (yield* Effect.promise(() => ownerReactivateResp.json())) as {
              principal: { status: string; accessRevision: number };
              memberships: Array<{ projectId: string; state: string }>;
            };
            expect(reactivatedDevB.principal.status).toBe("active");
            expect(reactivatedDevB.principal.accessRevision).toBeGreaterThan(
              suspendedDevB.principal.accessRevision,
            );
            expect(reactivatedDevB.memberships).toEqual([
              expect.objectContaining({ projectId: projectB, state: "active" }),
            ]);

            const staleCookieAfterReactivate = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/members", {
                  headers: { cookie: devB.cookie },
                }),
                requestContext,
              ),
            );
            expect(staleCookieAfterReactivate.status).toBe(401);

            // Owner deletes Dev A principal -> 200 and Dev A's session is revoked (401).
            const deleteDevResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/members/${devA.principalId}`, {
                  method: "DELETE",
                  headers: { cookie: ownerCookie },
                }),
                requestContext,
              ),
            );
            expect(deleteDevResp.status).toBe(200);
            expect(yield* Effect.promise(() => deleteDevResp.json())).toEqual({ removed: true });

            const revokedSessionCheck = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/members", {
                  headers: { cookie: devA.cookie },
                }),
                requestContext,
              ),
            );
            expect(revokedSessionCheck.status).toBe(401);

            // Deleting an already-removed principal returns 404.
            const deleteAgainResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/members/${devA.principalId}`, {
                  method: "DELETE",
                  headers: { cookie: ownerCookie },
                }),
                requestContext,
              ),
            );
            expect(deleteAgainResp.status).toBe(404);
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live(
  "issues and consumes member login codes, returns a bearer token usable for WS tickets and session identity, and supports self sign-out",
  () =>
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      let capturedInvitations: InvitationService.InvitationService["Service"] | undefined;
      let capturedAuth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
      const captureLayer = Layer.effectDiscard(
        Effect.gen(function* () {
          capturedInvitations = yield* InvitationService.InvitationService;
          capturedAuth = yield* EnvironmentAuth.EnvironmentAuth;
        }),
      );
      const multiUserRoutes = makeLayerRoutes({ multiUser: true });
      const testLayer = captureLayer.pipe(
        Layer.provideMerge(multiUserRoutes),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const requestContext = Context.make(SecureRandom.SecureRandom, random);

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(testLayer, { disableLogger: true })),
        (environment) =>
          Effect.gen(function* () {
            // Unauthenticated /api/auth/session advertises authMode "multi-user".
            const unauthSessionResp = yield* Effect.promise(() =>
              environment.handler(new Request("http://127.0.0.1/api/auth/session"), requestContext),
            );
            expect(unauthSessionResp.status).toBe(200);
            const unauthSessionBody = (yield* Effect.promise(() => unauthSessionResp.json())) as {
              authenticated: boolean;
              auth: { authMode?: string };
              accessRevision?: number;
            };
            expect(unauthSessionBody).toMatchObject({
              authenticated: false,
              auth: { authMode: "multi-user" },
            });
            expect(unauthSessionBody.accessRevision).toBeUndefined();

            // Owner bootstraps and invites a member to a project.
            const devResponse = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
                requestContext,
              ),
            );
            const ownerCookie =
              devResponse.headers
                .getSetCookie()
                .find((cookie) => cookie.startsWith("t3_dev_session_"))
                ?.split(";", 1)[0] ?? "";

            const projectId = ProjectId.make("project-login-test");
            const createInviteResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { kind: "staff", role: "developer", projectId },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(createInviteResp.status).toBe(200);
            const createdInvite = (yield* Effect.promise(() => createInviteResp.json())) as {
              code: string;
            };

            const acceptResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/accept", {
                  code: createdInvite.code,
                  displayName: "Ada Lovelace",
                }),
                requestContext,
              ),
            );
            expect(acceptResp.status).toBe(200);
            const acceptedBody = (yield* Effect.promise(() => acceptResp.json())) as {
              token: string;
              principal: { id: string; displayName: string };
              binding_kind: string;
              role: string;
            };
            expect(acceptedBody.token).toBeTruthy();
            expect(acceptedBody.principal.displayName).toBe("Ada Lovelace");
            expect(acceptedBody.binding_kind).toBe("principal");
            expect(acceptedBody.role).toBe("developer");

            const memberPrincipalId = acceptedBody.principal.id as never;

            // Owner mints a login code (15-minute TTL) for the existing member.
            const loginCodeIssued = yield* capturedInvitations!.issueLogin(memberPrincipalId);
            expect(loginCodeIssued.invitation.kind).toBe("staff");
            expect(loginCodeIssued.invitation.projectId).toBeNull();
            expect(loginCodeIssued.invitation.principalId).toBe(memberPrincipalId);

            // Member can also mint a login code for herself, but not for owner.
            const expiredLoginIssued = yield* capturedInvitations!.issueLogin({
              principalId: memberPrincipalId,
              createdBy: memberPrincipalId,
              ttl: Duration.millis(-1_000),
            });
            expect(expiredLoginIssued.invitation.principalId).toBe(memberPrincipalId);

            const forbiddenOtherLogin = yield* capturedInvitations!
              .issueLogin({
                principalId: InvitationService.OWNER_PRINCIPAL_ID,
                createdBy: memberPrincipalId,
              })
              .pipe(Effect.flip);
            expect(forbiddenOtherLogin._tag).toBe("InvitationForbiddenError");

            // POST /api/auth/invitations/login logs the existing principal in without creating a new one.
            const loginResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/login", { code: loginCodeIssued.code }),
                requestContext,
              ),
            );
            expect(loginResp.status).toBe(200);
            const loginBody = (yield* Effect.promise(() => loginResp.json())) as {
              authenticated: boolean;
              token: string;
              expiresAt: string;
              scopes: Array<string>;
              permissions: Array<string>;
              sessionMethod: string;
              binding_kind: string;
              binding: { _tag: string };
              role: string;
              principal: { id: string; displayName: string };
            };
            expect(loginBody.authenticated).toBe(true);
            expect(loginBody.token).toBeTruthy();
            expect(loginBody.sessionMethod).toBe("bearer-access-token");
            expect(loginBody.binding_kind).toBe("principal");
            expect(loginBody.binding).toEqual({ _tag: "principal" });
            expect(loginBody.role).toBe("developer");
            expect(loginBody.principal.id).toBe(memberPrincipalId);
            expect(loginBody.principal.displayName).toBe("Ada Lovelace");
            expect(loginBody.permissions).toEqual(
              intersectScopes(roleScopes("developer"), ceilingScopes("staff")),
            );
            // Cookie is also set on login.
            expect(
              loginResp.headers.getSetCookie().some((cookie) => cookie.startsWith("t3_session_")),
            ).toBe(true);

            // Single-use: reusing the login code returns 409 Conflict.
            const replayResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/login", { code: loginCodeIssued.code }),
                requestContext,
              ),
            );
            expect(replayResp.status).toBe(409);

            // Expiry: an already-expired login code is rejected with 400 Bad Request.
            const expiredResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/login", { code: expiredLoginIssued.code }),
                requestContext,
              ),
            );
            expect(expiredResp.status).toBe(400);

            // GET /api/auth/session with the returned bearer token reports principal, binding, role, and authMode.
            const sessionResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/session", {
                  headers: { authorization: `Bearer ${loginBody.token}` },
                }),
                requestContext,
              ),
            );
            expect(sessionResp.status).toBe(200);
            const memberSessionBody = (yield* Effect.promise(() => sessionResp.json())) as {
              authenticated: boolean;
              accessRevision?: number;
            };
            expect(memberSessionBody).toMatchObject({
              authenticated: true,
              auth: { authMode: "multi-user" },
              binding_kind: "principal",
              binding: { _tag: "principal" },
              role: "developer",
              principal: {
                id: memberPrincipalId,
                displayName: "Ada Lovelace",
              },
            });
            expect(typeof memberSessionBody.accessRevision).toBe("number");
            const revBeforeRoleChange = memberSessionBody.accessRevision!;

            // Role change advances the environment-level accessRevision returned in session state.
            const roleUpdateResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/members/${memberPrincipalId}`, {
                  method: "PATCH",
                  headers: {
                    "content-type": "application/json",
                    cookie: ownerCookie,
                  },
                  body: JSON.stringify({ projectId, role: "operator" }),
                }),
                requestContext,
              ),
            );
            expect(roleUpdateResp.status).toBe(200);

            const sessionAfterUpdateResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/session", {
                  headers: { authorization: `Bearer ${loginBody.token}` },
                }),
                requestContext,
              ),
            );
            expect(sessionAfterUpdateResp.status).toBe(200);
            const sessionAfterUpdateBody = (yield* Effect.promise(() =>
              sessionAfterUpdateResp.json(),
            )) as { accessRevision?: number; role?: string };
            expect(sessionAfterUpdateBody.role).toBe("operator");
            expect(sessionAfterUpdateBody.accessRevision).toBeGreaterThan(revBeforeRoleChange);

            // POST /api/auth/websocket-ticket succeeds with the returned bearer token.
            const ticketResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/websocket-ticket/rpc", {
                  method: "POST",
                  headers: { authorization: `Bearer ${loginBody.token}` },
                }),
                requestContext,
              ),
            );
            expect(ticketResp.status).toBe(200);
            const ticketBody = (yield* Effect.promise(() => ticketResp.json())) as {
              ticket: string;
              expiresAt: string;
            };
            expect(ticketBody.ticket).toBeTruthy();

            // Verify the WS ticket authenticates a WebSocket upgrade for that principal.
            const upgradedSession = yield* capturedAuth!.authenticateWebSocketUpgrade(
              {
                method: "GET",
                url: `/ws?wsTicket=${encodeURIComponent(ticketBody.ticket)}`,
                originalUrl: `/ws?wsTicket=${encodeURIComponent(ticketBody.ticket)}`,
                headers: { host: "127.0.0.1" },
                cookies: {},
              } as never,
              "rpc",
            );
            expect(upgradedSession.principalId).toBe(memberPrincipalId);
            expect(upgradedSession.binding).toEqual({ _tag: "principal" });

            // Member signs out via POST /api/auth/clients/revoke { current: true } without needing access:write.
            const signOutResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/clients/revoke",
                  { current: true },
                  { authorization: `Bearer ${loginBody.token}` },
                ),
                requestContext,
              ),
            );
            expect(signOutResp.status).toBe(200);
            expect(yield* Effect.promise(() => signOutResp.json())).toEqual({ revoked: true });

            // Revoked bearer token is now rejected with 401.
            const afterSignOutTicket = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/websocket-ticket/rpc", {
                  method: "POST",
                  headers: { authorization: `Bearer ${loginBody.token}` },
                }),
                requestContext,
              ),
            );
            expect(afterSignOutTicket.status).toBe(401);
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live(
  "POST /api/auth/members/:principalId/login-code mints codes for owner and self, rejects others with 403, missing with 404, and rate limits with 429",
  () =>
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      let capturedLimits: MemberLimits.MemberLimitsRepository["Service"] | undefined;
      const captureLayer = Layer.effectDiscard(
        Effect.gen(function* () {
          capturedLimits = yield* MemberLimits.MemberLimitsRepository;
        }),
      );
      const multiUserRoutes = makeLayerRoutes({ multiUser: true });
      const testLayer = captureLayer.pipe(
        Layer.provideMerge(multiUserRoutes),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const requestContext = Context.make(SecureRandom.SecureRandom, random);

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(testLayer, { disableLogger: true })),
        (environment) =>
          Effect.gen(function* () {
            // Unauthenticated request is rejected with 401.
            const unauthResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/members/owner/login-code", {
                  method: "POST",
                }),
                requestContext,
              ),
            );
            expect(unauthResp.status).toBe(401);

            const devResponse = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
                requestContext,
              ),
            );
            const ownerCookie =
              devResponse.headers
                .getSetCookie()
                .find((cookie) => cookie.startsWith("t3_dev_session_"))
                ?.split(";", 1)[0] ?? "";

            const projectId = ProjectId.make("project-login-code-route");
            const inviteAndAccept = (displayName: string) =>
              Effect.gen(function* () {
                const invResp = yield* Effect.promise(() =>
                  environment.handler(
                    postJson(
                      "/api/auth/invitations",
                      { kind: "staff", role: "developer", projectId },
                      { cookie: ownerCookie },
                    ),
                    requestContext,
                  ),
                );
                expect(invResp.status).toBe(200);
                const inv = (yield* Effect.promise(() => invResp.json())) as { code: string };
                const accResp = yield* Effect.promise(() =>
                  environment.handler(
                    postJson("/api/auth/invitations/accept", { code: inv.code, displayName }),
                    requestContext,
                  ),
                );
                expect(accResp.status).toBe(200);
                const body = (yield* Effect.promise(() => accResp.json())) as {
                  token: string;
                  principal: { id: string; displayName: string };
                };
                return { principalId: body.principal.id, token: body.token };
              });

            const memberA = yield* inviteAndAccept("Member A");
            const memberB = yield* inviteAndAccept("Member B");

            // Owner mints login code for Member A (200) and the code logs Member A in.
            const ownerMintResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/members/${memberA.principalId}/login-code`, {
                  method: "POST",
                  headers: { cookie: ownerCookie },
                }),
                requestContext,
              ),
            );
            expect(ownerMintResp.status).toBe(200);
            expect(ownerMintResp.headers.get("cache-control")).toBe("no-store");
            const ownerMintBody = (yield* Effect.promise(() => ownerMintResp.json())) as {
              code: string;
              expiresAt: string;
            };
            expect(ownerMintBody.code).toBeTruthy();
            expect(ownerMintBody.expiresAt).toBeTruthy();

            const ownerMintedLogin = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/login", { code: ownerMintBody.code }),
                requestContext,
              ),
            );
            expect(ownerMintedLogin.status).toBe(200);
            expect(yield* Effect.promise(() => ownerMintedLogin.json())).toMatchObject({
              authenticated: true,
              principal: { id: memberA.principalId, displayName: "Member A" },
            });

            // Member A (developer, no access:write) mints login code for self (200) and logs in.
            const selfMintResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/members/${memberA.principalId}/login-code`, {
                  method: "POST",
                  headers: { authorization: `Bearer ${memberA.token}` },
                }),
                requestContext,
              ),
            );
            expect(selfMintResp.status).toBe(200);
            const selfMintBody = (yield* Effect.promise(() => selfMintResp.json())) as {
              code: string;
              expiresAt: string;
            };
            expect(selfMintBody.code).toBeTruthy();
            const selfMintedLogin = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/login", { code: selfMintBody.code }),
                requestContext,
              ),
            );
            expect(selfMintedLogin.status).toBe(200);
            expect(yield* Effect.promise(() => selfMintedLogin.json())).toMatchObject({
              authenticated: true,
              principal: { id: memberA.principalId },
            });

            // Member A cannot mint login code for Member B or owner (403).
            const otherMemberResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/members/${memberB.principalId}/login-code`, {
                  method: "POST",
                  headers: { authorization: `Bearer ${memberA.token}` },
                }),
                requestContext,
              ),
            );
            expect(otherMemberResp.status).toBe(403);

            const ownerTargetResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/members/owner/login-code", {
                  method: "POST",
                  headers: { authorization: `Bearer ${memberA.token}` },
                }),
                requestContext,
              ),
            );
            expect(ownerTargetResp.status).toBe(403);

            // Owner minting for a missing principal returns 404 principal_not_found.
            const missingResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/members/does-not-exist/login-code", {
                  method: "POST",
                  headers: { cookie: ownerCookie },
                }),
                requestContext,
              ),
            );
            expect(missingResp.status).toBe(404);
            expect(yield* Effect.promise(() => missingResp.json())).toMatchObject({
              code: "not_found",
              reason: "principal_not_found",
            });

            // Rate limit: once invitesPerHour is reached, minting returns 429.
            yield* capturedLimits!.set({
              principalId: memberA.principalId as never,
              maxSessions: null,
              maxTerminals: null,
              invitesPerHour: 1,
              maxApiTokens: null,
            });
            const rateLimitedResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/members/${memberA.principalId}/login-code`, {
                  method: "POST",
                  headers: { authorization: `Bearer ${memberA.token}` },
                }),
                requestContext,
              ),
            );
            expect(rateLimitedResp.status).toBe(429);
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live(
  "GET /api/audit enforces owner/admin access, filters events, and paginates by id cursor",
  () =>
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      let capturedAudit: AuditEvents.AuditEventRepository["Service"] | undefined;
      const captureLayer = Layer.effectDiscard(
        Effect.gen(function* () {
          capturedAudit = yield* AuditEvents.AuditEventRepository;
        }),
      );
      const multiUserRoutes = makeLayerRoutes({ multiUser: true });
      const testLayer = captureLayer.pipe(
        Layer.provideMerge(multiUserRoutes),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const requestContext = Context.make(SecureRandom.SecureRandom, random);

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(testLayer, { disableLogger: true })),
        (environment) =>
          Effect.gen(function* () {
            // Unauthenticated request returns 401.
            const unauthResp = yield* Effect.promise(() =>
              environment.handler(new Request("http://127.0.0.1/api/audit"), requestContext),
            );
            expect(unauthResp.status).toBe(401);

            const devResponse = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
                requestContext,
              ),
            );
            const ownerCookie =
              devResponse.headers
                .getSetCookie()
                .find((cookie) => cookie.startsWith("t3_dev_session_"))
                ?.split(";", 1)[0] ?? "";

            const projectA = ProjectId.make("audit-proj-a");
            const projectB = ProjectId.make("audit-proj-b");

            const inviteAndAccept = (
              displayName: string,
              role: "admin" | "developer",
              projectId: ProjectId,
            ) =>
              Effect.gen(function* () {
                const invResp = yield* Effect.promise(() =>
                  environment.handler(
                    postJson(
                      "/api/auth/invitations",
                      { kind: "staff", role, projectId },
                      { cookie: ownerCookie },
                    ),
                    requestContext,
                  ),
                );
                expect(invResp.status).toBe(200);
                const inv = (yield* Effect.promise(() => invResp.json())) as { code: string };
                const accResp = yield* Effect.promise(() =>
                  environment.handler(
                    postJson("/api/auth/invitations/accept", { code: inv.code, displayName }),
                    requestContext,
                  ),
                );
                expect(accResp.status).toBe(200);
                const body = (yield* Effect.promise(() => accResp.json())) as {
                  token: string;
                  principal: { id: string };
                };
                return { principalId: body.principal.id, token: body.token };
              });

            const adminA = yield* inviteAndAccept("Admin A", "admin", projectA);
            const devA = yield* inviteAndAccept("Dev A", "developer", projectA);

            // Seed explicit audit events across projectA, projectB, and environment-wide (null).
            const idEnv = yield* capturedAudit!.append({
              at: "2026-11-26T01:00:00.000Z",
              actorPrincipalId: InvitationService.OWNER_PRINCIPAL_ID,
              actorSessionId: null,
              action: "login.succeeded",
              resourceType: "session",
              resourceId: "sess-env",
              projectId: null,
              ip: "10.0.0.1",
              userAgent: "test-agent",
              outcome: "allow",
              metadata: null,
            });
            const idProjA1 = yield* capturedAudit!.append({
              at: "2026-11-26T02:00:00.000Z",
              actorPrincipalId: adminA.principalId as never,
              actorSessionId: null,
              action: "terminal.opened",
              resourceType: "terminal",
              resourceId: "term-a1",
              projectId: projectA,
              ip: "10.0.0.2",
              userAgent: null,
              outcome: "allow",
              metadata: null,
            });
            const idProjB = yield* capturedAudit!.append({
              at: "2026-11-26T03:00:00.000Z",
              actorPrincipalId: InvitationService.OWNER_PRINCIPAL_ID,
              actorSessionId: null,
              action: "secret.read",
              resourceType: "secret",
              resourceId: "sec-b1",
              projectId: projectB,
              ip: "10.0.0.3",
              userAgent: null,
              outcome: "allow",
              metadata: null,
            });
            const idProjA2 = yield* capturedAudit!.append({
              at: "2026-11-26T04:00:00.000Z",
              actorPrincipalId: devA.principalId as never,
              actorSessionId: null,
              action: "authorization.denied",
              resourceType: "project",
              resourceId: projectA,
              projectId: projectA,
              ip: "10.0.0.4",
              userAgent: null,
              outcome: "deny",
              metadata: null,
            });

            // Non-admin member (developer, even with access:read) gets 403.
            const devResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/audit", {
                  headers: { authorization: `Bearer ${devA.token}` },
                }),
                requestContext,
              ),
            );
            expect(devResp.status).toBe(403);

            // Owner sees everything (projectA, projectB, environment-wide).
            const ownerAllResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/audit", {
                  headers: { cookie: ownerCookie },
                }),
                requestContext,
              ),
            );
            expect(ownerAllResp.status).toBe(200);
            const ownerAllBody = (yield* Effect.promise(() => ownerAllResp.json())) as {
              events: Array<{ id: number; projectId: string | null; action: string }>;
              nextCursor: number | null;
            };
            const ownerIds = ownerAllBody.events.map((event) => event.id);
            expect(ownerIds).toContain(idEnv);
            expect(ownerIds).toContain(idProjA1);
            expect(ownerIds).toContain(idProjB);
            expect(ownerIds).toContain(idProjA2);
            expect(ownerAllBody.nextCursor).toBeNull();

            // Admin of projectA sees ONLY projectA events (never projectB or null projectId).
            const adminResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/audit", {
                  headers: { authorization: `Bearer ${adminA.token}` },
                }),
                requestContext,
              ),
            );
            expect(adminResp.status).toBe(200);
            const adminBody = (yield* Effect.promise(() => adminResp.json())) as {
              events: Array<{ id: number; projectId: string | null }>;
              nextCursor: number | null;
            };
            expect(adminBody.events.length).toBeGreaterThanOrEqual(2);
            expect(adminBody.events.every((event) => event.projectId === projectA)).toBe(true);
            expect(adminBody.events.map((event) => event.id)).toContain(idProjA1);
            expect(adminBody.events.map((event) => event.id)).toContain(idProjA2);
            expect(adminBody.events.map((event) => event.id)).not.toContain(idEnv);
            expect(adminBody.events.map((event) => event.id)).not.toContain(idProjB);

            // Admin of projectA asking explicitly for projectB gets 403.
            const adminOtherProjResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(
                  `http://127.0.0.1/api/audit?projectId=${encodeURIComponent(projectB)}`,
                  {
                    headers: { authorization: `Bearer ${adminA.token}` },
                  },
                ),
                requestContext,
              ),
            );
            expect(adminOtherProjResp.status).toBe(403);

            // Filters: action + actorPrincipalId + from/to.
            const filteredResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(
                  `http://127.0.0.1/api/audit?action=authorization.denied&actorPrincipalId=${encodeURIComponent(devA.principalId)}&from=${encodeURIComponent("2026-11-26T03:30:00.000Z")}&to=${encodeURIComponent("2026-11-26T04:30:00.000Z")}`,
                  { headers: { authorization: `Bearer ${adminA.token}` } },
                ),
                requestContext,
              ),
            );
            expect(filteredResp.status).toBe(200);
            const filteredBody = (yield* Effect.promise(() => filteredResp.json())) as {
              events: Array<{ id: number }>;
              nextCursor: number | null;
            };
            expect(filteredBody.events.map((event) => event.id)).toEqual([idProjA2]);
            expect(filteredBody.nextCursor).toBeNull();

            // Invalid timestamp returns 400.
            const badFromResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/audit?from=not-a-timestamp", {
                  headers: { cookie: ownerCookie },
                }),
                requestContext,
              ),
            );
            expect(badFromResp.status).toBe(400);

            // Pagination by cursor & limit walks every event in strictly descending id order.
            const collected: number[] = [];
            let cursor: number | null = null;
            for (let page = 0; page < 20; page++) {
              const url =
                cursor === null
                  ? "http://127.0.0.1/api/audit?limit=2"
                  : `http://127.0.0.1/api/audit?limit=2&cursor=${cursor}`;
              const pageResp = yield* Effect.promise(() =>
                environment.handler(
                  new Request(url, { headers: { cookie: ownerCookie } }),
                  requestContext,
                ),
              );
              expect(pageResp.status).toBe(200);
              const pageBody = (yield* Effect.promise(() => pageResp.json())) as {
                events: Array<{ id: number }>;
                nextCursor: number | null;
              };
              expect(pageBody.events.length).toBeLessThanOrEqual(2);
              for (const event of pageBody.events) {
                collected.push(event.id);
              }
              cursor = pageBody.nextCursor;
              if (cursor === null) break;
            }
            expect(cursor).toBeNull();
            expect(collected).toEqual(ownerIds);
            // Strictly descending, no duplicates.
            for (let i = 1; i < collected.length; i++) {
              expect(collected[i]!).toBeLessThan(collected[i - 1]!);
            }
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "sets passwords, logs in with rate limiting, recovers accounts, and transfers ownership over HTTP",
  () =>
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const requestContext = Context.make(SecureRandom.SecureRandom, random);
      let capturedPrincipals: Principals.PrincipalRepository["Service"] | undefined;
      let capturedSql: import("effect/sql/SqlClient").SqlClient | undefined;
      let capturedAudit: AuditEvents.AuditEventRepository["Service"] | undefined;

      const testLayer = Layer.effectDiscard(
        Effect.gen(function* () {
          capturedPrincipals = yield* Principals.PrincipalRepository;
          capturedSql = yield* (yield* Effect.promise(() => import("effect/sql/SqlClient")))
            .SqlClient;
          capturedAudit = yield* AuditEvents.AuditEventRepository;
        }),
      ).pipe(Layer.provideMerge(makeLayerRoutes({ multiUser: true })));

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(testLayer, { disableLogger: true })),
        (environment) =>
          Effect.gen(function* () {
            // Owner session via dev bootstrap token.
            const ownerBootResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
                requestContext,
              ),
            );
            expect(ownerBootResp.status).toBe(200);
            const ownerCookie = ownerBootResp.headers.get("set-cookie")!.split(";")[0]!;

            // Seed a project so owner transfer rewrites roles on it.
            yield* capturedSql!`
              INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
              VALUES ('proj-transfer-1', 'Transfer Project', '/srv/transfer', '[]', '2026-01-01', '2026-01-01')
            `;

            // Invite Alice into proj-transfer-1 as developer and accept.
            const inviteResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { role: "developer", projectId: "proj-transfer-1" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(inviteResp.status).toBe(200);
            const { code: inviteCode } = (yield* Effect.promise(() => inviteResp.json())) as {
              code: string;
            };
            const acceptResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/accept", {
                  code: inviteCode,
                  displayName: "Alice",
                }),
                requestContext,
              ),
            );
            expect(acceptResp.status).toBe(200);
            const accepted = (yield* Effect.promise(() => acceptResp.json())) as {
              token: string;
              principal: { id: string };
            };
            const aliceId = accepted.principal.id;
            const aliceAuth = { authorization: `Bearer ${accepted.token}` };

            // Give Alice an email so we can test email login too.
            yield* capturedPrincipals!.update({
              id: aliceId as import("@t3tools/contracts").PrincipalId,
              email: "alice@example.com",
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            });

            // Unauthenticated /api/auth/password/set is 401.
            const unauthSetResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/password/set", { password: "long-enough-password" }),
                requestContext,
              ),
            );
            expect(unauthSetResp.status).toBe(401);

            // Short password is 400.
            const shortSetResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/password/set", { password: "tiny" }, aliceAuth),
                requestContext,
              ),
            );
            expect(shortSetResp.status).toBe(400);

            // Alice sets her own password.
            const aliceSetResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/password/set", { password: "alice-password-1234" }, aliceAuth),
                requestContext,
              ),
            );
            expect(aliceSetResp.status).toBe(200);
            expect(yield* Effect.promise(() => aliceSetResp.json())).toEqual({ updated: true });

            // Non-owner cannot set owner's password via /api/auth/members/:id/password.
            const nonOwnerSetResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/members/owner/password",
                  { password: "hijack-password-1234" },
                  aliceAuth,
                ),
                requestContext,
              ),
            );
            expect(nonOwnerSetResp.status).toBe(403);

            // Owner sets Alice's password.
            const ownerSetResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  `/api/auth/members/${aliceId}/password`,
                  { password: "owner-set-password-1234" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(ownerSetResp.status).toBe(200);

            // Unknown principal and wrong password return identical 401 message.
            const unknownLoginResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/login", {
                  email: "ghost@example.com",
                  password: "owner-set-password-1234",
                }),
                requestContext,
              ),
            );
            expect(unknownLoginResp.status).toBe(401);
            const unknownLoginBody = (yield* Effect.promise(() => unknownLoginResp.json())) as {
              message: string;
            };

            const wrongPassResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/login",
                  { email: "alice@example.com", password: "wrong-password-1" },
                  { "x-forwarded-for": "198.51.100.10" },
                ),
                requestContext,
              ),
            );
            expect(wrongPassResp.status).toBe(401);
            const wrongPassBody = (yield* Effect.promise(() => wrongPassResp.json())) as {
              message: string;
            };
            expect(wrongPassBody.message).toBe(unknownLoginBody.message);

            // Login by email returns bearer session with principal binding.
            const loginResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/login",
                  { email: "alice@example.com", password: "owner-set-password-1234" },
                  { "x-forwarded-for": "198.51.100.10" },
                ),
                requestContext,
              ),
            );
            expect(loginResp.status).toBe(200);
            const loginBody = (yield* Effect.promise(() => loginResp.json())) as {
              authenticated: boolean;
              token: string;
              binding_kind: string;
              principal: { id: string };
            };
            expect(loginBody.authenticated).toBe(true);
            expect(loginBody.binding_kind).toBe("principal");
            expect(loginBody.principal.id).toBe(aliceId);

            // 5 failed logins from a single IP trigger 429 on the 6th.
            for (let i = 0; i < 5; i += 1) {
              const failResp = yield* Effect.promise(() =>
                environment.handler(
                  postJson(
                    "/api/auth/login",
                    { email: "alice@example.com", password: `bad-password-${i}` },
                    { "x-forwarded-for": "198.51.100.55" },
                  ),
                  requestContext,
                ),
              );
              expect(failResp.status).toBe(401);
            }
            const rateLimitedResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/login",
                  { email: "alice@example.com", password: "owner-set-password-1234" },
                  { "x-forwarded-for": "198.51.100.55" },
                ),
                requestContext,
              ),
            );
            expect(rateLimitedResp.status).toBe(429);

            // Recovery flow: owner issues code for Alice, confirm sets password & revokes sessions.
            const issueRecoveryResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/recovery", { principalId: aliceId }, { cookie: ownerCookie }),
                requestContext,
              ),
            );
            expect(issueRecoveryResp.status).toBe(200);
            const recoveryIssued = (yield* Effect.promise(() => issueRecoveryResp.json())) as {
              code: string;
              principalId: string;
            };
            expect(recoveryIssued.principalId).toBe(aliceId);

            const confirmRecoveryResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/recovery/confirm", {
                  code: recoveryIssued.code,
                  password: "recovered-password-9999",
                }),
                requestContext,
              ),
            );
            expect(confirmRecoveryResp.status).toBe(200);
            const confirmBody = (yield* Effect.promise(() => confirmRecoveryResp.json())) as {
              recovered: boolean;
              revokedSessions: number;
            };
            expect(confirmBody.recovered).toBe(true);
            expect(confirmBody.revokedSessions).toBeGreaterThanOrEqual(2);

            // Second confirm with the same code is 409 Conflict.
            const replayRecoveryResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/recovery/confirm", {
                  code: recoveryIssued.code,
                  password: "another-password-9999",
                }),
                requestContext,
              ),
            );
            expect(replayRecoveryResp.status).toBe(409);

            // Alice's previous bearer token is now revoked (session endpoint reports unauthenticated).
            const oldSessionResp = yield* Effect.promise(() =>
              environment.handler(
                new Request("http://127.0.0.1/api/auth/session", {
                  headers: { authorization: `Bearer ${loginBody.token}` },
                }),
                requestContext,
              ),
            );
            const oldSessionBody = (yield* Effect.promise(() => oldSessionResp.json())) as {
              authenticated: boolean;
            };
            expect(oldSessionBody.authenticated).toBe(false);

            // Alice logs in with her recovered password via principalId.
            const reloginResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/login", {
                  principalId: aliceId,
                  password: "recovered-password-9999",
                }),
                requestContext,
              ),
            );
            expect(reloginResp.status).toBe(200);
            const reloginBody = (yield* Effect.promise(() => reloginResp.json())) as {
              token: string;
            };

            // Non-owner cannot transfer ownership (403).
            const nonOwnerTransferResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/owner/transfer",
                  { toPrincipalId: aliceId, confirmation: "TRANSFER" },
                  { authorization: `Bearer ${reloginBody.token}` },
                ),
                requestContext,
              ),
            );
            expect(nonOwnerTransferResp.status).toBe(403);

            // Owner transfers ownership to Alice.
            const transferResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/owner/transfer",
                  { toPrincipalId: aliceId, confirmation: "TRANSFER" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(transferResp.status).toBe(200);
            const transferBody = (yield* Effect.promise(() => transferResp.json())) as {
              previousOwner: { id: string; kind: string; status: string };
              newOwner: { id: string; kind: string; status: string };
              adminProjectIds: Array<string>;
            };
            expect(transferBody.previousOwner.id).toBe("owner");
            expect(transferBody.previousOwner.kind).toBe("member");
            expect(transferBody.previousOwner.status).toBe("active");
            expect(transferBody.newOwner.id).toBe(aliceId);
            expect(transferBody.newOwner.kind).toBe("owner");
            expect(transferBody.newOwner.status).toBe("active");
            expect(transferBody.adminProjectIds).toContain("proj-transfer-1");

            const auditRows = yield* capturedAudit!.list({ action: "owner.transferred" });
            expect(auditRows.length).toBe(1);
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live(
  "previews invitations publicly without leaking projectId, auto-enables multiUser, and upserts existing member sessions with wider scopes",
  () =>
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      let capturedSql: SqlClient.SqlClient | undefined;
      let capturedSettings: ServerSettings.ServerSettingsService["Service"] | undefined;
      let capturedPrincipals: Principals.PrincipalRepository["Service"] | undefined;
      let capturedSessions: SessionStore.SessionStore["Service"] | undefined;
      const captureLayer = Layer.effectDiscard(
        Effect.gen(function* () {
          capturedSql = yield* SqlClient.SqlClient;
          capturedSettings = yield* ServerSettings.ServerSettingsService;
          capturedPrincipals = yield* Principals.PrincipalRepository;
          capturedSessions = yield* SessionStore.SessionStore;
        }),
      );
      const testLayer = captureLayer.pipe(
        Layer.provideMerge(makeLayerRoutes({ multiUser: false })),
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

            const projectA = ProjectId.make("proj-alpha");
            const projectB = ProjectId.make("proj-beta");
            const nowIso = DateTime.formatIso(yield* DateTime.now);
            yield* capturedSql!`
              INSERT INTO projection_projects (
                project_id, title, workspace_root, scripts_json, created_at, updated_at
              )
              VALUES
                (${projectA}, 'Alpha Repo', '/tmp/alpha', '[]', ${nowIso}, ${nowIso}),
                (${projectB}, 'Beta Repo', '/tmp/beta', '[]', ${nowIso}, ${nowIso})
            `;

            // multiUser starts off, then auto-enables when the owner creates the first invitation.
            expect((yield* capturedSettings!.getSettings).multiUser).toBe(false);

            // Out-of-bounds expiresInHours is rejected with 400.
            const invalidTtlResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { kind: "staff", role: "viewer", projectId: projectA, expiresInHours: 721 },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(invalidTtlResp.status).toBe(400);
            expect((yield* capturedSettings!.getSettings).multiUser).toBe(false);

            const createViewerResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { kind: "staff", role: "viewer", projectId: projectA, expiresInHours: 24 },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(createViewerResp.status).toBe(200);
            const createdViewer = (yield* Effect.promise(() => createViewerResp.json())) as {
              invitation: { id: string; createdAt: string; expiresAt: string; role: string };
              code: string;
              multiUserEnabled?: boolean;
            };
            expect(createdViewer.multiUserEnabled).toBe(true);
            expect((yield* capturedSettings!.getSettings).multiUser).toBe(true);
            expect(
              Date.parse(createdViewer.invitation.expiresAt) -
                Date.parse(createdViewer.invitation.createdAt),
            ).toBe(24 * 60 * 60 * 1_000);

            // Public GET /api/auth/invitations/preview returns projectTitle, role, expiresAt, and no projectId.
            const previewResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(
                  `http://127.0.0.1/api/auth/invitations/preview?code=${encodeURIComponent(createdViewer.code)}`,
                ),
                requestContext,
              ),
            );
            expect(previewResp.status).toBe(200);
            const previewBody = (yield* Effect.promise(() => previewResp.json())) as Record<
              string,
              unknown
            >;
            expect(previewBody).toEqual({
              valid: true,
              projectTitle: "Alpha Repo",
              role: "viewer",
              expiresAt: createdViewer.invitation.expiresAt,
            });
            expect(previewBody).not.toHaveProperty("projectId");

            // GET /invite/:code renders projectTitle, human role, expiry, and V3 Code branding (never T3 Code).
            const invitePageResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/invite/${encodeURIComponent(createdViewer.code)}`),
                requestContext,
              ),
            );
            expect(invitePageResp.status).toBe(200);
            const inviteHtml = yield* Effect.promise(() => invitePageResp.text());
            expect(inviteHtml).toContain("V3 Code");
            expect(inviteHtml).not.toContain("T3 Code");
            expect(inviteHtml).toContain("Alpha Repo");
            expect(inviteHtml).toContain("Viewer");
            expect(inviteHtml).toContain(createdViewer.invitation.expiresAt);

            // Anonymous visitor accepts the viewer invitation -> receives a viewer principal cookie session.
            const firstAcceptResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/accept", {
                  code: createdViewer.code,
                  displayName: "Ada Member",
                }),
                requestContext,
              ),
            );
            expect(firstAcceptResp.status).toBe(200);
            const firstAcceptBody = (yield* Effect.promise(() => firstAcceptResp.json())) as {
              principal: { id: string; accessRevision: number };
              permissions: Array<string>;
              role: string;
              projectId: string | null;
            };
            expect(firstAcceptBody.role).toBe("viewer");
            expect(firstAcceptBody.projectId).toBe(projectA);
            expect(firstAcceptBody.permissions).toEqual(
              intersectScopes(roleScopes("viewer"), ceilingScopes("staff")),
            );
            const firstCookie = firstAcceptResp.headers
              .getSetCookie()
              .find((cookie) => cookie.startsWith("t3_session_"))!
              .split(";", 1)[0]!;

            // Used invite preview leaks neither projectId nor projectTitle, and HTML page shows reason without form.
            const usedPreviewResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(
                  `http://127.0.0.1/api/auth/invitations/preview?code=${encodeURIComponent(createdViewer.code)}`,
                ),
                requestContext,
              ),
            );
            expect(usedPreviewResp.status).toBe(200);
            expect(yield* Effect.promise(() => usedPreviewResp.json())).toEqual({
              valid: false,
              reason: "used",
              projectTitle: null,
            });
            const usedPageHtml = yield* Effect.promise(() =>
              environment
                .handler(
                  new Request(`http://127.0.0.1/invite/${encodeURIComponent(createdViewer.code)}`),
                  requestContext,
                )
                .then((res) => res.text()),
            );
            expect(usedPageHtml).toContain("Invitation already used");
            expect(usedPageHtml).not.toContain('id="invite-form"');
            expect(usedPageHtml).not.toContain("Alpha Repo");

            // Narrow Ada's ceiling to `client`, then have a Project B admin invite a developer -> 403 fail closed.
            const adminBInviteResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { kind: "staff", role: "admin", projectId: projectB },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            const adminBInvite = (yield* Effect.promise(() => adminBInviteResp.json())) as {
              code: string;
            };
            const adminBAcceptResp = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/invitations/accept", {
                  code: adminBInvite.code,
                  displayName: "Beta Admin",
                }),
                requestContext,
              ),
            );
            const adminBCookie = adminBAcceptResp.headers
              .getSetCookie()
              .find((cookie) => cookie.startsWith("t3_session_"))!
              .split(";", 1)[0]!;

            const patchCeilingResp = yield* Effect.promise(() =>
              environment.handler(
                patchJson(
                  `/api/auth/members/${firstAcceptBody.principal.id}`,
                  { ceiling: "client" },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            expect(patchCeilingResp.status).toBe(200);

            const adminDevInviteResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { kind: "staff", role: "developer", projectId: projectB },
                  { cookie: adminBCookie },
                ),
                requestContext,
              ),
            );
            expect(adminDevInviteResp.status).toBe(200);
            const adminDevInvite = (yield* Effect.promise(() => adminDevInviteResp.json())) as {
              code: string;
            };

            const failClosedResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations/accept",
                  { code: adminDevInvite.code },
                  { cookie: firstCookie },
                ),
                requestContext,
              ),
            );
            expect(failClosedResp.status).toBe(403);

            // Owner invites Ada to Project B as developer while Ada sends her existing cookie -> no new principal,
            // ceiling widened, accessRevision bumped, replacement session cookie carries developer scopes!
            const principalCountBefore = (yield* capturedPrincipals!.list).length;
            const ownerDevInviteResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { kind: "staff", role: "developer", projectId: projectB },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            const ownerDevInvite = (yield* Effect.promise(() => ownerDevInviteResp.json())) as {
              code: string;
            };
            const existingAcceptResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations/accept",
                  { code: ownerDevInvite.code },
                  { cookie: firstCookie },
                ),
                requestContext,
              ),
            );
            expect(existingAcceptResp.status).toBe(200);
            const existingAcceptBody = (yield* Effect.promise(() => existingAcceptResp.json())) as {
              principal: { id: string; accessRevision: number };
              permissions: Array<string>;
              role: string;
              projectId: string | null;
            };
            expect(existingAcceptBody.principal.id).toBe(firstAcceptBody.principal.id);
            expect(existingAcceptBody.principal.accessRevision).toBeGreaterThan(
              firstAcceptBody.principal.accessRevision,
            );
            expect(existingAcceptBody.role).toBe("developer");
            expect(existingAcceptBody.projectId).toBe(projectB);
            expect(existingAcceptBody.permissions).toEqual(
              expect.arrayContaining([...roleScopes("developer")]),
            );
            expect((yield* capturedPrincipals!.list).length).toBe(principalCountBefore);

            const reissuedCookie = existingAcceptResp.headers
              .getSetCookie()
              .find((cookie) => cookie.startsWith("t3_session_"))!
              .split(";", 1)[0]!;
            const reissuedToken = reissuedCookie.slice(reissuedCookie.indexOf("=") + 1);
            const verifiedReissued = yield* capturedSessions!.verify(reissuedToken);
            expect(verifiedReissued.principalId).toBe(firstAcceptBody.principal.id);
            expect(verifiedReissued.scopes).toEqual(
              expect.arrayContaining([...roleScopes("developer")]),
            );

            // GET /api/auth/invitations and DELETE /api/auth/invitations/:id require owner or
            // project admin of the invitation's project.
            const projectAInviteResp = yield* Effect.promise(() =>
              environment.handler(
                postJson(
                  "/api/auth/invitations",
                  { kind: "staff", role: "viewer", projectId: projectA },
                  { cookie: ownerCookie },
                ),
                requestContext,
              ),
            );
            const projectAInvite = (yield* Effect.promise(() => projectAInviteResp.json())) as {
              invitation: { id: string };
            };
            const devListResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/invitations?projectId=${projectB}`, {
                  headers: { cookie: reissuedCookie },
                }),
                requestContext,
              ),
            );
            expect(devListResp.status).toBe(403);
            const adminBListAResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/invitations?projectId=${projectA}`, {
                  headers: { cookie: adminBCookie },
                }),
                requestContext,
              ),
            );
            expect(adminBListAResp.status).toBe(403);
            const adminBListBResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(`http://127.0.0.1/api/auth/invitations?projectId=${projectB}`, {
                  headers: { cookie: adminBCookie },
                }),
                requestContext,
              ),
            );
            expect(adminBListBResp.status).toBe(200);
            const adminBRevokeAResp = yield* Effect.promise(() =>
              environment.handler(
                new Request(
                  `http://127.0.0.1/api/auth/invitations/${projectAInvite.invitation.id}`,
                  {
                    method: "DELETE",
                    headers: { cookie: adminBCookie },
                  },
                ),
                requestContext,
              ),
            );
            expect(adminBRevokeAResp.status).toBe(403);
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
