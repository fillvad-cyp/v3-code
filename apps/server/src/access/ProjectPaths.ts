import {
  type ProjectCapability,
  ProjectForbiddenError,
  ProjectId,
  passesProjectChecks,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import { isFilesystemRoot } from "../worktreesDirectory.ts";
import * as ProjectAccess from "./ProjectAccess.ts";

const MAX_SYMLINK_DEPTH = 40;
const MAX_ROOT_CACHE_ENTRIES = 256;

type ProjectRootKind = "workspaceRoot" | "worktree" | "trackedFolder" | "worktreesDir";

const ROOT_KIND_PRIORITY: Readonly<Record<ProjectRootKind, number>> = {
  workspaceRoot: 0,
  worktree: 1,
  trackedFolder: 2,
  worktreesDir: 3,
};

interface ProjectRootEntry {
  readonly realRoot: string;
  readonly projectId: ProjectId;
  readonly kind: ProjectRootKind;
}

interface CachedProjectRoots {
  readonly revision: number;
  readonly roots: ReadonlyArray<ProjectRootEntry>;
}

interface ResolvedProjectPath {
  readonly realPath: string;
  readonly projectId: ProjectId | undefined;
}

class PathResolveError extends Schema.TaggedError<PathResolveError>()("PathResolveError", {
  target: Schema.String,
  reason: Schema.Literals(["empty", "symlink_loop", "realpath_failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "empty":
        return "Path must not be empty.";
      case "symlink_loop":
        return "Path exceeded symlink resolution depth.";
      case "realpath_failed":
        return "Path could not be resolved.";
    }
  }
}

export class ProjectPaths extends Context.Service<
  ProjectPaths,
  {
    readonly assertPath: (
      actor: ProjectAccess.AccessActor,
      targetPath: string,
      capability: ProjectCapability,
    ) => Effect.Effect<ResolvedProjectPath, ProjectForbiddenError>;
    readonly assertCwd: (
      actor: ProjectAccess.AccessActor,
      cwd: string,
      capability: ProjectCapability,
    ) => Effect.Effect<ResolvedProjectPath, ProjectForbiddenError>;
  }
>()("v3code/access/ProjectPaths") {}

function errnoCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const record = cause as { readonly code?: unknown; readonly cause?: unknown };
  if (typeof record.code === "string") return record.code;
  if (typeof record.cause === "object" && record.cause !== null) {
    const nested = record.cause as { readonly code?: unknown };
    if (typeof nested.code === "string") return nested.code;
  }
  return undefined;
}

function actorCacheKey(actor: ProjectAccess.AccessActor): string {
  return actor.principalId !== undefined
    ? `principal:${actor.principalId}`
    : `session:${actor.sessionId}`;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectAccess = yield* ProjectAccess.ProjectAccess;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;

  const rootCache = new Map<string, CachedProjectRoots>();

  // Recursive ancestor walk runs inside assertPath/assertCwd's span; per-segment spans would be noisy.
  const resolveRealPathRecursive = Effect.fnUntraced(function* (
    target: string,
    depth: number,
  ): Effect.fn.Return<string, PathResolveError> {
    if (depth > MAX_SYMLINK_DEPTH) {
      return yield* new PathResolveError({ target, reason: "symlink_loop" });
    }
    const direct = yield* fileSystem.realPath(target).pipe(Effect.result);
    if (direct._tag === "Success") {
      return direct.success;
    }
    const isMissing =
      direct.failure.reason._tag === "NotFound" || errnoCode(direct.failure) === "ENOTDIR";
    if (!isMissing) {
      return yield* new PathResolveError({
        target,
        reason: "realpath_failed",
        cause: direct.failure,
      });
    }

    const linkTarget = yield* fileSystem.readLink(target).pipe(Effect.option);
    if (Option.isSome(linkTarget)) {
      const resolvedLink = path.isAbsolute(linkTarget.value)
        ? linkTarget.value
        : path.resolve(path.dirname(target), linkTarget.value);
      return yield* resolveRealPathRecursive(resolvedLink, depth + 1);
    }

    const parent = path.dirname(target);
    if (parent === target) {
      return target;
    }
    const leaf = path.basename(target);
    const resolvedParent = yield* resolveRealPathRecursive(parent, depth);
    const combined = path.resolve(resolvedParent, leaf);
    // Collapsing `..` or following a parent symlink can land on an existing path or symlink.
    if (combined !== target) {
      const rechecked = yield* fileSystem.realPath(combined).pipe(Effect.option);
      if (Option.isSome(rechecked)) {
        return rechecked.value;
      }
      const recheckedLink = yield* fileSystem.readLink(combined).pipe(Effect.option);
      if (Option.isSome(recheckedLink)) {
        const resolvedLink = path.isAbsolute(recheckedLink.value)
          ? recheckedLink.value
          : path.resolve(path.dirname(combined), recheckedLink.value);
        return yield* resolveRealPathRecursive(resolvedLink, depth + 1);
      }
    }
    return combined;
  });

  const resolveTargetPath = Effect.fnUntraced(function* (rawPath: string) {
    const trimmed = rawPath.trim();
    if (trimmed.length === 0) {
      return yield* new PathResolveError({ target: rawPath, reason: "empty" });
    }
    const home = yield* HostProcess.HomeDirectory;
    const expanded =
      trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? expandHomePath(trimmed, home)
        : trimmed;
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    return yield* resolveRealPathRecursive(absolute, 0);
  });

  const resolveRoot = (rawRoot: string): Effect.Effect<string | null> =>
    resolveTargetPath(rawRoot).pipe(
      Effect.map((resolved) => (isFilesystemRoot(resolved, path) ? null : resolved)),
      Effect.orElseSucceed(() => null),
    );

  const loadProjectRoots = Effect.fn("ProjectPaths.loadProjectRoots")(function* () {
    const projects = yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []));
    const basenameCounts = new Map<string, number>();
    for (const project of projects) {
      const repoName = path.basename(path.resolve(project.workspaceRoot));
      if (repoName.length > 0) {
        basenameCounts.set(repoName, (basenameCounts.get(repoName) ?? 0) + 1);
      }
    }

    const realWorktreesDir = yield* resolveRoot(config.worktreesDir);
    const entries: Array<ProjectRootEntry> = [];
    const seen = new Set<string>();
    const addEntry = (realRoot: string | null, projectId: ProjectId, kind: ProjectRootKind) => {
      if (realRoot === null) return;
      const key = `${kind}\0${projectId}\0${realRoot}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ realRoot, projectId, kind });
    };

    for (const project of projects) {
      addEntry(yield* resolveRoot(project.workspaceRoot), project.id, "workspaceRoot");
      for (const folder of project.trackedFolders ?? []) {
        addEntry(yield* resolveRoot(folder.path), project.id, "trackedFolder");
      }
      if (realWorktreesDir !== null) {
        addEntry(
          yield* resolveRoot(path.join(realWorktreesDir, project.id)),
          project.id,
          "worktreesDir",
        );
        const repoName = path.basename(path.resolve(project.workspaceRoot));
        if (repoName.length > 0 && basenameCounts.get(repoName) === 1) {
          addEntry(
            yield* resolveRoot(path.join(realWorktreesDir, repoName)),
            project.id,
            "worktreesDir",
          );
        }
      }
    }

    const threadWorktrees = yield* sql<{
      readonly worktreePath: string;
      readonly projectId: string;
    }>`
      SELECT DISTINCT
        json_extract(payload_json, '$.worktreePath') AS "worktreePath",
        project_id AS "projectId"
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.orElseSucceed(
        () => [] as ReadonlyArray<{ readonly worktreePath: string; readonly projectId: string }>,
      ),
    );
    for (const row of threadWorktrees) {
      if (!path.isAbsolute(row.worktreePath)) continue;
      addEntry(yield* resolveRoot(row.worktreePath), ProjectId.make(row.projectId), "worktree");
    }

    const taskFolderRows = yield* sql<{
      readonly root: string;
      readonly projectId: string;
    }>`
      SELECT root, project_id AS "projectId"
      FROM task_folders
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.orElseSucceed(
        () => [] as ReadonlyArray<{ readonly root: string; readonly projectId: string }>,
      ),
    );
    for (const row of taskFolderRows) {
      if (!path.isAbsolute(row.root)) continue;
      addEntry(yield* resolveRoot(row.root), ProjectId.make(row.projectId), "worktree");
    }

    entries.sort(
      (left, right) =>
        right.realRoot.length - left.realRoot.length ||
        ROOT_KIND_PRIORITY[left.kind] - ROOT_KIND_PRIORITY[right.kind],
    );
    return entries;
  });

  const getProjectRoots = Effect.fnUntraced(function* (actor: ProjectAccess.AccessActor) {
    if (actor.accessRevision === undefined) {
      return yield* loadProjectRoots();
    }
    const key = actorCacheKey(actor);
    const cached = rootCache.get(key);
    if (cached !== undefined && cached.revision === actor.accessRevision) {
      return cached.roots;
    }
    const roots = yield* loadProjectRoots();
    if (rootCache.size >= MAX_ROOT_CACHE_ENTRIES && !rootCache.has(key)) {
      const oldestKey = rootCache.keys().next().value;
      if (oldestKey !== undefined) {
        rootCache.delete(oldestKey);
      }
    }
    rootCache.set(key, { revision: actor.accessRevision, roots });
    return roots;
  });

  const checkResolvedPath = Effect.fnUntraced(function* (
    actor: ProjectAccess.AccessActor,
    rawPath: string,
    capability: ProjectCapability,
  ): Effect.fn.Return<ResolvedProjectPath, ProjectForbiddenError> {
    const realPath = yield* resolveTargetPath(rawPath).pipe(
      Effect.mapError(
        (error) =>
          new ProjectForbiddenError({
            message: error.message,
            projectId: ProjectId.make("environment"),
            requiredPermission: "project:read",
          }),
      ),
    );

    if (actor.isOwner || passesProjectChecks(actor.binding)) {
      return { realPath, projectId: undefined };
    }

    const roots = yield* getProjectRoots(actor);
    const matches = roots.filter((entry) => isWithinRoot(path, realPath, entry.realRoot));
    if (matches.length === 0) {
      return yield* new ProjectForbiddenError({
        message: "Path is outside any registered project workspace.",
        projectId: ProjectId.make("environment"),
        requiredPermission: "project:read",
      });
    }

    const longestLength = matches[0]!.realRoot.length;
    const longestMatches = matches.filter((entry) => entry.realRoot.length === longestLength);
    const workspaceRootMatches = longestMatches.filter((entry) => entry.kind === "workspaceRoot");
    const candidates = workspaceRootMatches.length > 0 ? workspaceRootMatches : longestMatches;

    const allowed = candidates.find((entry) =>
      projectAccess.can(actor, entry.projectId, capability),
    );
    if (allowed !== undefined) {
      return { realPath, projectId: allowed.projectId };
    }

    const denied = candidates[0]!;
    return yield* new ProjectForbiddenError({
      message: `Missing required capability ${capability} on project ${denied.projectId}.`,
      projectId: denied.projectId,
      requiredPermission: capability,
    });
  });

  const assertPath: ProjectPaths["Service"]["assertPath"] = Effect.fn("ProjectPaths.assertPath")(
    function* (actor, targetPath, capability) {
      return yield* checkResolvedPath(actor, targetPath, capability);
    },
  );

  const assertCwd: ProjectPaths["Service"]["assertCwd"] = Effect.fn("ProjectPaths.assertCwd")(
    function* (actor, cwd, capability) {
      return yield* checkResolvedPath(actor, cwd, capability);
    },
  );

  return ProjectPaths.of({
    assertPath,
    assertCwd,
  });
});

export const layer = Layer.effect(ProjectPaths, make);
