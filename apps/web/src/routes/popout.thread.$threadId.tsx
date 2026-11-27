import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { PopoutThreadView } from "../components/PopoutThreadView";

interface PopoutThreadRouteSearch {
  readonly env?: EnvironmentId;
}

function parseOptionalEnv(value: unknown): EnvironmentId | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? EnvironmentId.make(value.trim())
    : undefined;
}

export const Route = createFileRoute("/popout/thread/$threadId")({
  validateSearch: (search: Record<string, unknown>): PopoutThreadRouteSearch => {
    const env = parseOptionalEnv(search.env);
    return env !== undefined ? { env } : {};
  },
  component: PopoutThreadRouteView,
});

function PopoutThreadRouteView() {
  const { threadId } = Route.useParams();
  const { env } = Route.useSearch();
  const { authGateState } = Route.useRouteContext();
  const hasStoredSession =
    authGateState.status === "authenticated" ||
    authGateState.status === "hosted-static" ||
    (authGateState.status === "popout-rehydrating" && authGateState.hasStoredSession);

  return (
    <PopoutThreadView
      threadId={ThreadId.make(threadId)}
      environmentId={env ?? null}
      authGateStatus={authGateState.status}
      hasStoredSession={hasStoredSession}
    />
  );
}
