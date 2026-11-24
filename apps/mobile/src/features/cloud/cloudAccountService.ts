import {
  type CloudAccountSource,
  createCloudAccountService,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";

import { appAtomRegistry } from "../../state/atom-registry";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";
import { clearConnectOnboardingRequest } from "./connectOnboarding";

interface DisabledCloudAuthSource extends CloudAccountSource {
  readonly session?: {
    readonly getToken: (options?: unknown) => Promise<string | null>;
  } | null;
}

export function deactivateCloudRelayAccount(): void {
  setAgentAwarenessRelayTokenProvider(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateCloudRelayAccount(
  _accountId: string,
  _tokenProvider: () => Promise<string | null>,
): void {
  deactivateCloudRelayAccount();
}

export const cloudAccountService = createCloudAccountService<DisabledCloudAuthSource>({
  deactivate: deactivateCloudRelayAccount,
  detach: deactivateCloudRelayAccount,
  onSignOutTransition: clearConnectOnboardingRequest,
  cleanUp: async () => undefined,
  prepare: async () => undefined,
  activate: () => {
    deactivateCloudRelayAccount();
  },
});
