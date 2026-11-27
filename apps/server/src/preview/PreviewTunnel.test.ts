import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  DEFAULT_SERVER_SETTINGS,
  PrincipalId,
  ProjectId,
  type ManagedPolicySummary,
  type ProjectRole,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ProjectIsolation from "../isolation/ProjectIsolation.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as PreviewTunnel from "./PreviewTunnel.ts";
import * as Option from "effect/Option";

const listen = (onConnection: (socket: NodeNet.Socket) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: NodeNet.Server; sockets: Set<NodeNet.Socket> }>((resolve) => {
          const sockets = new Set<NodeNet.Socket>();
          const server = NodeNet.createServer((socket) => {
            sockets.add(socket);
            onConnection(socket);
          });
          server.listen(0, "127.0.0.1", () => resolve({ server, sockets }));
        }),
    ),
    ({ server, sockets }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
          }),
      ),
  ).pipe(Effect.map(({ server }) => ({ port: (server.address() as NodeNet.AddressInfo).port })));

/** Settings the route reads; `set` publishes a change as the real service does. */
const makeSettings = Effect.fn(function* (
  enablePreviewTunnel = true,
  managedPolicy?: ManagedPolicySummary,
  /** Applied right after the first read, as a change landing while a tunnel dials. */
  afterFirstRead?: Partial<ServerSettings>,
) {
  const current = yield* Ref.make<ServerSettings>({
    ...DEFAULT_SERVER_SETTINGS,
    enablePreviewTunnel,
  });
  const changes = yield* PubSub.unbounded<ServerSettings>();
  const set = (patch: Partial<ServerSettings>) =>
    Ref.updateAndGet(current, (settings) => ({ ...settings, ...patch })).pipe(
      Effect.flatMap((settings) => PubSub.publish(changes, settings)),
    );
  let pendingChange = afterFirstRead;
  return {
    set,
    layer: Layer.mock(ServerSettingsService, {
      managedPolicy,
      getSettings: Ref.get(current).pipe(
        Effect.tap(() => {
          const change = pendingChange;
          pendingChange = undefined;
          return change ? set(change) : Effect.void;
        }),
      ),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    }),
  };
});

const PREVIEW_PROJECT_ID = ProjectId.make("project-preview");
const OTHER_PROJECT_ID = ProjectId.make("project-other");
const OPERATOR_PRINCIPAL_ID = PrincipalId.make("principal-operator");
const VIEWER_PRINCIPAL_ID = PrincipalId.make("principal-viewer");
const NOW = "2026-11-25T00:00:00.000Z";

const makeProjectAccessLayer = () => {
  const principals = new Map([
    [
      OPERATOR_PRINCIPAL_ID,
      {
        id: OPERATOR_PRINCIPAL_ID,
        kind: "member" as const,
        displayName: "Operator",
        email: null,
        status: "active" as const,
        ceiling: [AuthOrchestrationReadScope, AuthTerminalOperateScope],
        accessRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
        removedAt: null,
      },
    ],
    [
      VIEWER_PRINCIPAL_ID,
      {
        id: VIEWER_PRINCIPAL_ID,
        kind: "member" as const,
        displayName: "Viewer",
        email: null,
        status: "active" as const,
        ceiling: [AuthOrchestrationReadScope, AuthTerminalOperateScope],
        accessRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
        removedAt: null,
      },
    ],
  ]);
  const memberships: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly principalId: PrincipalId;
    readonly role: ProjectRole;
    readonly state: "active";
    readonly invitedBy: null;
    readonly expiresAt: null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }> = [
    {
      projectId: PREVIEW_PROJECT_ID,
      principalId: OPERATOR_PRINCIPAL_ID,
      role: "operator",
      state: "active",
      invitedBy: null,
      expiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      projectId: PREVIEW_PROJECT_ID,
      principalId: VIEWER_PRINCIPAL_ID,
      role: "viewer",
      state: "active",
      invitedBy: null,
      expiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  return ProjectAccess.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Principals.PrincipalRepository, {
          get: (id) => Effect.succeed(Option.fromNullishOr(principals.get(id))),
          getAccessStatus: (id) => {
            const principal = principals.get(id);
            return Effect.succeed(
              principal === undefined
                ? Option.none()
                : Option.some({
                    status: principal.status,
                    accessRevision: principal.accessRevision,
                  }),
            );
          },
          getByEmail: () => Effect.die("unused"),
          getOwner: Effect.die("unused"),
          countOwners: Effect.die("unused"),
          list: Effect.succeed([...principals.values()]),
          create: () => Effect.die("unused"),
          update: () => Effect.die("unused"),
          bumpAccessRevision: () => Effect.die("unused"),
          getEnvironmentAccessRevision: Effect.succeed(0),
          streamEnvironmentAccessRevision: Stream.empty,
          getCredential: () => Effect.die("unused"),
          setCredential: () => Effect.die("unused"),
          deleteCredential: () => Effect.die("unused"),
        }),
        Layer.succeed(Memberships.MembershipRepository, {
          get: () => Effect.die("unused"),
          listForProject: () => Effect.die("unused"),
          listForPrincipal: (principalId) =>
            Effect.succeed(memberships.filter((entry) => entry.principalId === principalId)),
          upsert: () => Effect.die("unused"),
          setRole: () => Effect.die("unused"),
          setState: () => Effect.die("unused"),
          delete: () => Effect.die("unused"),
        }),
        Layer.succeed(ProjectStore.ProjectStoreV2, {
          apply: () => Effect.die("unused"),
          get: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
          findActiveByWorkspaceRoot: () => Effect.die("unused"),
          getShell: () => Effect.die("unused"),
          listShells: () => Effect.die("unused"),
          setOwnership: () => Effect.die("unused"),
          listOwnedByPrincipal: () => Effect.succeed([]),
        }),
      ),
    ),
  );
};

