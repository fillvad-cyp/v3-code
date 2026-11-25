import { DesktopAppActivationResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopAppActivation from "../../app/DesktopAppActivation.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const isMainWindowSender = Effect.fn("desktop.ipc.appActivation.isMainWindowSender")(function* (
  event?: DesktopIpc.DesktopIpcInvokeEvent,
) {
  if (event === undefined) return true;
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  return Option.isSome(main) && main.value.webContents.id === event.sender.id;
});

export const setReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.setReady")(function* (ready, event) {
    if (!(yield* isMainWindowSender(event))) return;
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.setRendererReady(ready);
  }),
});

export const complete = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_COMPLETE_CHANNEL,
  payload: DesktopAppActivationResponse,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.complete")(function* (response, event) {
    if (!(yield* isMainWindowSender(event))) return;
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.complete(response);
  }),
});
