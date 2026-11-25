import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  requiredScopesForProjectMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectAccess from "../access/ProjectAccess.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectService from "./ProjectService.ts";
import { mutateProjectWithClone } from "./ProjectMutation.ts";

const failProjectMutation = Effect.fn("environment.projects.failMutation")(function* (
  cause: ProjectService.ProjectServiceError | ServerRuntimeStartup.ServerRuntimeStartupError,
) {
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
          for (const scope of requiredScopesForProjectMutation(args.payload)) {
            yield* requireEnvironmentScope(scope);
          }
          const operation = mutateProjectWithClone(projects, projectClones, args.payload);
          return yield* startup
            .enqueueCommand(operation)
            .pipe(traceLocalHandlerWork, Effect.catch(failProjectMutation));
        }),
      );
  }),
);
