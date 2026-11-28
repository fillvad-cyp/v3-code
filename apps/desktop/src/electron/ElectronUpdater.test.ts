import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock } = vi.hoisted(() => ({
  autoUpdaterMock: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    fullChangelog: false,
    disableDifferentialDownload: false,
    channel: null as string | null,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  it("does not trigger checks or configure autoUpdater on module import", () => {
    assert.equal(autoUpdaterMock.setFeedURL.mock.calls.length, 0);
    assert.equal(autoUpdaterMock.checkForUpdates.mock.calls.length, 0);
  });

  beforeEach(() => {
    autoUpdaterMock.autoDownload = false;
    autoUpdaterMock.autoInstallOnAppQuit = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.disableDifferentialDownload = false;
    autoUpdaterMock.channel = null;
    autoUpdaterMock.setFeedURL.mockReset();
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null);
    autoUpdaterMock.downloadUpdate.mockReset().mockResolvedValue([]);
    autoUpdaterMock.quitAndInstall.mockReset();
    autoUpdaterMock.on.mockReset();
    autoUpdaterMock.removeListener.mockReset();
  });

  it.effect("configures the GitHub Releases feed and defaults when creating the service", () =>
    Effect.gen(function* () {
      yield* ElectronUpdater.ElectronUpdater;

      assert.isTrue(autoUpdaterMock.autoDownload);
      assert.isTrue(autoUpdaterMock.autoInstallOnAppQuit);
      assert.equal(autoUpdaterMock.setFeedURL.mock.calls.length, 1);
      assert.deepEqual(autoUpdaterMock.setFeedURL.mock.calls[0]?.[0], {
        provider: "github",
        owner: "fillvad-cyp",
        repo: "v3-code",
      });
      assert.equal(autoUpdaterMock.checkForUpdates.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("maps channels and forwards configuration setters to autoUpdater", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setChannel("nightly");
      assert.equal(autoUpdaterMock.channel, "nightly");
      assert.isTrue(autoUpdaterMock.allowPrerelease);

      yield* updater.setChannel("latest");
      assert.equal(autoUpdaterMock.channel, "latest");
      assert.isFalse(autoUpdaterMock.allowPrerelease);

      yield* updater.setAutoDownload(false);
      yield* updater.setAutoInstallOnAppQuit(false);
      yield* updater.setAllowPrerelease(true);
      yield* updater.setAllowDowngrade(true);
      yield* updater.setFullChangelog(true);
      yield* updater.setDisableDifferentialDownload(true);
      yield* updater.setFeedURL({ provider: "generic", url: "https://updates.example.com" });

      assert.isFalse(autoUpdaterMock.autoDownload);
      assert.isFalse(autoUpdaterMock.autoInstallOnAppQuit);
      assert.isTrue(autoUpdaterMock.allowPrerelease);
      assert.isTrue(yield* updater.allowDowngrade);
      assert.isTrue(autoUpdaterMock.fullChangelog);
      assert.isTrue(autoUpdaterMock.disableDifferentialDownload);
      assert.deepEqual(autoUpdaterMock.setFeedURL.mock.calls[1]?.[0], {
        provider: "generic",
        url: "https://updates.example.com",
      });
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect(
    "delegates checkForUpdates and wraps failures in ElectronUpdaterCheckForUpdatesError",
    () =>
      Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.setChannel("latest");

        yield* updater.checkForUpdates;
        assert.equal(autoUpdaterMock.checkForUpdates.mock.calls.length, 1);

        const cause = new Error("network timeout");
        autoUpdaterMock.checkForUpdates.mockRejectedValueOnce(cause);
        const exit = yield* Effect.exit(updater.checkForUpdates);

        assert.equal(exit._tag, "Failure");
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause);
          assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
          assert.equal(error.channel, "latest");
          assert.strictEqual(error.cause, cause);
        }
      }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect(
    "delegates downloadUpdate and wraps failures in ElectronUpdaterDownloadUpdateError",
    () =>
      Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.setChannel("nightly");

        yield* updater.downloadUpdate;
        assert.equal(autoUpdaterMock.downloadUpdate.mock.calls.length, 1);

        const cause = new Error("checksum mismatch");
        autoUpdaterMock.downloadUpdate.mockRejectedValueOnce(cause);
        const exit = yield* Effect.exit(updater.downloadUpdate);

        assert.equal(exit._tag, "Failure");
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause);
          assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
          assert.equal(error.channel, "nightly");
          assert.strictEqual(error.cause, cause);
        }
      }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect(
    "forwards quitAndInstall flags and wraps failures in ElectronUpdaterQuitAndInstallError",
    () =>
      Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.setChannel("latest");

        yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: false });
        assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls[0], [true, false]);

        const cause = new Error("installer launch failed");
        autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
          throw cause;
        });
        const exit = yield* Effect.exit(
          updater.quitAndInstall({ isSilent: false, isForceRunAfter: true }),
        );

        assert.equal(exit._tag, "Failure");
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause);
          assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
          assert.equal(error.channel, "latest");
          assert.isFalse(error.isSilent);
          assert.isTrue(error.isForceRunAfter);
          assert.strictEqual(error.cause, cause);
        }
      }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("subscribes to autoUpdater events and unsubscribes when the scope closes", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      const listener = vi.fn();
      const scope = yield* Scope.make();

      yield* updater.on("update-available", listener).pipe(Scope.provide(scope));
      assert.equal(autoUpdaterMock.on.mock.calls.length, 1);
      assert.deepEqual(autoUpdaterMock.on.mock.calls[0], ["update-available", listener]);
      assert.equal(autoUpdaterMock.removeListener.mock.calls.length, 0);

      yield* Scope.close(scope, Exit.void);
      assert.equal(autoUpdaterMock.removeListener.mock.calls.length, 1);
      assert.deepEqual(autoUpdaterMock.removeListener.mock.calls[0], [
        "update-available",
        listener,
      ]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
