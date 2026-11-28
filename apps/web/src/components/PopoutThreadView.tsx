import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useEffect, useState } from "react";

import ChatView from "./ChatView";
import { useOpenThreadFamily } from "./ThreadRouteView";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Skeleton } from "./ui/skeleton";
import {
  invalidatePrimaryAuthGateCache,
  resolveInitialServerAuthGateState,
} from "../environments/primary";
import {
  buildThreadPopoutRoutePath,
  clearPersistedPopoutAuthSession,
  markPersistedPopoutAuthSession,
  readCachedPopoutThreadMeta,
  startPopoutWindowLifecycle,
  writeCachedPopoutThreadMeta,
} from "../lib/threadPopout";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useProject, useQuietThreadShell } from "../state/entities";
import { environmentUnreachableAtom } from "../state/presentation";
import { useEnvironmentShellStatus } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
import { isThreadRouteSnapshotAuthoritative, resolveThreadRouteRenderState } from "../threadRoutes";

interface PopoutThreadViewProps {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId | null;
  readonly authGateStatus: string;
  readonly hasStoredSession: boolean;
}

function buildPopoutRedirectTarget(
  threadId: ThreadId,
  environmentId: EnvironmentId | null,
): string {
  if (environmentId !== null) {
    return buildThreadPopoutRoutePath(scopeThreadRef(environmentId, threadId));
  }
  return `/popout/thread/${encodeURIComponent(threadId)}`;
}

function PopoutThreadSkeleton({
  title,
  projectTitle,
}: {
  readonly title: string | null;
  readonly projectTitle: string | null;
}) {
  const gt = useGT();
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      data-popout-skeleton="root"
      role="status"
      aria-busy="true"
      aria-label={title ?? gt("Loading")}
    >
      <header
        data-popout-skeleton="header"
        className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border/50 px-5"
      >
        {projectTitle ? (
          <span className="truncate text-xs text-muted-foreground">{projectTitle}</span>
        ) : null}
        {projectTitle && title ? (
          <span aria-hidden className="text-xs text-muted-foreground/60">
            /
          </span>
        ) : null}
        {title ? (
          <h1 className="truncate text-sm font-medium text-foreground" data-popout-cached-title="">
            {title}
          </h1>
        ) : (
          <Skeleton shape="pill" className="h-4 w-48" />
        )}
      </header>

      <div
        data-popout-skeleton="messages"
        className="mx-auto flex min-h-0 w-full max-w-[var(--chat-content-max-width)] flex-1 flex-col gap-5 px-5 py-6"
        aria-hidden="true"
      >
        <div className="flex flex-col items-end gap-2">
          <Skeleton shape="card" className="h-10 w-3/5 max-w-md" />
        </div>
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-3.5 w-2/5" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
        <div className="flex flex-col items-end gap-2 pt-2">
          <Skeleton shape="card" className="h-9 w-2/5 max-w-sm" />
        </div>
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-3.5 w-5/6" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      </div>

      <div
        data-popout-skeleton="composer"
        className="mx-auto w-full max-w-[var(--chat-content-max-width)] shrink-0 px-5 pb-5"
        aria-hidden="true"
      >
        <Skeleton shape="card" className="h-20 w-full" />
      </div>
    </div>
  );
}

