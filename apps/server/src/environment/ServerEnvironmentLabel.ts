// V3 Code does not leak real hostnames, machine names, or WSL distro names by default.
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

interface ResolveServerEnvironmentLabelInput {
  readonly cwdBaseName: string;
}

const ServerEnvironmentLabelCommandProbe = Schema.Literals([
  "macos-computer-name",
  "linux-pretty-hostname",
]);
type ServerEnvironmentLabelCommandProbe = typeof ServerEnvironmentLabelCommandProbe.Type;

export class ServerEnvironmentLabelFileError extends Schema.TaggedError<ServerEnvironmentLabelFileError>()(
  "ServerEnvironmentLabelFileError",
  {
    operation: Schema.Literals(["inspect", "read"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} environment-label file at ${this.path}.`;
  }
}

export class ServerEnvironmentLabelCommandError extends Schema.TaggedError<ServerEnvironmentLabelCommandError>()(
  "ServerEnvironmentLabelCommandError",
  {
    probe: ServerEnvironmentLabelCommandProbe,
    executable: Schema.String,
    argumentCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to run environment-label probe '${this.probe}' with ${this.executable}.`;
  }
}

function normalizeLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

const labelOverride = Config.String("V3CODE_ENVIRONMENT_LABEL").pipe(
  Config.option,
  Config.map(Option.flatMap((label) => Option.fromNullishOr(normalizeLabel(label)))),
);

export const resolveServerEnvironmentLabel = Effect.fn("resolveServerEnvironmentLabel")(function* (
  _input: ResolveServerEnvironmentLabelInput,
) {
  const override = yield* labelOverride.pipe(Effect.orElseSucceed(() => Option.none<string>()));
  if (Option.isSome(override)) {
    return override.value;
  }
  return "V3 Code";
});
