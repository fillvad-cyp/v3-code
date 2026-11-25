import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { I18nProvider } from "./i18n/I18nProvider";
import { isPopoutWindowRuntime } from "./lib/threadPopout";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  const isPopoutWindow = isPopoutWindowRuntime();
  return (
    <I18nProvider>
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
        {!isPopoutWindow ? <ElectronBrowserHost /> : null}
        <QuitHoldOverlay />
      </AppAtomRegistryProvider>
    </I18nProvider>
  );
}
