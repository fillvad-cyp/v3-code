import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { useCloudLinkState } from "./cloudLinkState";

export interface CloudLinkDesiredState {
  readonly managedTunnel: boolean;
  readonly publish: boolean;
  readonly holdWebhooksWhileOffline?: boolean;
}

export function useCloudLinkController(environmentId: EnvironmentId | null) {
  const gt = useGT();
  const cloudLinkState = useCloudLinkState(environmentId);
  const [operationError, setOperationError] = useState<string | null>(null);

  const reconcileCloudState = async (_desired: CloudLinkDesiredState): Promise<boolean> => {
    setOperationError(gt("Cloud relay is disabled in V3 Code."));
    return false;
  };

  return {
    isSignedIn: false as boolean | undefined,
    linkState: cloudLinkState,
    linked: false,
    linkRevoked: false,
    managedTunnelActive: false,
    managedTunnelOutOfSync: false,
    publishAgentActivity: false,
    holdWebhooksWhileOffline: false,
    operationError,
    tunnelLimit: null as number | null,
    needsRelayConfiguration: (_desired: CloudLinkDesiredState) => false,
    reconcileCloudState,
  };
}
