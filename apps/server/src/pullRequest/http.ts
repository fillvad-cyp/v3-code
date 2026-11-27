import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as PullRequestService from "./PullRequestService.ts";

// Large patches benefit from HTTP compression and flow control.
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "pullRequests",
  Effect.fnUntraced(function* (handlers) {
    const pullRequests = yield* PullRequestService.PullRequestService;
    const projectAccess = yield* ProjectAccess.ProjectAccess;
    return handlers.handle(
      "diff",
      Effect.fn("environment.pullRequests.diff")(function* (args) {
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
                  ? failEnvironmentInternal("internal_error", error)
                  : failEnvironmentAuthInvalid("invalid_credential"),
            }),
          );
        const allowedProjectIds = projectAccess.accessibleProjectIds(actor);
        if (
          allowedProjectIds !== undefined &&
          !projectAccess.can(actor, args.payload.projectId, "project:read")
        ) {
          return yield* new EnvironmentHttpForbiddenError({
            message: `Missing required capability project:read on project ${args.payload.projectId}.`,
          });
        }
        return yield* pullRequests
          .diff(args.payload)
          .pipe(PullRequestService.withAllowedProjectIds(allowedProjectIds), traceLocalHandlerWork);
      }),
    );
  }),
);
