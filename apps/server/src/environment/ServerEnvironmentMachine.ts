// V3 Code avoids hardware/chassis/VM fingerprinting (ioreg, sysctl, DMI, /proc).
import { EnvironmentMachineKind } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const machineKindOverride = Config.schema(
  EnvironmentMachineKind,
  "V3CODE_ENVIRONMENT_MACHINE_KIND",
).pipe(Config.option);

export const detectServerEnvironmentMachineKind = Effect.fn("detectServerEnvironmentMachineKind")(
  function* () {
    const override = yield* machineKindOverride.pipe(
      Effect.orElseSucceed(() => Option.none<EnvironmentMachineKind>()),
    );
    return Option.isSome(override) ? override.value : null;
  },
);
