import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type OrchestrationProjectShell,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HttpApiSchemaError } from "effect/http-api/HttpApiError";
import * as SqlClient from "effect/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectQuotaService from "../project/ProjectQuotaService.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  loadShellUnlessResumable,
  loadSubscriberShellSnapshot,
  projectIdentitiesDigest,
} from "./ShellStream.ts";
import { encodeThreadSnapshotBody } from "./threadSnapshotBody.ts";
import { boundedSnapshotResponseFields } from "./ThreadStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

const isInvalidThreadHistoryCursorError = Schema.is(InvalidThreadHistoryCursorError);

const isThreadTranscriptTooLargeError = Schema.is(
  ThreadManagementService.ThreadTranscriptTooLargeError,
);

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const projectQuotas = yield* ProjectQuotaService.ProjectQuotaService;
    const projectAccess = yield* ProjectAccess.ProjectAccess;

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.gen(function* () {
          const warningsByProject = yield* projectQuotas
            .getWarningsForProjects(projects.map((project) => project.id))
            .pipe(Effect.orElseSucceed(() => new Map()));
          return yield* Effect.forEach(
            projects,
            (project) =>
              // Use available enrichment only; git probes can take a minute and exceed shell-snapshot budgets.
              projectEnrichment.getAvailable(project.workspaceRoot).pipe(
                Effect.map((enrichment) => {
                  const quotaWarnings = warningsByProject.get(project.id);
                  return {
                    ...project,
                    repositoryIdentity: enrichment.repositoryIdentity,
                    ...(quotaWarnings !== undefined && quotaWarnings.length > 0
                      ? { quotaWarnings }
                      : {}),
                  };
                }),
              ),
            { concurrency: 16 },
          );
        }),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(
      function* (options: {
        readonly omitIdleSubagents: boolean;
        readonly omitOlderSettled: boolean;
        readonly allowedProjectIds?: ReadonlySet<string> | undefined;
      }) {
        const projectIds =
          options.allowedProjectIds === undefined
            ? undefined
            : Array.from(options.allowedProjectIds, (id) => ProjectId.make(id));
        const { snapshot } = yield* loadSubscriberShellSnapshot({
          sql,
          listShellIndex: threadManagement.listActiveShellIndex(
            projectIds === undefined ? undefined : { projectIds },
          ),
          readThreads: (threadIds) =>
            threadManagement.readShellSnapshot({
              location: "active",
              ...(projectIds === undefined ? {} : { projectIds }),
              ...(threadIds === undefined ? {} : { threadIds }),
            }),
          listProjects: projectStore.listShells(
            projectIds === undefined ? undefined : { projectIds },
          ),
          latestSequence: applicationEvents.latestApplicationSequence,
          options,
          allowedProjectIds: options.allowedProjectIds,
        });
        const projects = yield* enrichProjectShells(snapshot.projects);
        return { ...snapshot, projects, projectIdentities: projectIdentitiesDigest(projects) };
      },
    );

    // A client that holds rows names their cursor; a small answer tells it to keep them.
    const answerShellSnapshot = Effect.fn("http.orchestration.answerShellSnapshot")((
      query: {
        readonly omitIdleSubagents?: string;
        readonly omitOlderSettled?: string;
        readonly resumeFrom?: string;
      },
      allowedProjectIds: ReadonlySet<string> | undefined,
    ) => {
      const resumeFrom = query.resumeFrom === undefined ? Number.NaN : Number(query.resumeFrom);
      return loadShellUnlessResumable({
        events: applicationEvents,
        resumeFrom: Number.isSafeInteger(resumeFrom) && resumeFrom >= 0 ? resumeFrom : undefined,
        loadSnapshot: loadShellSnapshot({
          omitIdleSubagents: query.omitIdleSubagents === "1",
          omitOlderSettled: query.omitOlderSettled === "1",
          allowedProjectIds,
        }),
      });
    });

    const loadThreadSnapshot = Effect.fn("http.orchestration.loadThreadSnapshot")(function* (
      threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
      failureReason:
        | "orchestration_thread_snapshot_failed"
        | "orchestration_thread_bounded_snapshot_failed"
        | "orchestration_thread_history_failed",
    ) {
      return yield* threadManagement.getThreadSnapshot(threadId).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          projection: projectThreadProjectionForWire(snapshot.projection),
        })),
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            if (isThreadNotFound(error)) {
              return yield* failEnvironmentNotFound("thread_not_found");
            }
            return yield* failEnvironmentInternal(failureReason, error);
          }),
        ),
      );
    });

    const loadThreadSnapshotWindow = Effect.fn("http.orchestration.loadThreadSnapshotWindow")(
      function* (
        threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
        anchorItemId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorItemId"],
        anchorThreadId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorThreadId"],
        deferWork = false,
      ) {
        return yield* threadManagement
          .getThreadSnapshotWindow(threadId, {
            rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
            deferWork,
            userTurnLimit:
              anchorItemId === undefined
                ? THREAD_HISTORY_PAGE_POLICY.maxUserTurns
                : OLDER_THREAD_USER_TURN_LIMIT,
            ...(anchorItemId === undefined ? {} : { anchorItemId }),
            ...(anchorThreadId === undefined ? {} : { anchorThreadId }),
          })
          .pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              projection: projectThreadProjectionForWire(snapshot.projection),
            })),
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal("orchestration_thread_history_failed", error);
              }),
            ),
          );
      },
    );

    const resolveHttpActor = (
      failureReason:
        | "orchestration_snapshot_failed"
        | "orchestration_thread_snapshot_failed"
        | "orchestration_thread_bounded_snapshot_failed"
        | "orchestration_thread_history_failed",
    ) =>
      requireEnvironmentScope(AuthOrchestrationReadScope).pipe(
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
                    ? failEnvironmentInternal(failureReason, error)
                    : failEnvironmentAuthInvalid("invalid_credential"),
              }),
            ),
        ),
      );

    const assertThreadReadAccess = Effect.fn("http.orchestration.assertThreadReadAccess")(
      function* (
        threadId: Parameters<typeof threadManagement.getThreadShell>[0],
        failureReason:
          | "orchestration_thread_snapshot_failed"
          | "orchestration_thread_bounded_snapshot_failed"
          | "orchestration_thread_history_failed",
      ) {
        const actor = yield* resolveHttpActor(failureReason);
        const accessibleIds = projectAccess.accessibleProjectIds(actor);
        if (accessibleIds === undefined) return;
        const shell = yield* threadManagement
          .getThreadShell(threadId)
          .pipe(Effect.catch((error) => failEnvironmentInternal(failureReason, error)));
        if (shell === null || !projectAccess.can(actor, shell.projectId, "project:read")) {
          return yield* failEnvironmentNotFound("thread_not_found");
        }
      },
    );

    return handlers
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* resolveHttpActor("orchestration_snapshot_failed");
          return yield* answerShellSnapshot(
            args.query,
            projectAccess.accessibleProjectIds(actor),
          ).pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* assertThreadReadAccess(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          );
          const body = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          ).pipe(
            Effect.flatMap((snapshot) =>
              encodeThreadSnapshotBody({
                snapshotSequence: snapshot.snapshotSequence,
                projection: snapshot.projection,
              }).pipe(
                // The same defect, and the same empty 500, as a failed response encoding.
                Effect.catch((cause) =>
                  Effect.die(new HttpApiSchemaError({ kind: "Body", cause })),
                ),
              ),
            ),
            traceLocalHandlerWork,
          );
          return HttpServerResponse.stream(body, { contentType: "application/json" });
        }),
      )
      .handle(
        "threadTranscript",
        Effect.fn("environment.orchestration.threadTranscript")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* assertThreadReadAccess(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          );
          return yield* threadManagement.getThreadTranscript(args.params.threadId).pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
            traceLocalHandlerWork,
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadTranscriptTooLargeError(error)) {
                  return yield* failEnvironmentInvalidRequest("thread_transcript_too_large");
                }
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal(
                  "orchestration_thread_snapshot_failed",
                  error,
                );
              }),
            ),
          );
        }),
      )
      .handle(
        "threadBoundedSnapshot",
        Effect.fn("environment.orchestration.threadBoundedSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* assertThreadReadAccess(
            args.params.threadId,
            "orchestration_thread_bounded_snapshot_failed",
          );
          const snapshot = yield* loadThreadSnapshotWindow(
            args.params.threadId,
            undefined,
            undefined,
            args.query.deferWork === "1",
          ).pipe(traceLocalHandlerWork);
          const bounded = buildBoundedThreadProjection({
            projection: snapshot.projection,
            snapshotSequence: snapshot.snapshotSequence,
          });
          return {
            snapshotSequence: snapshot.snapshotSequence,
            ...boundedSnapshotResponseFields({
              bounded,
              compactTurnItems: args.query.compactTurnItems === "1",
              dedupeBodies: args.query.dedupeBodies === "1",
              compactIds: args.query.compactIds === "1",
            }),
          };
        }),
      )
      .handle(
        "threadHistoryPage",
        Effect.fn("environment.orchestration.threadHistoryPage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* assertThreadReadAccess(
            args.params.threadId,
            "orchestration_thread_history_failed",
          );
          const decoded = Result.try(() => decodeThreadHistoryCursor(args.query.cursor));
          if (Result.isFailure(decoded)) {
            const cause = decoded.failure;
            if (isInvalidThreadHistoryCursorError(cause))
              return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
            return yield* failEnvironmentInternal("orchestration_thread_history_failed", cause);
          }
          return yield* threadManagement
            .getThreadHistoryPage(
              args.params.threadId,
              args.query.cursor,
              args.query.throughEntryId,
              args.query.view === "conversation",
              args.query.view === "work"
                ? "work"
                : args.query.deferWork === "1"
                  ? "deferred"
                  : undefined,
            )
            .pipe(
              Effect.map((page) =>
                args.query.compactIds === "1" ? { ...page, idTable: true as const } : page,
              ),
              traceLocalHandlerWork,
              Effect.catch(
                Effect.fnUntraced(function* (cause) {
                  if (isThreadNotFound(cause))
                    return yield* failEnvironmentNotFound("thread_not_found");
                  return yield* failEnvironmentInternal(
                    "orchestration_thread_history_failed",
                    cause,
                  );
                }),
              ),
            );
        }),
      );
  }),
);
