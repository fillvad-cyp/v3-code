import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthSessionId,
  EnvironmentId,
  InvitationId,
  PrincipalId,
  ProjectId,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type Invitation,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyAuthAccessStreamEvent,
  createAuthEnvironmentAtoms,
  EMPTY_AUTH_ACCESS_SNAPSHOT,
} from "./auth.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

describe("applyAuthAccessStreamEvent", () => {
  it("accumulates rapid pairing-link and client updates into one snapshot", () => {
    const pairingLink = {
      id: "pairing-link",
      scopes: ["orchestration:read"],
      subject: "subject",
      label: "Phone",
      createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
    } as const;
    const clientSession = {
      sessionId: AuthSessionId.make("session-client"),
      subject: "subject",
      scopes: ["orchestration:read"],
      method: "browser-session-cookie",
      client: {
        label: "Phone",
        deviceType: "mobile",
      },
      issuedAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-05-07T00:00:00.000Z"),
      lastConnectedAt: null,
      connected: true,
      current: false,
    } as const;

    const withPairingLink = applyAuthAccessStreamEvent(EMPTY_AUTH_ACCESS_SNAPSHOT, {
      version: 1,
      revision: 1,
      type: "pairingLinkUpserted",
      payload: pairingLink,
    });
    const withClient = applyAuthAccessStreamEvent(withPairingLink, {
      version: 1,
      revision: 2,
      type: "clientUpserted",
      payload: clientSession,
    });

    expect(withClient).toEqual({
      pairingLinks: [pairingLink],
      clientSessions: [clientSession],
    });
  });

  it("applies removals without disturbing unrelated access state", () => {
    const snapshot = applyAuthAccessStreamEvent(
      {
        pairingLinks: [
          {
            id: "pairing-link",
            scopes: ["orchestration:read"],
            subject: "subject",
            label: "Phone",
            createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
          },
        ],
        clientSessions: [],
      },
      {
        version: 1,
        revision: 2,
        type: "pairingLinkRemoved",
        payload: { id: "pairing-link" },
      },
    );

    expect(snapshot).toEqual(EMPTY_AUTH_ACCESS_SNAPSHOT);
  });
});

