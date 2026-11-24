import { setManagedRelaySession } from "@t3tools/client-runtime/relay";
import type { ReactNode } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  _accountId: string,
  _readClerkToken: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  return children;
}
