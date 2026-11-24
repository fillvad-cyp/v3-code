import { useState, type ReactNode } from "react";

export const T3_CONNECT_ACCOUNT_PAGES = [] as const;

export type T3ConnectAccountPageUrl = "mobile-clients" | "t3-connect" | "t3-chat";

const DISABLED_ACCOUNT_PAGE: {
  readonly open: ((page?: T3ConnectAccountPageUrl) => void) | null;
  readonly portals: ReactNode;
} = { open: null, portals: null };

export function useT3ConnectAccountPage() {
  const [page] = useState(DISABLED_ACCOUNT_PAGE);
  return page;
}
