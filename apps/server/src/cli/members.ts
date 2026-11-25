import {
  AuthAccessReadScope,
  AuthStandardClientScopes,
  EnvironmentHttpCommonError,
  InvitationCreateResult,
  MemberWithMemberships,
  ProjectId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClientError } from "effect/http";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as InvitationService from "../identity/InvitationService.ts";
import * as MembershipService from "../identity/MembershipService.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as RunningServer from "./runningServer.ts";

const INVITABLE_ROLES = ["viewer", "operator", "developer", "manager", "admin"] as const;
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const encodeInvitationCreateResult = Schema.encodeEffect(
  Schema.fromJsonString(InvitationCreateResult),
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
  const access = ProjectAccess.layer.pipe(Layer.provide(repos));
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

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
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

export const membersCommand = Command.make("members").pipe(
  Command.withDescription("Manage environment members and invitations."),
  Command.withSubcommands([membersInviteCommand, membersListCommand]),
);
