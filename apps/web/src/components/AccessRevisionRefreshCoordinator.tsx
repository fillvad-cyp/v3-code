import { AuthAccessReadScope, type EnvironmentId } from "@t3tools/contracts";

import { useSyncAccessRevision } from "../state/accessRevision";
import { useEnvironments } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { supportsMembersCapability } from "./settings/MembersSettings.logic";

/** Refreshes session and member caches whenever a multi-user environment's access revision advances. */
export function AccessRevisionRefreshCoordinator() {
  const { environments } = useEnvironments();
  return environments.map((environment) =>
    environment.connection.phase === "connected" &&
    supportsMembersCapability(environment.serverConfig?.environment.capabilities) ? (
      <EnvironmentAccessRevisionSync
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    ) : null,
  );
}

function EnvironmentAccessRevisionSync({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const canReadAccess = useEnvironmentScope(environmentId, AuthAccessReadScope);
  useSyncAccessRevision(environmentId, canReadAccess);
  return null;
}