/** Serves the tunnel route; `wsTicket=reader` authenticates without terminal:operate. */
const serveTunnel = (
  sessionInvalidated: Effect.Effect<void> = Effect.never,
  settings?: Layer.Layer<ServerSettingsService>,
  isolation?: Layer.Layer<ProjectIsolation.ProjectIsolation>,
) =>
  Effect.gen(function* () {
    const settingsLayer = settings ?? (yield* makeSettings()).layer;
    const baseLayer = HttpRouter.serve(PreviewTunnel.routeLayer, { disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(PreviewTunnel.layer.pipe(Layer.provide(settingsLayer))),
      Layer.provide(makeProjectAccessLayer()),
      Layer.provide(
        Layer.mock(SessionStore.SessionStore, {
          cookieName: "t3_session",
          legacyCookieName: undefined,
          awaitInvalidation: () => sessionInvalidated,
        }),
      ),
      Layer.provide(
        Layer.mock(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: (request) => {
            const principalId = request.url.includes("wsTicket=member-operator")
              ? OPERATOR_PRINCIPAL_ID
              : request.url.includes("wsTicket=member-viewer")
                ? VIEWER_PRINCIPAL_ID
                : undefined;
            return Effect.succeed({
              sessionId: AuthSessionId.make("tunnel-test"),
              subject: "tunnel-test",
              method: "bearer-access-token",
              scopes: request.url.includes("wsTicket=reader")
                ? [AuthOrchestrationReadScope]
                : [AuthOrchestrationReadScope, AuthTerminalOperateScope],
              ...(principalId === undefined
                ? {}
                : { principalId, binding: { _tag: "principal" as const } }),
            });
          },
        }),
      ),
    );
    const services = yield* Layer.build(
      isolation === undefined ? baseLayer : baseLayer.pipe(Layer.provide(isolation)),
    );
    const origin = new URL(
      HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address),
    );
    return { origin: `ws://${origin.host}`, port: Number(origin.port) };
  });

const openTunnel = (url: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocket(url)),
    (socket) => Effect.sync(() => socket.terminate()),
  );

/** How the route turned down a tunnel: its status, and whether it marked the port as the reason. */
const refusal = (client: NodeWS.WebSocket) =>
  Effect.promise(
    () =>
      new Promise<{ status: number | undefined; portRefused: boolean }>((resolve, reject) => {
        client.on("unexpected-response", (_request, response) =>
          resolve({
            status: response.statusCode,
            portRefused:
              response.headers[PreviewTunnel.PREVIEW_TUNNEL_PORT_REFUSED_HEADER] !== undefined,
          }),
        );
        client.on("open", () => reject(new Error("tunnel opened")));
        client.on("error", reject);
      }),
  );

it.effect("pipes bytes both ways between the WebSocket and the loopback port", () =>
  Effect.gen(function* () {
    const upstreamReceived: number[] = [];
    const upstream = yield* listen((socket) => {
      socket.write(Uint8Array.of(0x10, 0x11));
      socket.on("data", (chunk) => {
        upstreamReceived.push(...chunk);
        socket.write(Buffer.concat([Uint8Array.of(0xee), chunk]));
      });
    });
    const tunnel = yield* serveTunnel();
    const client = yield* openTunnel(`${tunnel.origin}/api/preview/tunnel?port=${upstream.port}`);
    const clientReceived: number[] = [];
    const done = Promise.withResolvers<void>();
    client.on("error", done.reject);
    client.on("message", (data: Buffer) => {
      clientReceived.push(...data);
      if (clientReceived.length === 2) client.send(Uint8Array.of(0x01, 0x02, 0x03));
      if (clientReceived.length === 6) done.resolve();
    });
    yield* Effect.promise(() => done.promise);
    expect(upstreamReceived).toEqual([0x01, 0x02, 0x03]);
    expect(clientReceived).toEqual([0x10, 0x11, 0xee, 0x01, 0x02, 0x03]);
  }),
);