export function PopoutThreadView({
  threadId,
  environmentId,
  authGateStatus,
  hasStoredSession,
}: PopoutThreadViewProps) {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const resolvedEnvironmentId = environmentId ?? primaryEnvironmentId;
  const threadRef: ScopedThreadRef | null =
    resolvedEnvironmentId !== null ? scopeThreadRef(resolvedEnvironmentId, threadId) : null;
  const threadKey = threadRef !== null ? scopedThreadKey(threadRef) : null;

  const [cachedMeta] = useState(() => readCachedPopoutThreadMeta(threadRef, threadId));
  const serverThreadShell = useQuietThreadShell(threadRef);
  const projectRef =
    serverThreadShell !== null
      ? scopeProjectRef(serverThreadShell.environmentId, serverThreadShell.projectId)
      : null;
  const project = useProject(projectRef);
  const shellStatus = useEnvironmentShellStatus(resolvedEnvironmentId);
  const environmentUnreachable = useAtomValue(environmentUnreachableAtom(resolvedEnvironmentId));
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);

  const unlistedThreadRef = threadRef !== null && serverThreadShell === null ? threadRef : null;
  const unlistedThreadDetail = useEnvironmentThread(
    unlistedThreadRef?.environmentId ?? null,
    unlistedThreadRef?.threadId ?? null,
  );
  useOpenThreadFamily(threadRef, bootstrapComplete && unlistedThreadRef !== null);

  const renderState =
    threadRef === null
      ? "loading"
      : resolveThreadRouteRenderState({
          bootstrapComplete,
          serverThreadExists: serverThreadShell !== null,
          serverThreadDeleted: serverThreadShell?.deletedAt != null,
          unlistedThreadDetail,
          draftThreadExists: false,
          environmentUnreachable,
        });

  const redirectTarget = buildPopoutRedirectTarget(threadId, resolvedEnvironmentId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- validates persisted auth in the background after immediate skeleton paint and redirects only if authentication is required
  useEffect(() => {
    if (authGateStatus !== "popout-rehydrating") return;
    let cancelled = false;
    void resolveInitialServerAuthGateState().then(
      (result) => {
        if (cancelled) return;
        if (result.status === "authenticated") {
          markPersistedPopoutAuthSession();
          return;
        }
        clearPersistedPopoutAuthSession();
        if (result.auth.authMode === "multi-user") {
          void navigate({
            to: "/login",
            search: { redirect: redirectTarget },
            replace: true,
          });
          return;
        }
        void navigate({ to: "/pair", replace: true });
      },
      () => {
        // Keep the rehydrated popout open if transient connectivity fails with a stored session.
        if (!cancelled && !hasStoredSession) {
          void navigate({ to: "/pair", replace: true });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authGateStatus, hasStoredSession, navigate, redirectTarget]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the popout window to opener focus-return and main-window sign-out signals
  useEffect(() => {
    return startPopoutWindowLifecycle({
      threadKey,
      environmentId: resolvedEnvironmentId,
      onSignOut: () => {
        invalidatePrimaryAuthGateCache();
        clearPersistedPopoutAuthSession();
        window.close();
        if (!window.closed) {
          void navigate({
            to: "/login",
            search: { redirect: redirectTarget },
            replace: true,
          });
        }
      },
    });
  }, [navigate, redirectTarget, resolvedEnvironmentId, threadKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- updates the localStorage title cache whenever the thread shell resolves so future reloads paint the latest title immediately
  useEffect(() => {
    if (threadRef === null || serverThreadShell === null) return;
    writeCachedPopoutThreadMeta(threadRef, {
      title: serverThreadShell.title,
      projectTitle: project?.isScratch ? undefined : project?.title,
    });
  }, [project?.isScratch, project?.title, serverThreadShell, threadRef]);

  const cachedTitle = serverThreadShell?.title ?? cachedMeta?.title ?? null;
  const cachedProjectTitle =
    (project?.isScratch ? null : project?.title) ?? cachedMeta?.projectTitle ?? null;

  let content: React.ReactNode;
  if (
    resolvedEnvironmentId !== null &&
    (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null))
  ) {
    content = (
      <ChatView environmentId={resolvedEnvironmentId} threadId={threadId} routeKind="server" />
    );
  } else if (renderState === "unreachable" || renderState === "missing") {
    content = (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>
            <T>Thread unavailable</T>
          </EmptyTitle>
          <EmptyDescription>
            <T>This thread is on an environment this app is not connected to.</T>
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={() => window.close()}>
            <T>Close</T>
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    content = <PopoutThreadSkeleton title={cachedTitle} projectTitle={cachedProjectTitle} />;
  }

  return (
    <main
      className="relative flex h-svh min-h-0 w-full flex-1 flex-col overflow-hidden overscroll-y-none bg-background surface-grain md:h-dvh"
      data-popout-shell="true"
      data-popout-thread-id={threadId}
    >
      {content}
    </main>
  );
}