describe("invitation atoms", () => {
  const TARGET = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("environment-inv"),
    label: "Test environment",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  });
  const PREPARED: PreparedConnection = {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    httpBaseUrl: "https://environment.example.test",
    socketUrl: "wss://environment.example.test/ws",
    httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
    target: TARGET,
  };
  const PROJECT_ID = ProjectId.make("project-1");
  const INVITATION: Invitation = {
    id: InvitationId.make("inv-1"),
    email: null,
    kind: "staff",
    role: "developer",
    projectId: PROJECT_ID,
    principalId: null,
    ceiling: [],
    createdBy: PrincipalId.make("owner"),
    createdAt: "2026-11-28T00:00:00.000Z",
    expiresAt: "2026-12-05T00:00:00.000Z",
    acceptedAt: null,
    revokedAt: null,
  };

  const makeAuthHarness = Effect.fn("AuthInvitations.makeHarness")(function* (input: {
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly onRequest: (url: URL, method: string) => Response;
  }) {
    const rpcSession = { closed: Effect.never } as unknown as RpcSession;
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
      }),
      session: yield* SubscriptionRef.make(Option.some(rpcSession)),
      prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
      _environmentId,
      stream,
    ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
      _environmentId,
      effect,
    ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    const runtime = Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(
          EnvironmentRegistry.EnvironmentRegistry,
          EnvironmentRegistry.EnvironmentRegistry.of({
            followStream,
            run,
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        ),
        RpcHttp.layerRemoteHttpClient(async (requestInput, init) => {
          const rawUrl =
            typeof requestInput === "string"
              ? requestInput
              : requestInput instanceof URL
                ? requestInput.toString()
                : requestInput.url;
          const url = new URL(rawUrl);
          const method =
            init?.method ??
            (typeof requestInput !== "string" && !(requestInput instanceof URL)
              ? requestInput.method
              : "GET");
          if (url.pathname === "/api/auth/session") {
            return Response.json({
              authenticated: true,
              auth: {
                policy: "remote-reachable",
                bootstrapMethods: [],
                sessionMethods: ["bearer-access-token"],
                sessionCookieName: "t3_session",
              },
              scopes: input.scopes,
              permissions: input.scopes,
              sessionMethod: "bearer-access-token",
            } satisfies AuthSessionState);
          }
          return input.onRequest(url, method);
        }),
        Layer.succeed(Clock.Clock, yield* Clock.Clock),
      ),
    );
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (reg) =>
      Effect.sync(() => reg.dispose()),
    );
    const authAtoms = createAuthEnvironmentAtoms(runtime);
    const sessionAtoms = createEnvironmentSessionAtoms(runtime);
    return { registry, authAtoms, sessionAtoms };
  });

  it.effect(
    "lists invitations with optional projectId filter, revokes by id, and gates by access:write",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ readonly method: string; readonly pathWithSearch: string }> = [];
        const harness = yield* makeAuthHarness({
          scopes: [AuthAccessReadScope, AuthAccessWriteScope],
          onRequest: (url, method) => {
            requests.push({ method, pathWithSearch: `${url.pathname}${url.search}` });
            if (method === "GET" && url.pathname === "/api/auth/invitations") {
              return Response.json([INVITATION]);
            }
            if (method === "DELETE" && url.pathname === `/api/auth/invitations/${INVITATION.id}`) {
              return Response.json({ revoked: true });
            }
            return new Response(null, { status: 404 });
          },
        });

        const readAtomSettled = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<AsyncResult.AsyncResult<A, E>>();
            const unsub = harness.registry.subscribe(
              atom,
              (value) => Queue.offerUnsafe(queue, value),
              {
                immediate: true,
              },
            );
            yield* Effect.addFinalizer(() => Effect.sync(unsub));
            for (;;) {
              const next = yield* Queue.take(queue);
              if (!next.waiting && next._tag !== "Initial") return next;
            }
          });

        const sessionResult = yield* readAtomSettled(
          harness.sessionAtoms.sessionStateAtom(TARGET.environmentId),
        );
        expect(sessionResult._tag).toBe("Success");
        expect(
          harness.registry.get(
            harness.authAtoms.listInvitations.permissionAtom(TARGET.environmentId),
          ),
        ).toBe(true);
        expect(
          harness.registry.get(
            harness.authAtoms.revokeInvitation.permissionAtom(TARGET.environmentId),
          ),
        ).toBe(true);

        const allResult = yield* readAtomSettled(
          harness.authAtoms.listInvitations({ environmentId: TARGET.environmentId, input: null }),
        );
        expect(allResult).toMatchObject({ _tag: "Success", value: [INVITATION] });

        const projectResult = yield* readAtomSettled(
          harness.authAtoms.listInvitations({
            environmentId: TARGET.environmentId,
            input: { projectId: PROJECT_ID },
          }),
        );
        expect(projectResult).toMatchObject({ _tag: "Success", value: [INVITATION] });

        const revokeResult = yield* harness.authAtoms.revokeInvitation.run(harness.registry, {
          environmentId: TARGET.environmentId,
          input: { id: INVITATION.id },
        });
        expect(revokeResult).toEqual({ revoked: true });

        expect(requests).toEqual([
          { method: "GET", pathWithSearch: "/api/auth/invitations" },
          { method: "GET", pathWithSearch: `/api/auth/invitations?projectId=${PROJECT_ID}` },
          { method: "DELETE", pathWithSearch: `/api/auth/invitations/${INVITATION.id}` },
        ]);
      }),
  );

  it.effect("denies invitation list/revoke permissionAtom without access:write", () =>
    Effect.gen(function* () {
      const harness = yield* makeAuthHarness({
        scopes: [AuthAccessReadScope],
        onRequest: () => new Response(null, { status: 404 }),
      });

      const queue = yield* Queue.unbounded<AsyncResult.AsyncResult<AuthSessionState, unknown>>();
      const unsub = harness.registry.subscribe(
        harness.sessionAtoms.sessionStateAtom(TARGET.environmentId),
        (value) => Queue.offerUnsafe(queue, value),
        { immediate: true },
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsub));
      for (;;) {
        const next = yield* Queue.take(queue);
        if (!next.waiting && next._tag !== "Initial") break;
      }

      expect(
        harness.registry.get(
          harness.authAtoms.listInvitations.permissionAtom(TARGET.environmentId),
        ),
      ).toBe(false);
      expect(
        harness.registry.get(
          harness.authAtoms.revokeInvitation.permissionAtom(TARGET.environmentId),
        ),
      ).toBe(false);
    }),
  );
});
