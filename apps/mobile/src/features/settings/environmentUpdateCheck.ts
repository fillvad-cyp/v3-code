import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

export interface EnvironmentReleaseCheck {
  readonly fromVersion: string;
  readonly targetVersion: string | null;
}

export class EnvironmentUpdateCheckError extends Schema.TaggedError<EnvironmentUpdateCheckError>()(
  "EnvironmentUpdateCheckError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** V3 Code: upstream release lookups are disabled; zero outbound HTTP calls. */
export const environmentReleaseCheckAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.fn((readServerVersion: () => Promise<string>) =>
    Effect.gen(function* () {
      const fromVersion = yield* Effect.tryPromise({
        try: readServerVersion,
        catch: (cause) =>
          new EnvironmentUpdateCheckError({
            message: cause instanceof Error ? cause.message : "Could not read server version.",
            cause,
          }),
      });
      return { fromVersion, targetVersion: null } satisfies EnvironmentReleaseCheck;
    }),
  ).pipe(Atom.withLabel(`mobile:environment-release-check:${environmentId}`)),
);

export function releaseCheckValue(
  result: AsyncResult.AsyncResult<EnvironmentReleaseCheck, Error>,
): EnvironmentReleaseCheck | null {
  return AsyncResult.getOrElse(result, () => null);
}

export function releaseCheckError(
  _result: AsyncResult.AsyncResult<EnvironmentReleaseCheck, Error>,
): string | null {
  return null;
}
