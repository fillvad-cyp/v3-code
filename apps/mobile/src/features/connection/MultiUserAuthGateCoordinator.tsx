import { useAtomValue } from "@effect/atom-react";
import { fetchRemoteSessionState } from "@t3tools/client-runtime/authorization";
import {
  AVAILABLE_CONNECTION_STATE,
  type EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { rootNavigationRef } from "../../lib/rootNavigation";
import * as Runtime from "../../lib/runtime";
import { useEnvironments } from "../../state/environments";
import {
  resolveAuthBlockedBearerTarget,
  shouldPromptMultiUserLogin,
} from "./EnvironmentLoginScreen.logic";

// Tracks environments we already presented the login sheet for during the current auth refusal,
// so dismissing the sheet does not re-open it in a loop until the connection changes or reconnects.
const promptedRefusals = new Map<string, string>();

/**
 * Watches saved environments for 401 credential refusals. When a remote host answers 401 and
 * advertises `authMode === "multi-user"`, presents the native one-time-code login screen.
 */
export function MultiUserAuthGateCoordinator() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) => (
        <MultiUserAuthWatcher key={environment.environmentId} presentation={environment} />
      ))}
    </>
  );
}

function MultiUserAuthWatcher({
  presentation,
}: {
  readonly presentation: EnvironmentPresentation;
}) {
  const connectionState = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.stateAtom(presentation.entry.target.environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const blocked = resolveAuthBlockedBearerTarget({
    entry: presentation.entry,
    state: connectionState,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes /api/auth/session once on a 401 credential refusal and presents the login screen when authMode is multi-user
  useEffect(() => {
    const environmentId = presentation.entry.target.environmentId;
    if (blocked === null) {
      if (connectionState.phase === "connected" || !presentation.entry.enabled) {
        promptedRefusals.delete(environmentId);
      }
      return;
    }

    const refusalKey = `${blocked.httpBaseUrl}:${connectionState.lastFailure?.detail ?? ""}`;
    if (promptedRefusals.get(environmentId) === refusalKey) {
      return;
    }

    let cancelled = false;
    void Runtime.runtime
      .runPromise(
        fetchRemoteSessionState({ httpBaseUrl: blocked.httpBaseUrl }).pipe(
          Effect.orElseSucceed(() => null),
        ),
      )
      .then((session) => {
        if (cancelled || session === null) return;
        const alreadyPrompted = promptedRefusals.get(environmentId) === refusalKey;
        if (!shouldPromptMultiUserLogin({ session, alreadyPrompted })) return;
        promptedRefusals.set(environmentId, refusalKey);
        if (!rootNavigationRef.isReady()) return;
        const current = rootNavigationRef.getCurrentRoute();
        if (current?.name === "EnvironmentLogin") return;
        rootNavigationRef.navigate("EnvironmentLogin", {
          host: blocked.httpBaseUrl,
          environmentId: blocked.environmentId,
          label: blocked.label,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    blocked,
    connectionState.lastFailure?.detail,
    connectionState.phase,
    presentation.entry.enabled,
    presentation.entry.target.environmentId,
  ]);

  return null;
}
