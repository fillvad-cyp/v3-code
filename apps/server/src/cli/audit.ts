import { AuditChainVerificationResult } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const encodeVerificationResult = Schema.encodeEffect(
  Schema.fromJsonString(AuditChainVerificationResult),
);

class AuditChainBrokenError extends Schema.TaggedError<AuditChainBrokenError>()(
  "AuditChainBrokenError",
  {
    firstBrokenId: Schema.NullOr(Schema.Number),
    reason: Schema.NullOr(Schema.String),
    checked: Schema.Number,
  },
) {
  override get message(): string {
    return `Audit hash chain verification failed at event id ${this.firstBrokenId ?? "unknown"} (${this.reason ?? "unknown"}).`;
  }
}

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const auditVerifyCommand = Command.make("verify", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Walk the audit_events SHA-256 hash chain and verify its integrity."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const result = yield* Effect.flatMap(
        AuditEvents.AuditEventRepository,
        (repo) => repo.verifyChain,
      ).pipe(
        Effect.provide(
          AuditEvents.layer.pipe(
            Layer.provide(SqlitePersistence.layerCliConfig),
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );

      if (flags.json) {
        yield* Console.log(yield* encodeVerificationResult(result));
      } else if (result.valid) {
        yield* Console.log(`Audit hash chain OK (${result.checked} events verified).`);
      } else {
        yield* Console.log(
          `Audit hash chain broken at event id ${result.firstBrokenId} (${result.reason}, ${result.checked} events verified before failure).`,
        );
      }

      if (!result.valid) {
        return yield* new AuditChainBrokenError({
          firstBrokenId: result.firstBrokenId,
          reason: result.reason,
          checked: result.checked,
        });
      }
    }),
  ),
);

export const auditCommand = Command.make("audit").pipe(
  Command.withDescription("Inspect and verify the server audit log."),
  Command.withSubcommands([auditVerifyCommand]),
);
