import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import {
  SecretProviderId,
  isProjectSecretReference,
  type SecretReference,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ProjectSecrets from "../project/ProjectSecrets.ts";
import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "./secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";

export const PROJECT_SECRET_PROVIDER_ID = SecretProviderId.make("project");

/**
 * Actor used when resolving `secret://project/<projectId>/<name>` references through
 * `SecretResolver`. Defaults to `undefined` (fail-closed) so unscoped callers cannot read
 * project secrets accidentally.
 */
export const SecretResolutionActor = Context.Reference<ProjectAccess.AccessActor | undefined>(
  "v3code/secrets/SecretResolutionActor",
  { defaultValue: () => undefined },
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    const projectSecretsOption = yield* Effect.serviceOption(ProjectSecrets.ProjectSecrets);
    const coreLayer = SecretResolverCore.layer({
      drivers: BUILT_IN_SECRET_PROVIDER_DRIVER_LIST,
      secretProviders: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.secretProviders),
        Effect.orElseSucceed((): ServerSettings["secretProviders"] => ({})),
      ),
    });

    return Layer.effect(
      SecretResolverCore.SecretResolver,
      Effect.gen(function* () {
        const core = yield* SecretResolverCore.SecretResolver;

        const read: SecretResolverCore.SecretResolver["Service"]["read"] = Effect.fn(
          "ServerSecretResolver.read",
        )(function* (references, options) {
          const projectIndices: Array<{ readonly index: number; readonly reference: string }> = [];
          const externalIndices: Array<number> = [];
          const externalRefs: Array<SecretReference> = [];

          references.forEach((entry, index) => {
            if (isProjectSecretReference(entry.reference)) {
              projectIndices.push({ index, reference: entry.reference });
            } else {
              externalIndices.push(index);
              externalRefs.push(entry);
            }
          });

          if (projectIndices.length === 0) {
            return yield* core.read(references, options);
          }

          const results: Array<string | undefined> = Array.from(
            { length: references.length },
            () => undefined,
          );

          if (externalRefs.length > 0) {
            const externalValues = yield* core.read(externalRefs, options);
            externalIndices.forEach((targetIndex, externalIndex) => {
              results[targetIndex] = externalValues[externalIndex];
            });
          }

          const actor = yield* SecretResolutionActor;
          if (actor === undefined || Option.isNone(projectSecretsOption)) {
            return results;
          }

          const projectSecrets = projectSecretsOption.value;
          for (const entry of projectIndices) {
            const resolved = yield* projectSecrets
              .resolveReference({ reference: entry.reference, actor })
              .pipe(Effect.orElseSucceed(() => undefined));
            results[entry.index] = resolved;
          }

          return results;
        });

        const label: SecretResolverCore.SecretResolver["Service"]["label"] = (provider) =>
          provider === PROJECT_SECRET_PROVIDER_ID
            ? Effect.succeed("Project secrets")
            : core.label(provider);

        return SecretResolverCore.SecretResolver.of({
          read,
          invalidate: core.invalidate,
          label,
        });
      }),
    ).pipe(Layer.provide(coreLayer));
  }),
);
