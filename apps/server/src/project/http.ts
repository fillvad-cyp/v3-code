import {
  AuthAccessReadScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
  requiredScopesForProjectMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as ProjectAccess from "../access/ProjectAccess.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectQuotaService from "./ProjectQuotaService.ts";
import * as ProjectSecrets from "./ProjectSecrets.ts";
import * as ProjectService from "./ProjectService.ts";
import { mutateProjectWithClone } from "./ProjectMutation.ts";

const failProjectMutation = Effect.fn("environment.projects.failMutation")(function* (
  cause: ProjectService.ProjectServiceError | ServerRuntimeStartup.ServerRuntimeStartupError,
) {
  if (cause._tag === "EnvironmentHttpForbiddenError") {
    return yield* cause;
  }
  if (
    cause._tag === "ProjectNotFoundError" ||
    cause._tag === "ProjectConflictError" ||
    cause._tag === "ProjectNotEmptyError" ||
    cause._tag === "ProjectInvalidError"
  ) {
    return yield* failEnvironmentInvalidRequest("invalid_command");
  }
  return yield* failEnvironmentInternal("project_mutation_failed", cause);
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "projects",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* ProjectService.ProjectService;
    const projectAccess = yield* ProjectAccess.ProjectAccess;
    const projectQuotas = yield* ProjectQuotaService.ProjectQuotaService;
    const projectSecrets = yield* ProjectSecrets.ProjectSecrets;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const projectClones = yield* ProjectCloneTracker.ProjectCloneTracker;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.projects.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const actor = yield* projectAccess
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
                    ? failEnvironmentInternal("project_snapshot_failed", error)
                    : failEnvironmentAuthInvalid("invalid_credential"),
              }),
            );
          const allowedProjectIds = projectAccess.accessibleProjectIds(actor);
          return yield* projects.snapshot.pipe(
            Effect.map((snapshot) =>
              allowedProjectIds === undefined
                ? snapshot
                : {
                    ...snapshot,
                    projects: snapshot.projects.filter((project) =>
                      allowedProjectIds.has(project.id),
                    ),
                  },
            ),
            traceLocalHandlerWork,
            Effect.catch((cause) => failEnvironmentInternal("project_snapshot_failed", cause)),
          );
        }),
      )
      .handle(
        "mutate",
        Effect.fn("environment.projects.mutate")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const requiredScopes = requiredScopesForProjectMutation(args.payload);
          let session = yield* requireEnvironmentScope(requiredScopes[0]!);
          for (const scope of requiredScopes.slice(1)) {
            session = yield* requireEnvironmentScope(scope);
          }
          const actor = yield* projectAccess
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
                    ? failEnvironmentInternal("project_mutation_failed", error)
                    : failEnvironmentAuthInvalid("invalid_credential"),
              }),
            );
          const allowedProjectIds = projectAccess.accessibleProjectIds(actor);
          if (allowedProjectIds !== undefined) {
            if (args.payload.type === "project.create") {
              const canCreate = Array.from(allowedProjectIds).some((projectId) =>
                projectAccess.can(actor, projectId, "project:create"),
              );
              if (!canCreate) {
                return yield* new EnvironmentHttpForbiddenError({
                  message: "Missing required capability project:create.",
                });
              }
            } else {
              const requiredCapability =
                args.payload.type === "project.delete" ? "project:delete" : "project:settings";
              if (!projectAccess.can(actor, args.payload.projectId, requiredCapability)) {
                return yield* new EnvironmentHttpForbiddenError({
                  message: `Missing required capability ${requiredCapability} on project ${args.payload.projectId}.`,
                });
              }
            }
          }
          const operation = mutateProjectWithClone(projects, projectClones, args.payload, actor);
          return yield* startup
            .enqueueCommand(operation)
            .pipe(traceLocalHandlerWork, Effect.catch(failProjectMutation));
        }),
      )
      .handle(
        "usage",
        Effect.fn("environment.projects.usage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthAccessReadScope);
          const actor = yield* projectAccess
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
            );
          if (!projectAccess.can(actor, args.params.id, "project:read")) {
            return yield* new EnvironmentHttpForbiddenError({
              message: `Missing required capability project:read on project ${args.params.id}.`,
            });
          }
          const project = yield* projects
            .getById(args.params.id)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          if (Option.isNone(project)) {
            return yield* failEnvironmentNotFound("resource_not_found");
          }
          return yield* projectQuotas.getUsage(args.params.id).pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "listSecrets",
        Effect.fn("environment.projects.listSecrets")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthProvidersManageScope);
            const actor = yield* projectAccess
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
              );
            return yield* projectSecrets
              .list({ projectId: args.params.id, actor })
              .pipe(traceLocalHandlerWork);
          },
          Effect.catchTags({
            project_forbidden: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            ProjectSecretNotFoundError: () => failEnvironmentNotFound("resource_not_found"),
            ProjectSecretInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "setSecret",
        Effect.fn("environment.projects.setSecret")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthProvidersManageScope);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* projectAccess
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
              );
            return yield* projectSecrets
              .set({
                projectId: args.params.id,
                name: args.params.name,
                value: args.payload.value,
                actor,
                audit: {
                  sessionId: session.sessionId,
                  ip: clientMetadata.ipAddress ?? null,
                  userAgent: clientMetadata.userAgent ?? null,
                },
              })
              .pipe(traceLocalHandlerWork);
          },
          Effect.catchTags({
            project_forbidden: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            ProjectSecretInvalidInputError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            ProjectSecretNotFoundError: () => failEnvironmentNotFound("resource_not_found"),
            ProjectSecretInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "deleteSecret",
        Effect.fn("environment.projects.deleteSecret")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthProvidersManageScope);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* projectAccess
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
              );
            const deleted = yield* projectSecrets
              .remove({
                projectId: args.params.id,
                name: args.params.name,
                actor,
                audit: {
                  sessionId: session.sessionId,
                  ip: clientMetadata.ipAddress ?? null,
                  userAgent: clientMetadata.userAgent ?? null,
                },
              })
              .pipe(traceLocalHandlerWork);
            return { deleted };
          },
          Effect.catchTags({
            project_forbidden: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            ProjectSecretInvalidInputError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            ProjectSecretNotFoundError: () => failEnvironmentNotFound("resource_not_found"),
            ProjectSecretInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      );
  }),
);