it.effect.each([
  { case: "the server's own port", target: "self", ticket: "operator", portRefused: true },
  {
    case: "a session without terminal:operate",
    target: "listed",
    ticket: "reader",
    portRefused: false,
  },
] as const)("refuses $case with 403 before dialling", ({ target, ticket, portRefused }) =>
  Effect.gen(function* () {
    let dialled = 0;
    const countDial = (socket: NodeNet.Socket) => {
      dialled++;
      socket.destroy();
    };
    const listed = yield* listen(countDial);
    const tunnel = yield* serveTunnel();
    const port = { listed: listed.port, self: tunnel.port }[target];
    const client = yield* openTunnel(
      `${tunnel.origin}/api/preview/tunnel?port=${port}&wsTicket=${ticket}`,
    );
    const response = yield* refusal(client);
    expect(response).toEqual({ status: 403, portRefused });
    expect(dialled).toBe(0);
  }),
);

it.effect("answers a port nothing listens on with 403, marked as about the port", () =>
  Effect.gen(function* () {
    const closed = yield* Effect.promise(
      () =>
        new Promise<number>((resolve) => {
          const server = NodeNet.createServer();
          server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as NodeNet.AddressInfo;
            server.close(() => resolve(port));
          });
        }),
    );
    const tunnel = yield* serveTunnel();
    const client = yield* openTunnel(`${tunnel.origin}/api/preview/tunnel?port=${closed}`);
    const response = yield* refusal(client);
    expect(response).toEqual({ status: 403, portRefused: true });
  }),
);

it.effect("closes an open tunnel when its session is revoked", () =>
  Effect.gen(function* () {
    const upstreamClosed = Promise.withResolvers<void>();
    const upstream = yield* listen((socket) => socket.on("close", () => upstreamClosed.resolve()));
    const revoked = yield* Deferred.make<void>();
    const tunnel = yield* serveTunnel(Deferred.await(revoked));
    const client = yield* openTunnel(`${tunnel.origin}/api/preview/tunnel?port=${upstream.port}`);
    yield* Effect.promise(() => new Promise((resolve) => client.once("open", resolve)));
    const clientClosed = new Promise((resolve) => client.once("close", resolve));
    yield* Deferred.succeed(revoked, undefined);
    yield* Effect.promise(() => Promise.all([clientClosed, upstreamClosed.promise]));
  }),
);

it.effect.each([
  { case: "the setting", enabled: false, policy: undefined },
  {
    case: "a policy, whatever the setting",
    enabled: true,
    policy: {
      organization: "Example Corp",
      lockedSettings: [],
      limits: { previewTunnel: false },
    } satisfies ManagedPolicySummary,
  },
])("refuses every tunnel with 403 when $case turns it off", ({ enabled, policy }) =>
  Effect.gen(function* () {
    let dialled = 0;
    const listed = yield* listen((socket) => {
      dialled++;
      socket.destroy();
    });
    const settings = yield* makeSettings(enabled, policy);
    const tunnel = yield* serveTunnel(Effect.never, settings.layer);
    const client = yield* openTunnel(`${tunnel.origin}/api/preview/tunnel?port=${listed.port}`);
    const status = yield* Effect.promise(
      () =>
        new Promise<{ status: number | undefined; disabled: boolean }>((resolve, reject) => {
          client.on("unexpected-response", (_request, response) =>
            resolve({
              status: response.statusCode,
              disabled:
                response.headers[PreviewTunnel.PREVIEW_TUNNEL_DISABLED_HEADER] !== undefined,
            }),
          );
          client.on("open", () => reject(new Error("tunnel opened")));
          client.on("error", reject);
        }),
    );
    expect(status).toEqual({ status: 403, disabled: true });
    expect(dialled).toBe(0);
  }),
);

it.effect("closes an open tunnel when the setting turns it off", () =>
  Effect.gen(function* () {
    const upstreamClosed = Promise.withResolvers<void>();
    const upstream = yield* listen((socket) => socket.on("close", () => upstreamClosed.resolve()));
    const settings = yield* makeSettings();
    const tunnel = yield* serveTunnel(Effect.never, settings.layer);
    const client = yield* openTunnel(`${tunnel.origin}/api/preview/tunnel?port=${upstream.port}`);
    yield* Effect.promise(() => new Promise((resolve) => client.once("open", resolve)));
    const clientClosed = new Promise((resolve) => client.once("close", resolve));
    yield* settings.set({ enablePreviewTunnel: false });
    yield* Effect.promise(() => Promise.all([clientClosed, upstreamClosed.promise]));
  }),
);

