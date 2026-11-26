import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpTooManyRequestsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as CrmService from "./CrmService.ts";

const mapCrmErrors = <A, R>(effect: Effect.Effect<A, CrmService.CrmServiceError, R>) =>
  effect.pipe(
    Effect.catchTags({
      project_forbidden: (error) =>
        Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
      CrmInvalidInputError: (error) =>
        Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
      CrmNotFoundError: () => failEnvironmentNotFound("resource_not_found"),
      CrmRateLimitedError: (error) =>
        Effect.fail(new EnvironmentHttpTooManyRequestsError({ message: error.message })),
      CrmInternalError: (error) => failEnvironmentInternal("internal_error", error),
    }),
  );

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "crm",
  Effect.fnUntraced(function* (handlers) {
    const crm = yield* CrmService.CrmService;
    const projectAccess = yield* ProjectAccess.ProjectAccess;

    const resolveActor = (
      scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
    ) =>
      requireEnvironmentScope(scope).pipe(
        Effect.flatMap((session) =>
          projectAccess
            .resolve({
              sessionId: session.sessionId,
              subject: session.subject,
              scopes: Array.from(session.scopes),
              principalId: session.principalId,
              binding: session.binding,
            })
            .pipe(
              Effect.catchTags({
                AccessResolveError: (error) =>
                  error.reason === "repository_error"
                    ? failEnvironmentInternal("internal_error", error)
                    : failEnvironmentAuthInvalid("invalid_credential"),
              }),
              Effect.map((actor) => ({ session, actor })),
            ),
        ),
      );

    const readAuditContext = Effect.fnUntraced(function* (
      sessionId: ProjectAccess.AccessActor["sessionId"],
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const clientMetadata = deriveAuthClientMetadata({ request });
      return {
        sessionId,
        ip: clientMetadata.ipAddress ?? null,
        userAgent: clientMetadata.userAgent ?? null,
      } satisfies CrmService.CrmAuditContext;
    });

    return handlers
      .handle(
        "listClients",
        Effect.fn("environment.crm.listClients")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationReadScope);
          return yield* crm
            .listClients({ projectId: args.params.id, actor })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "createClient",
        Effect.fn("environment.crm.createClient")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          return yield* crm
            .createClient({ projectId: args.params.id, data: args.payload, actor })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "getClient",
        Effect.fn("environment.crm.getClient")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationReadScope);
          return yield* crm
            .getClient({ projectId: args.params.id, clientId: args.params.clientId, actor })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "updateClient",
        Effect.fn("environment.crm.updateClient")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          return yield* crm
            .updateClient({
              projectId: args.params.id,
              clientId: args.params.clientId,
              data: args.payload,
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "deleteClient",
        Effect.fn("environment.crm.deleteClient")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { session, actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          const audit = yield* readAuditContext(session.sessionId);
          const purge = args.query.purge === "true" || args.query.purge === "1";
          return yield* crm
            .deleteClient({
              projectId: args.params.id,
              clientId: args.params.clientId,
              purge,
              actor,
              audit,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "listContacts",
        Effect.fn("environment.crm.listContacts")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationReadScope);
          return yield* crm
            .listContacts({ projectId: args.params.id, clientId: args.params.clientId, actor })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "createContact",
        Effect.fn("environment.crm.createContact")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          return yield* crm
            .createContact({
              projectId: args.params.id,
              clientId: args.params.clientId,
              data: args.payload,
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "updateContact",
        Effect.fn("environment.crm.updateContact")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          return yield* crm
            .updateContact({
              projectId: args.params.id,
              clientId: args.params.clientId,
              contactId: args.params.contactId,
              data: args.payload,
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "deleteContact",
        Effect.fn("environment.crm.deleteContact")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          const deleted = yield* crm
            .deleteContact({
              projectId: args.params.id,
              clientId: args.params.clientId,
              contactId: args.params.contactId,
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
          return { deleted };
        }),
      )
      .handle(
        "listNotes",
        Effect.fn("environment.crm.listNotes")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationReadScope);
          return yield* crm
            .listNotes({ projectId: args.params.id, clientId: args.params.clientId, actor })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "createNote",
        Effect.fn("environment.crm.createNote")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          return yield* crm
            .createNote({
              projectId: args.params.id,
              clientId: args.params.clientId,
              data: args.payload,
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "updateNote",
        Effect.fn("environment.crm.updateNote")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          return yield* crm
            .updateNote({
              projectId: args.params.id,
              clientId: args.params.clientId,
              noteId: args.params.noteId,
              data: args.payload,
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "deleteNote",
        Effect.fn("environment.crm.deleteNote")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          const deleted = yield* crm
            .deleteNote({
              projectId: args.params.id,
              clientId: args.params.clientId,
              noteId: args.params.noteId,
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
          return { deleted };
        }),
      )
      .handle(
        "listClientThreads",
        Effect.fn("environment.crm.listClientThreads")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationReadScope);
          return yield* crm
            .listClientThreads({
              projectId: args.params.id,
              clientId: args.params.clientId,
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "linkClientThread",
        Effect.fn("environment.crm.linkClientThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          return yield* crm
            .linkClientThread({
              projectId: args.params.id,
              clientId: args.params.clientId,
              threadId: args.payload.threadId,
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "unlinkClientThread",
        Effect.fn("environment.crm.unlinkClientThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          const unlinked = yield* crm
            .unlinkClientThread({
              projectId: args.params.id,
              clientId: args.params.clientId,
              threadId: args.params.threadId,
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
          return { unlinked };
        }),
      )
      .handle(
        "inviteClient",
        Effect.fn("environment.crm.inviteClient")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { session, actor } = yield* resolveActor(AuthOrchestrationOperateScope);
          const audit = yield* readAuditContext(session.sessionId);
          return yield* crm
            .inviteClient({
              projectId: args.params.id,
              clientId: args.params.clientId,
              actor,
              audit,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "exportCrm",
        Effect.fn("environment.crm.exportCrm")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { session, actor } = yield* resolveActor(AuthOrchestrationReadScope);
          const audit = yield* readAuditContext(session.sessionId);
          return yield* crm
            .exportJsonl({
              projectId: args.params.id,
              ...(args.query.clientId === undefined ? {} : { clientId: args.query.clientId }),
              actor,
              audit,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      )
      .handle(
        "getPortal",
        Effect.fn("environment.crm.getPortal")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const { actor } = yield* resolveActor(AuthOrchestrationReadScope);
          return yield* crm
            .getPortal({
              ...(args.query.clientId === undefined ? {} : { clientId: args.query.clientId }),
              actor,
            })
            .pipe(traceLocalHandlerWork, mapCrmErrors);
        }),
      );
  }),
);
