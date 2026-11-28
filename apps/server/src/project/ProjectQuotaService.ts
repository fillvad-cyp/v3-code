import {
  DEFAULT_PROJECT_ATTACHMENT_BYTES,
  DEFAULT_PROJECT_DISK_BYTES,
  DEFAULT_PROJECT_MAX_ACTIVE_THREADS,
  DEFAULT_PROJECT_MAX_WORKTREES,
  PROJECT_QUOTA_WARNING_RATIO,
  PrincipalId,
  ProjectId,
  ProjectQuotaExceededError,
  type ProjectQuotaLimits,
  type ProjectQuotaResource,
  type ProjectQuotaWarning,
  type ProjectUsageResult,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Principals from "../persistence/Principals.ts";
import * as ProjectQuotas from "../persistence/ProjectQuotas.ts";
import * as ProjectUsageSamples from "../persistence/ProjectUsageSamples.ts";
import { forkParked } from "../serverActivation.ts";

const DISK_USAGE_SAMPLE_INTERVAL = Duration.minutes(5);

export class ProjectQuotaInternalError extends Schema.TaggedError<ProjectQuotaInternalError>()(
  "ProjectQuotaInternalError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project quota operation failed (${this.operation}).`;
  }
}

function buildQuotaWarnings(input: {
  readonly activeThreads: number;
  readonly worktrees: number;
  readonly diskBytes: number;
  readonly limits: ProjectQuotaLimits;
}): ReadonlyArray<ProjectQuotaWarning> {
  const entries: ReadonlyArray<readonly [ProjectQuotaResource, number, number]> = [
    ["active_threads", input.activeThreads, input.limits.maxActiveThreads],
    ["worktrees", input.worktrees, input.limits.maxWorktrees],
    ["disk_bytes", input.diskBytes, input.limits.diskBytes],
  ];
  const warnings: ProjectQuotaWarning[] = [];
  for (const [resource, current, limit] of entries) {
    if (limit <= 0) {
      if (current > 0) {
        warnings.push({ resource, level: "exceeded", current, limit, ratio: 1 });
      }
      continue;
    }
    const ratio = current / limit;
    if (ratio >= PROJECT_QUOTA_WARNING_RATIO) {
      warnings.push({
        resource,
        level: current >= limit ? "exceeded" : "warning",
        current,
        limit,
        ratio: Math.round(ratio * 1000) / 1000,
      });
    }
  }
  return warnings;
}

function warningsSignature(warnings: ReadonlyArray<ProjectQuotaWarning>): string {
  return JSON.stringify(warnings);
}

export class ProjectQuotaService extends Context.Service<
  ProjectQuotaService,
  {
    readonly getUsage: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectUsageResult, ProjectQuotaInternalError>;
    readonly getWarningsForProjects: (
      projectIds: ReadonlyArray<ProjectId>,
    ) => Effect.Effect<
      ReadonlyMap<ProjectId, ReadonlyArray<ProjectQuotaWarning>>,
      ProjectQuotaInternalError
    >;
    readonly assertCanLaunchThread: (input: {
      readonly projectId: ProjectId;
      readonly principalId?: PrincipalId;
      readonly createsWorktree: boolean;
      readonly reuseExistingThread?: boolean;
    }) => Effect.Effect<void, ProjectQuotaExceededError | ProjectQuotaInternalError>;
    readonly assertCanCreateWorktree: (input: {
      readonly projectId: ProjectId;
      readonly principalId?: PrincipalId;
    }) => Effect.Effect<void, ProjectQuotaExceededError | ProjectQuotaInternalError>;
    readonly sampleProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectUsageSamples.ProjectUsageSample, ProjectQuotaInternalError>;
    readonly sampleAll: Effect.Effect<
      ReadonlyArray<ProjectUsageSamples.ProjectUsageSample>,
      ProjectQuotaInternalError
    >;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<ProjectId>, never, Scope.Scope>;
  }
