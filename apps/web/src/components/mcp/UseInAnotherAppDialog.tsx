import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Dialog } from "../ui/dialog";
import { WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";

const requestAtom = Atom.make<{ readonly environmentId: EnvironmentId | null } | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mcp:use-in-another-app"),
);

export function openUseInAnotherApp(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(requestAtom, { environmentId });
}

const close = () => appAtomRegistry.set(requestAtom, null);

export function UseInAnotherAppDialogHost() {
  const request = useAtomValue(requestAtom);
  return request === null ? null : <UseInAnotherAppDialog requested={request.environmentId} />;
}

function UseInAnotherAppDialog({ requested }: { readonly requested: EnvironmentId | null }) {
  const { label } = useAccessEnvironment(requested);
  const gt = useGT();
  const title = `${gt("Use V3 Code in another app (MCP)")} · ${label ?? "V3 Code"}`;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <WizardPopup>
        <WizardHeader title={title} />
        <WizardPanel>
          <section className="space-y-2">
            <h3 className="text-base font-medium">
              {gt("Cloud relay MCP onboarding is disabled in V3 Code.")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {gt(
                "Connect local or Tailscale MCP clients directly to your V3 Code server endpoint instead.",
              )}
            </p>
          </section>
        </WizardPanel>
      </WizardPopup>
    </Dialog>
  );
}
