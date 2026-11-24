import type { ManagedUpdatesMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export interface UpdatePolicy {
  readonly mode: ManagedUpdatesMode;
  readonly feedUrl: string | undefined;
  readonly allowNightly: boolean;
  readonly message: string | null;
}

export class DesktopUpdatePolicy extends Context.Service<DesktopUpdatePolicy, UpdatePolicy>()(
  "@t3tools/desktop/updates/DesktopUpdatePolicy",
) {}

export const unmanagedUpdatePolicy: UpdatePolicy = {
  mode: "off",
  feedUrl: undefined,
  allowNightly: false,
  message: "Automatic updates are disabled in V3 Code.",
};

export const layer = Layer.succeed(DesktopUpdatePolicy, unmanagedUpdatePolicy);

export const layerTest = (policy: UpdatePolicy = unmanagedUpdatePolicy) =>
  Layer.succeed(DesktopUpdatePolicy, policy);