>()("v3code/project/ProjectQuotaService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const principals = yield* Principals.PrincipalRepository;
  const projectQuotas = yield* ProjectQuotas.ProjectQuotaRepository;
  const usageSamples = yield* ProjectUsageSamples.ProjectUsageSampleRepository;
  const changesPubSub = yield* PubSub.unbounded<ProjectId>();
  const lastWarningSignatureRef = yield* Ref.make(new Map<ProjectId, string>());

  const resolveLimits = Effect.fn("ProjectQuotaService.resolveLimits")(function* (
    projectId: ProjectId,
  ) {
    const override = yield* projectQuotas
      .get(projectId)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectQuotaInternalError({ operation: "getProjectQuota", cause }),
        ),
      );
    return {
      maxActiveThreads: override?.maxActiveThreads ?? DEFAULT_PROJECT_MAX_ACTIVE_THREADS,
      maxWorktrees: override?.maxWorktrees ?? DEFAULT_PROJECT_MAX_WORKTREES,
      diskBytes: override?.diskBytes ?? DEFAULT_PROJECT_DISK_BYTES,
      attachmentBytes: override?.attachmentBytes ?? DEFAULT_PROJECT_ATTACHMENT_BYTES,
    } satisfies ProjectQuotaLimits;
  });

  const isOwnerPrincipal = Effect.fn("ProjectQuotaService.isOwnerPrincipal")(function* (
    principalId: PrincipalId,
  ) {
    const maybePrincipal = yield* principals
      .get(principalId)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectQuotaInternalError({ operation: "getPrincipal", cause }),
        ),
      );
    return Option.isSome(maybePrincipal) && maybePrincipal.value.kind === "owner";
  });

  const countActiveThreads = (projectId: ProjectId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count"
      FROM orchestration_v2_projection_threads
      WHERE project_id = ${projectId}
        AND archived_at IS NULL
        AND deleted_at IS NULL
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
      Effect.mapError(
        (cause) => new ProjectQuotaInternalError({ operation: "countActiveThreads", cause }),
      ),
    );

  const countWorktrees = (projectId: ProjectId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count"
      FROM (
        SELECT json_extract(payload_json, '$.worktreePath') AS path
        FROM orchestration_v2_projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
        UNION
        SELECT root AS path
        FROM task_folders
        WHERE project_id = ${projectId}
      )
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
      Effect.mapError(
        (cause) => new ProjectQuotaInternalError({ operation: "countWorktrees", cause }),
      ),
    );

  const publishIfWarningsChanged = Effect.fn("ProjectQuotaService.publishIfWarningsChanged")(
    function* (projectId: ProjectId, warnings: ReadonlyArray<ProjectQuotaWarning>) {
      const signature = warningsSignature(warnings);
      const changed = yield* Ref.modify(lastWarningSignatureRef, (current) => {
        const previous = current.get(projectId);
        if (previous === signature) {
          return [false, current] as const;
        }
        const next = new Map(current);
        next.set(projectId, signature);
        return [true, next] as const;
      });
      if (changed) {
        yield* PubSub.publish(changesPubSub, projectId);
      }
    },
  );

  const getUsage: ProjectQuotaService["Service"]["getUsage"] = Effect.fn(
    "ProjectQuotaService.getUsage",
  )(function* (projectId) {
    const [limits, activeThreads, worktrees, sample] = yield* Effect.all([
      resolveLimits(projectId),
      countActiveThreads(projectId),
      countWorktrees(projectId),
      usageSamples
        .get(projectId)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectQuotaInternalError({ operation: "getUsageSample", cause }),
          ),
        ),
    ]);
    const diskBytes = sample?.diskBytes ?? 0;
    const warnings = buildQuotaWarnings({ activeThreads, worktrees, diskBytes, limits });
    return {
      projectId,
      activeThreads,
      worktrees,
      diskBytes,
      sampledAt: sample?.sampledAt ?? null,
      limits,
      warnings,
    };
  });

  const getWarningsForProjects: ProjectQuotaService["Service"]["getWarningsForProjects"] =
    Effect.fn("ProjectQuotaService.getWarningsForProjects")(function* (projectIds) {
      const result = new Map<ProjectId, ReadonlyArray<ProjectQuotaWarning>>();
      if (projectIds.length === 0) {
        return result;
      }
      const usages = yield* Effect.forEach(projectIds, (projectId) => getUsage(projectId), {
        concurrency: 8,
      });
      for (const usage of usages) {
        if (usage.warnings.length > 0) {
          result.set(usage.projectId, usage.warnings);
        }
      }
      return result;
    });

  const assertCanLaunchThread: ProjectQuotaService["Service"]["assertCanLaunchThread"] = Effect.fn(
    "ProjectQuotaService.assertCanLaunchThread",
  )(function* (input) {
    if (input.principalId === undefined) {
      return;
    }
    if (yield* isOwnerPrincipal(input.principalId)) {
      return;
    }
    const usage = yield* getUsage(input.projectId);
    yield* publishIfWarningsChanged(input.projectId, usage.warnings);
    if (usage.diskBytes >= usage.limits.diskBytes) {
      return yield* new ProjectQuotaExceededError({
        projectId: input.projectId,
        resource: "disk_bytes",
        current: usage.diskBytes,
        limit: usage.limits.diskBytes,
      });
    }
    if (
      input.reuseExistingThread !== true &&
      usage.activeThreads >= usage.limits.maxActiveThreads
    ) {
      return yield* new ProjectQuotaExceededError({
        projectId: input.projectId,
        resource: "active_threads",
        current: usage.activeThreads,
        limit: usage.limits.maxActiveThreads,
      });
    }
    if (input.createsWorktree && usage.worktrees >= usage.limits.maxWorktrees) {
      return yield* new ProjectQuotaExceededError({
        projectId: input.projectId,
        resource: "worktrees",
        current: usage.worktrees,
        limit: usage.limits.maxWorktrees,
      });
    }
  });

  const assertCanCreateWorktree: ProjectQuotaService["Service"]["assertCanCreateWorktree"] =
    Effect.fn("ProjectQuotaService.assertCanCreateWorktree")(function* (input) {
      if (input.principalId === undefined) {
        return;
      }
      if (yield* isOwnerPrincipal(input.principalId)) {
        return;
      }
      const usage = yield* getUsage(input.projectId);
      yield* publishIfWarningsChanged(input.projectId, usage.warnings);
      if (usage.diskBytes >= usage.limits.diskBytes) {
        return yield* new ProjectQuotaExceededError({
          projectId: input.projectId,
          resource: "disk_bytes",
          current: usage.diskBytes,
          limit: usage.limits.diskBytes,
        });
      }
      if (usage.worktrees >= usage.limits.maxWorktrees) {
        return yield* new ProjectQuotaExceededError({
          projectId: input.projectId,
          resource: "worktrees",
          current: usage.worktrees,
          limit: usage.limits.maxWorktrees,
        });
      }
    });

  const computeProjectAttachmentBytes = Effect.fn(
    "ProjectQuotaService.computeProjectAttachmentBytes",
  )(function* (
    threadIds: ReadonlyArray<string>,
    attachmentEntries: ReadonlyArray<string> | undefined,
  ) {
    if (threadIds.length === 0) {
      return 0;
    }
    const prefixes: string[] = [];
    for (const threadId of threadIds) {
      const segment = toSafeThreadAttachmentSegment(threadId);
      if (segment !== null) {
        prefixes.push(`${segment}-`);
      }
    }
    if (prefixes.length === 0) {
      return 0;
    }
    const entries =
      attachmentEntries ??
      (yield* fs
        .readDirectory(config.attachmentsDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>)));
    let total = 0;
    for (const entry of entries) {
      if (!prefixes.some((prefix) => entry.startsWith(prefix))) {
        continue;
      }
      const info = yield* fs
        .stat(path.join(config.attachmentsDir, entry))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (info !== undefined && info.type === "File") {
        total += Number(info.size);
      }
    }
    return total;
  });

  const sampleProjectWithEntries = Effect.fn("ProjectQuotaService.sampleProject")(function* (
    projectId: ProjectId,
    attachmentEntries?: ReadonlyArray<string>,
  ) {
    const [sqlBytesRows, threadRows] = yield* Effect.all([
      sql<{ readonly bytes: number | null }>`
        SELECT
          COALESCE(
            (SELECT SUM(LENGTH(CAST(payload_json AS BLOB)))
             FROM orchestration_v2_projection_threads
             WHERE project_id = ${projectId}),
            0
          ) +
          COALESCE(
            (SELECT SUM(LENGTH(CAST(e.payload_json AS BLOB)))
             FROM orchestration_v2_events e
             JOIN orchestration_v2_projection_threads t ON t.thread_id = e.thread_id
             WHERE t.project_id = ${projectId}),
            0
          ) AS "bytes"
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(
          (cause) => new ProjectQuotaInternalError({ operation: "sampleSqlBytes", cause }),
        ),
      ),
      sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM orchestration_v2_projection_threads
        WHERE project_id = ${projectId}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(
          (cause) => new ProjectQuotaInternalError({ operation: "listProjectThreads", cause }),
        ),
      ),
    ]);
    const sqlBytes = Number(sqlBytesRows[0]?.bytes ?? 0);
    const attachmentBytes = yield* computeProjectAttachmentBytes(
      threadRows.map((row) => row.threadId),
      attachmentEntries,
    );
    const diskBytes = Math.max(0, Math.trunc(sqlBytes + attachmentBytes));
    const sampledAt = DateTime.formatIso(yield* DateTime.now);
    const sample: ProjectUsageSamples.ProjectUsageSample = {
      projectId,
      diskBytes,
      sampledAt,
    };
    yield* usageSamples
      .upsert(sample)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectQuotaInternalError({ operation: "upsertUsageSample", cause }),
        ),
      );
    const usage = yield* getUsage(projectId);
    yield* publishIfWarningsChanged(projectId, usage.warnings);
    return sample;
  });

  const sampleProject: ProjectQuotaService["Service"]["sampleProject"] = (projectId) =>
    sampleProjectWithEntries(projectId);

  const sampleAllProjects = Effect.fn("ProjectQuotaService.sampleAll")(function* () {
    const projectRows = yield* sql<{ readonly projectId: string }>`
      SELECT project_id AS "projectId"
      FROM projection_projects
      WHERE deleted_at IS NULL
      ORDER BY project_id ASC
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) => new ProjectQuotaInternalError({ operation: "listProjectsForSampling", cause }),
      ),
    );
    if (projectRows.length === 0) {
      return [];
    }
    const attachmentEntries = yield* fs
      .readDirectory(config.attachmentsDir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    return yield* Effect.forEach(
      projectRows,
      (row) => sampleProjectWithEntries(ProjectId.make(row.projectId), attachmentEntries),
      { concurrency: 4 },
    );
  });

  return ProjectQuotaService.of({
    getUsage,
    getWarningsForProjects,
    assertCanLaunchThread,
    assertCanCreateWorktree,
    sampleProject,
    sampleAll: sampleAllProjects(),
    subscribeChanges: PubSub.subscribe(changesPubSub),
  });
});

export const layer = Layer.effect(ProjectQuotaService, make).pipe(
  Layer.provideMerge(Principals.layer),
  Layer.provideMerge(ProjectQuotas.layer),
  Layer.provideMerge(ProjectUsageSamples.layer),
);

export const layerSampler = Layer.effectDiscard(
  Effect.gen(function* () {
    const quotas = yield* ProjectQuotaService;
    yield* forkParked(
      quotas.sampleAll.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to sample project disk usage", { cause }),
        ),
        Effect.repeat(Schedule.spaced(DISK_USAGE_SAMPLE_INTERVAL)),
      ),
    );
  }),
);
