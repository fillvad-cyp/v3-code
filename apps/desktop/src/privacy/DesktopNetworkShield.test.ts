import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

type BeforeRequestListener = (
  details: { readonly url: string },
  callback: (response: { cancel?: boolean }) => void,
) => void;

const { setProxyMock, closeAllConnectionsMock, listeners } = vi.hoisted(() => ({
  setProxyMock: vi.fn(async () => undefined),
  closeAllConnectionsMock: vi.fn(async () => undefined),
  listeners: [] as BeforeRequestListener[],
}));

vi.mock("electron", () => ({
  app: {
    isReady: () => true,
    whenReady: async () => undefined,
  },
  session: {
    defaultSession: {
      setProxy: setProxyMock,
      closeAllConnections: closeAllConnectionsMock,
      webRequest: {
        onBeforeRequest: vi.fn((_filter: unknown, listener: BeforeRequestListener) => {
          listeners.push(listener);
        }),
      },
    },
  },
}));

import * as DesktopNetworkShield from "./DesktopNetworkShield.ts";

describe("DesktopNetworkShield", () => {
  it.effect(
    "monitors egress hosts, enforces allowlist/kill-switch, and applies live Chromium proxy",
    () =>
      Effect.gen(function* () {
        setProxyMock.mockClear();

        const shield = yield* DesktopNetworkShield.DesktopNetworkShield;
        const listener = listeners.at(-1);
        assert.isDefined(listener);

        yield* shield.setEgressPolicy({
          mode: "allowlist",
          allowlist: ["api.anthropic.com"],
          blocklist: [],
          killSwitchActive: false,
        });

        const decisions: boolean[] = [];
        listener!({ url: "https://api.anthropic.com/v1/messages" }, (res) =>
          decisions.push(res.cancel === true),
        );
        listener!({ url: "https://tracker.example.com/pixel" }, (res) =>
          decisions.push(res.cancel === true),
        );
        listener!({ url: "http://127.0.0.1:3773/api/privacy/vault" }, (res) =>
          decisions.push(res.cancel === true),
        );

        assert.deepEqual(decisions, [false, true, false]);

        const state = yield* shield.applyProxy("socks5h://user:pass@127.0.0.1:9050");
        assert.equal(state.activeProxyDisplay, "socks5h://127.0.0.1:9050");
        assert.equal(state.events.length, 2);
        assert.equal(setProxyMock.mock.calls.length, 1);
        assert.equal(closeAllConnectionsMock.mock.calls.length, 1);

        const cleared = yield* shield.clearLog;
        assert.equal(cleared.events.length, 0);
      }).pipe(Effect.provide(DesktopNetworkShield.layer)),
  );
});
