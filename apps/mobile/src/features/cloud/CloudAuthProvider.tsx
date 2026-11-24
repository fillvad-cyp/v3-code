import type { ReactNode } from "react";

import { deactivateCloudRelayAccount } from "./cloudAccountService";

// V3 Code: Clerk cloud authentication is permanently removed.
deactivateCloudRelayAccount();

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  return props.children;
}
