import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessReadScope,
  AuthStandardClientScopes,
  EnvironmentHttpCommonError,
  InvitationCreateResult,
  MemberLoginCodeResult,
  MemberWithMemberships,
  ORCHESTRATION_PROTOCOL_VERSION,
  PrincipalId,
  ProjectId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClientError } from "effect/http";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as InvitationService from "../identity/InvitationService.ts";
import * as MembershipService from "../identity/MembershipService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as RunningServer from "./runningServer.ts";

const INVITABLE_ROLES = ["viewer", "operator", "developer", "manager", "admin"] as const;
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const encodeInvitationCreateResult = Schema.encodeEffect(
  Schema.fromJsonString(InvitationCreateResult),
);
const encodeMemberLoginCodeResult = Schema.encodeEffect(
  Schema.fromJsonString(MemberLoginCodeResult),
);
const MembersMultiUserResult = Schema.Struct({
  multiUser: Schema.Boolean,
  authMode: Schema.Literals(["single-owner", "multi-user"]),
});
const encodeMembersMultiUserResult = Schema.encodeEffect(
  Schema.fromJsonString(MembersMultiUserResult),
);
const encodeMembersList = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(MemberWithMemberships)),
);

export class MembersLiveServerResponseError extends Schema.TaggedError<MembersLiveServerResponseError>()(
  "MembersLiveServerResponseError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

function membersErrorFromServerAnswer<E>(cause: E) {
  if (isEnvironmentHttpCommonError(cause)) {
    return new MembersLiveServerResponseError({
      detail: `Server request failed (${cause.code}, trace ${cause.traceId}).`,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new MembersLiveServerResponseError({
      detail: `Server request failed with status ${cause.response.status}.`,
      cause,
    });
  }
  return cause;
}

const makeLocalMembersLayer = () => {
  const repos = Layer.mergeAll(
    Principals.layer,
    Memberships.layer,
    Invitations.layer,
    AuditEvents.layer,
    ApiTokens.layer,
    MemberLimits.layer,
    SessionPrincipals.layer,
  );
  const access = ProjectAccess.layer.pipe(Layer.provide(repos), Layer.provide(ProjectStore.layer));
  const membershipService = MembershipService.layer.pipe(
    Layer.provide(access),
    Layer.provide(repos),
  );
  const invitationService = InvitationService.layer.pipe(
    Layer.provide(membershipService),
    Layer.provide(access),
    Layer.provide(repos),
    Layer.provide(ServerSecretStore.layer),
  );
  return Layer.mergeAll(invitationService, membershipService, repos).pipe(
    // Built after acquireServerOwnership; layerCliConfig would contend with this process's own lock.
    Layer.provide(SqlitePersistence.layerConfig),
  );
};

const makeLocalSettingsLayer = () =>
  ServerSettings.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layer),
    // Built after acquireServerOwnership; layerCliConfig would contend with this process's own lock.
    Layer.provide(SqlitePersistence.layerConfig),
  );

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const principalFlag = Flag.String("principal").pipe(
  Flag.withSchema(PrincipalId),
  Flag.withDescription(
    "Principal id to issue a login code for. Defaults to the current session's principal.",
  ),
  Flag.optional,
);

const projectFlag = Flag.String("project").pipe(
  Flag.withSchema(ProjectId),
  Flag.withDescription(
    "Project id to invite the member to. Omit for an environment-wide invitation.",
  ),
  Flag.optional,
);

const roleFlag = Flag.Literals("role", INVITABLE_ROLES).pipe(
  Flag.withDescription("Role to grant (viewer, operator, developer, manager, admin)."),
  Flag.withDefault("developer" as const),
);

function formatMembersList(members: ReadonlyArray<MemberWithMemberships>): string {
  if (members.length === 0) {
    return "No members found.";
  }
  const lines: Array<string> = [];
  for (const { principal, memberships } of members) {
    lines.push(
      `${principal.id}  ${principal.displayName} (${principal.kind}, ${principal.status})`,
    );
    for (const membership of memberships) {
      lines.push(`  - project ${membership.projectId}: ${membership.role} (${membership.state})`);
    }
  }
  return lines.join("\n");
}

const runMembersCommand = Effect.fn("cli.members")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (config: ServerConfig.ServerConfig["Service"]) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* run(config).pipe(
    Effect.scoped,
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

const membersInviteCommand = Command.make("invite", {
  ...projectLocationFlags,
  project: projectFlag,
  role: roleFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a one-time invitation code for a new member."),
  Command.withHandler((flags) =>
    runMembersCommand(flags, (config) =>
      Effect.gen(function* () {
        const projectId = Option.getOrNull(flags.project);
        const result = yield* RunningServer.changeState({
          scopes: AuthStandardClientScopes,
          viaServer: Effect.fn("members.invite.viaServer")(
            (client) =>
              client.auth.createInvitation({
                headers: {},
                payload: {
                  kind: "staff",
                  role: flags.role,
                  projectId,
                },
              }),
            Effect.mapError(membersErrorFromServerAnswer),
          ),
          locally: Effect.gen(function* () {
            const service = yield* InvitationService.InvitationService;
            return yield* service.issue({
              kind: "staff",
              role: flags.role,
              projectId,
              createdBy: InvitationService.OWNER_PRINCIPAL_ID,
            });
          }).pipe(
            Effect.provide(
              makeLocalMembersLayer().pipe(
                Layer.provide(ServerConfig.layer(config)),
                Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
              ),
            ),
          ),
        });

        if (flags.json) {
          yield* Console.log(yield* encodeInvitationCreateResult(result));
          return;
        }
        yield* Console.log(
          [
            `Invitation code: ${result.code}`,
            `Role: ${result.invitation.role}`,
            `Project: ${result.invitation.projectId ?? "(environment)"}`,
            `Expires: ${result.invitation.expiresAt}`,
            `Accept URL path: /invite/${result.code}`,
          ].join("\n"),
        );
      }),
    ),
  ),
);

const membersListCommand = Command.make("list", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List principals and their project memberships."),
  Command.withHandler((flags) =>
    runMembersCommand(flags, (config) =>
      Effect.gen(function* () {
        const members = yield* RunningServer.changeState({
          scopes: [AuthAccessReadScope],
          viaServer: Effect.fn("members.list.viaServer")(
            (client) => client.auth.listMembers({ headers: {} }),
            Effect.mapError(membersErrorFromServerAnswer),
          ),
          locally: Effect.gen(function* () {
            const principals = yield* Principals.PrincipalRepository;
            const memberships = yield* Memberships.MembershipRepository;
            const list = yield* principals.list;
            return yield* Effect.forEach(list, (principal) =>
              memberships.listForPrincipal(principal.id).pipe(
                Effect.map((rows): MemberWithMemberships => ({
                  principal,
                  memberships: rows,
                })),
              ),
            );
          }).pipe(
            Effect.provide(
              makeLocalMembersLayer().pipe(
                Layer.provide(ServerConfig.layer(config)),
                Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
              ),
            ),
          ),
        });

        if (flags.json) {
          yield* Console.log(yield* encodeMembersList(members));
          return;
        }
        yield* Console.log(formatMembersList(members));
      }),
    ),
  ),
);

const membersLoginCodeCommand = Command.make("login-code", {
  ...projectLocationFlags,
  principal: principalFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a one-time login code for an existing member."),
  Command.withHandler((flags) =>
    runMembersCommand(flags, (config) =>
      Effect.gen(function* () {
        const result = yield* RunningServer.changeState({
          scopes: AuthStandardClientScopes,
          viaServer: Effect.fn("members.loginCode.viaServer")(function* (client) {
            let principalId = Option.getOrUndefined(flags.principal);
            if (principalId === undefined) {
              const session = yield* client.auth.session({ headers: {} });
              principalId = session.principal?.id ?? InvitationService.OWNER_PRINCIPAL_ID;
            }
            return yield* client.auth.issueMemberLoginCode({
              headers: {},
              params: { principalId },
            });
          }, Effect.mapError(membersErrorFromServerAnswer)),
          locally: Effect.gen(function* () {
            const service = yield* InvitationService.InvitationService;
            const principalId = Option.getOrElse(
              flags.principal,
              () => InvitationService.OWNER_PRINCIPAL_ID,
            );
            const issued = yield* service.issueLogin({
              principalId,
              createdBy: InvitationService.OWNER_PRINCIPAL_ID,
            });
            return {
              code: issued.code,
              expiresAt: issued.invitation.expiresAt,
            } satisfies MemberLoginCodeResult;
          }).pipe(
            Effect.provide(
              makeLocalMembersLayer().pipe(
                Layer.provide(ServerConfig.layer(config)),
                Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
              ),
            ),
          ),
        });

        if (flags.json) {
          yield* Console.log(yield* encodeMemberLoginCodeResult(result));
          return;
        }
        yield* Console.log(
          [`Login code: ${result.code}`, `Expires: ${result.expiresAt}`].join("\n"),
        );
      }),
    ),
  ),
);

const makeMultiUserToggleCommand = (name: "enable" | "disable", enabled: boolean) =>
  Command.make(name, {
    ...projectLocationFlags,
    json: jsonFlag,
  }).pipe(
    Command.withDescription(
      enabled
        ? "Enable multi-user mode (owner-only)."
        : "Disable multi-user mode and return to single-owner mode (owner-only).",
    ),
    Command.withHandler((flags) =>
      runMembersCommand(flags, (config) =>
        Effect.gen(function* () {
          const result = yield* RunningServer.changeState({
            scopes: AuthStandardClientScopes,
            viaServer: Effect.fn(`members.${name}.viaServer`)(function* (client, origin) {
              const ticket = yield* client.auth.webSocketTicketFor({
                headers: {},
                params: { use: "rpc" },
              });
              const wsUrl = new URL(
                `/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(Redacted.value(ticket.ticket))}`,
                origin,
              );
              wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
              const layerProtocol = RpcClient.layerProtocolSocket().pipe(
                Layer.provide(
                  Socket.layerWebSocket(wsUrl.toString()).pipe(
                    Layer.provide(NodeSocket.layerWebSocketConstructor),
                  ),
                ),
                Layer.provide(RpcSerialization.layerJson),
              );
              const updated = yield* RpcClient.make(WsRpcGroup).pipe(
                Effect.flatMap((rpc) =>
                  rpc[WS_METHODS.serverUpdateSettings]({ patch: { multiUser: enabled } }),
                ),
                Effect.scoped,
                Effect.provide(layerProtocol),
              );
              const session = yield* client.auth.session({ headers: {} });
              const authMode =
                session.auth.authMode ?? (updated.multiUser ? "multi-user" : "single-owner");
              return { multiUser: updated.multiUser, authMode };
            }, Effect.mapError(membersErrorFromServerAnswer)),
            locally: Effect.gen(function* () {
              const settings = yield* ServerSettings.ServerSettingsService;
              const updated = yield* settings.updateSettings({ multiUser: enabled });
              return {
                multiUser: updated.multiUser,
                authMode: updated.multiUser ? ("multi-user" as const) : ("single-owner" as const),
              };
            }).pipe(
              Effect.provide(
                makeLocalSettingsLayer().pipe(
                  Layer.provide(ServerConfig.layer(config)),
                  Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
                ),
              ),
            ),
          });

          if (flags.json) {
            yield* Console.log(yield* encodeMembersMultiUserResult(result));
            return;
          }
          yield* Console.log(
            `Multi-user mode ${result.multiUser ? "enabled" : "disabled"} (authMode: ${result.authMode}).`,
          );
        }),
      ),
    ),
  );

const membersEnableCommand = makeMultiUserToggleCommand("enable", true);
const membersDisableCommand = makeMultiUserToggleCommand("disable", false);

export const membersCommand = Command.make("members").pipe(
  Command.withDescription("Manage environment members and invitations."),
  Command.withSubcommands([
    membersInviteCommand,
    membersListCommand,
    membersLoginCodeCommand,
    membersEnableCommand,
    membersDisableCommand,
  ]),
);