it.effect("closes a tunnel the setting turns off while it is still dialling", () =>
  Effect.gen(function* () {
    const settings = yield* makeSettings(true, undefined, { enablePreviewTunnel: false });
    const upstreamClosed = Promise.withResolvers<void>();
    const upstream = yield* listen((socket) => socket.on("close", () => upstreamClosed.resolve()));
    const tunnel = yield* serveTunnel(Effect.never, settings.layer);
    const client = yield* openTunnel(`${tunnel.origin}/api/preview/tunnel?port=${upstream.port}`);
    const clientClosed = new Promise((resolve) => client.once("close", resolve));
    yield* Effect.promise(() => Promise.all([clientClosed, upstreamClosed.promise]));
  }),
);

it.effect("allows a member with project:preview.operate to open a tunnel for their project", () =>
  Effect.gen(function* () {
    const upstream = yield* listen((socket) => {
      socket.write(Uint8Array.of(0x42));
    });
    const tunnel = yield* serveTunnel();
    const client = yield* openTunnel(
      `${tunnel.origin}/api/preview/tunnel?port=${upstream.port}&projectId=${PREVIEW_PROJECT_ID}&wsTicket=member-operator`,
    );
    const received = yield* Effect.promise(
      () =>
        new Promise<number[]>((resolve, reject) => {
          client.on("error", reject);
          client.on("message", (data: Buffer) => resolve([...data]));
        }),
    );
    expect(received).toEqual([0x42]);
  }),
);

it.effect.each([
  {
    case: "a viewer lacking project:preview.operate on the project",
    ticket: "member-viewer",
    projectId: PREVIEW_PROJECT_ID,
  },
  {
    case: "an operator requesting a foreign project",
    ticket: "member-operator",
    projectId: OTHER_PROJECT_ID,
  },
] as const)("refuses preview tunnel with 403 before dialling for $case", ({ ticket, projectId }) =>
  Effect.gen(function* () {
    let dialled = 0;
    const upstream = yield* listen((socket) => {
      dialled++;
      socket.destroy();
    });
    const tunnel = yield* serveTunnel();
    const client = yield* openTunnel(
      `${tunnel.origin}/api/preview/tunnel?port=${upstream.port}&projectId=${projectId}&wsTicket=${ticket}`,
    );
    const response = yield* refusal(client);
    expect(response).toEqual({ status: 403, portRefused: false });
    expect(dialled).toBe(0);
  }),
);

it.effect("enforces allocated project_isolation port ranges for L1 isolated projects", () =>
  Effect.gen(function* () {
    const allowedUpstream = yield* listen((socket) => {
      socket.write(Uint8Array.of(0x77));
    });
    let refusedDialled = 0;
    const refusedUpstream = yield* listen((socket) => {
      refusedDialled++;
      socket.destroy();
    });

    const isolationLayer = Layer.mock(ProjectIsolation.ProjectIsolation, {
      isPortAllowedForProject: (projectId, port) =>
        Effect.succeed(
          projectId === PREVIEW_PROJECT_ID
            ? {
                allowed: port === allowedUpstream.port,
                level: 1 as const,
                portsFrom: allowedUpstream.port,
                portsTo: allowedUpstream.port,
              }
            : { allowed: true, level: 0 as const, portsFrom: null, portsTo: null },
        ),
      findByPort: () => Effect.succeedNone,
    });

    const tunnel = yield* serveTunnel(Effect.never, undefined, isolationLayer);

    const allowedClient = yield* openTunnel(
      `${tunnel.origin}/api/preview/tunnel?port=${allowedUpstream.port}&projectId=${PREVIEW_PROJECT_ID}&wsTicket=member-operator`,
    );
    const received = yield* Effect.promise(
      () =>
        new Promise<number[]>((resolve, reject) => {
          allowedClient.on("error", reject);
          allowedClient.on("message", (data: Buffer) => resolve([...data]));
        }),
    );
    expect(received).toEqual([0x77]);

    const deniedClient = yield* openTunnel(
      `${tunnel.origin}/api/preview/tunnel?port=${refusedUpstream.port}&projectId=${PREVIEW_PROJECT_ID}&wsTicket=member-operator`,
    );
    const denied = yield* refusal(deniedClient);
    expect(denied).toEqual({ status: 403, portRefused: true });
    expect(refusedDialled).toBe(0);
  }),
);
