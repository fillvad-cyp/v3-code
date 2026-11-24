import {
  type AuthClientPresentationMetadata,
  ServerPrepareTriageError,
  type ServerPrepareTriageInput,
  type ServerPrepareTriageResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { buildTriageAppPrompt, type TriageSourceClone } from "./triagePrompt.ts";
import { writeTriageSession } from "./triageSession.ts";

/** Starts in-app local diagnostic triage sessions without cloning upstream repos. */
export class TriageService extends Context.Service<
  TriageService,
  {
    readonly prepare: (
      input: ServerPrepareTriageInput,
    ) => Effect.Effect<ServerPrepareTriageResult, ServerPrepareTriageError>;
  }
>()("v3code/triage/TriageService") {}

const describeClient = (client: AuthClientPresentationMetadata) =>
  [
    client.label ?? "an unknown client",
    client.appVersion === undefined ? undefined : `version ${client.appVersion}`,
    client.os === undefined ? undefined : `on ${client.os}`,
    client.browser === undefined ? undefined : `in ${client.browser}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");

export const pickSourceRef = (lsRemoteOutput: string, version: string) => {
  const commits = new Map(
    lsRemoteOutput
      .split("\n")
      .map((line) => line.trim().split("\t"))
      .filter((fields): fields is [string, string] => fields.length === 2)
      .map(([commit, ref]) => [ref, commit]),
  );
  const tag = `v${version}`;
  const tagCommit = commits.get(`refs/tags/${tag}^{}`) ?? commits.get(`refs/tags/${tag}`);
  if (tagCommit !== undefined) return { ref: tag, commit: tagCommit };
  const mainCommit = commits.get("refs/heads/main");
  return mainCommit === undefined ? undefined : { ref: "main", commit: mainCommit };
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverVersion = packageJson.version;

  const prepare: TriageService["Service"]["prepare"] = Effect.fn("TriageService.prepare")(
    function* (input) {
      const sourceClone: TriageSourceClone = {
        _tag: "failed",
        serverVersion,
        reason: "Remote upstream source cloning is disabled in V3 Code.",
      };
      const session = yield* writeTriageSession({
        baseDir: config.baseDir,
        paths: config,
        entry: { kind: "app", client: describeClient(input.client) },
        server: `running (pid ${String(process.pid)}, version ${serverVersion}); this session runs inside it`,
        sourceClone,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) => new ServerPrepareTriageError({ cause })),
      );
      return { prompt: buildTriageAppPrompt(session.promptFilePath) };
    },
  );

  return TriageService.of({ prepare });
});

export const layer = Layer.effect(TriageService, make);
