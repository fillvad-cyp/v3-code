import { useNavigate } from "@tanstack/react-router";
import { type PromptCostMode, type ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { pickModelSelection } from "@t3tools/shared/model";
import { msg, T, useGT, useMessages } from "gt-react";

import {
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useTextGenerationTargets } from "../../textGenerators";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const MODE_OPTIONS: Record<PromptCostMode, { label: string; description: string }> = {
  off: {
    label: msg("Off"),
    description: msg("Do not estimate prompt cost in the composer."),
  },
  suggest: {
    label: msg("Suggest"),
    description: msg(
      "Show predicted prompt cost and suggest cheaper models when a simpler model fits.",
    ),
  },
  auto: {
    label: msg("Auto"),
    description: msg(
      "Show predicted prompt cost and switch to a cheaper model automatically when evidence is strong.",
    ),
  },
};

/** The Providers panel can render without a settings scope, as its tests do; this section needs one. */
export function PromptCostSettings() {
  return useOptionalSettingsScope() === null ? null : <ScopedPromptCostSettings />;
}

function ScopedPromptCostSettings() {
  const messages = useMessages();
  const setting = useSearchableSetting();
  const gt = useGT();
  const navigate = useNavigate();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedClassifier = useScopedSettingsMixed(["promptCostClassifier"]);
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;

  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const classifierTargets = useTextGenerationTargets({
    environmentId,
    settings,
    providers: textGenerationProviders,
    projectId: target?.projectId ?? null,
    selections: [settings.promptCostClassifier, settings.textGenerationModelSelection],
  });
  const classifierEntries = classifierTargets.entries;
  const enabledInstanceIds = new Set(
    classifierEntries
      .filter((entry) => entry.enabled && entry.isAvailable)
      .map((entry) => entry.instanceId),
  );
  const effectiveProviders = classifierTargets.providers.filter((provider) =>
    enabledInstanceIds.has(provider.instanceId),
  );
  const activeSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection:
        settings.promptCostClassifier ?? settings.textGenerationModelSelection,
    },
    effectiveProviders,
  );
  const modelOptionsByInstance = getTextGenerationModelOptionsByInstance(
    settings,
    effectiveProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const classifierDisabledReason = useScopedModelDisabledReason(settings, classifierEntries, true);
  const hasAvailableClassifier = classifierEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const mode = settings.promptCostEstimate;
  const defaultMode = DEFAULT_UNIFIED_SETTINGS.promptCostEstimate;

  return (
    <SettingsSection {...setting("prompt-cost")}>
      <SettingsRow
        title={gt("Estimate mode")}
        description={messages(MODE_OPTIONS[mode].description)}
        resetAction={
          mode !== defaultMode ? (
            <SettingResetButton
              ariaLabel={gt("Reset prompt cost mode to default")}
              onClick={() => updateSettings({ promptCostEstimate: defaultMode })}
            />
          ) : null
        }
        control={
          <Select
            value={mode}
            onValueChange={(value) => {
              if (value) {
                updateSettings({ promptCostEstimate: value as PromptCostMode });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={gt("Prompt cost mode")}>
              <SelectValue>
                {(value: PromptCostMode | null) =>
                  value === null ? gt("Suggest") : messages(MODE_OPTIONS[value].label)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MODE_OPTIONS) as PromptCostMode[]).map((option) => (
                <SelectItem key={option} hideIndicator value={option}>
                  <span className="flex flex-col">
                    <span>{messages(MODE_OPTIONS[option].label)}</span>
                    <span className="text-xs text-muted-foreground">
                      {messages(MODE_OPTIONS[option].description)}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["promptCostClassifier"]}
        mixed={mixedClassifier}
        title={gt("Classifier model")}
        description={gt(
          "Fast model used to judge prompt complexity for cheaper-model suggestions. Leave empty to pick automatically.",
        )}
        resetAction={
          mixedClassifier || settings.promptCostClassifier !== null ? (
            <SettingResetButton
              ariaLabel={gt("Reset prompt cost classifier to automatic")}
              onClick={() => updateSettings({ promptCostClassifier: null })}
            />
          ) : null
        }
        control={
          !hasServerTargets ? (
            <span className="text-sm text-muted-foreground">
              <T>Connect an environment to choose its classifier model.</T>
            </span>
          ) : !hasAvailableClassifier ? (
            <span className="text-sm text-muted-foreground">
              <T>No text generation providers available.</T>
            </span>
          ) : (
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={activeSelection.instanceId}
              model={activeSelection.model}
              lockedProvider={null}
              instanceEntries={classifierEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel={gt("Prompt cost classifier model")}
              {...(mixedClassifier
                ? { triggerLabel: gt("Mixed", { $context: "values differ across targets" }) }
                : settings.promptCostClassifier === null
                  ? { triggerLabel: gt("Pick automatically") }
                  : {})}
              {...(environmentId
                ? {
                    onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                      void navigate({
                        to: "/settings/providers",
                        search: { environmentId, instanceId },
                      });
                    },
                  }
                : {})}
              getModelDisabledReason={classifierDisabledReason}
              onInstanceModelChange={(instanceId, model) => {
                const reason = classifierDisabledReason(instanceId, model);
                if (reason) {
                  toastManager.add({
                    type: "error",
                    title: gt("Classifier model not saved"),
                    description: reason,
                  });
                  return;
                }
                updateSettings({
                  promptCostClassifier: pickModelSelection(
                    mixedClassifier ? null : settings.promptCostClassifier,
                    instanceId,
                    model,
                  ),
                });
              }}
            />
          )
        }
      />
    </SettingsSection>
  );
}
