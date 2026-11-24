import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

/** V3 Code: remote upstream server updates are permanently disabled. */
export function supportsEnvironmentUpdate(
  _capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
) {
  return false;
}

export function canUpdateEnvironmentProvider(_provider: ServerProvider) {
  return false;
}

export async function findEnvironmentUpdate(
  _currentVersion: string,
  _signal: AbortSignal,
): Promise<string | null> {
  return null;
}
