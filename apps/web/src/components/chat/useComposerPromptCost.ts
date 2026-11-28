import { useAtomValue } from "@effect/atom-react";
import { createCommandPermissions } from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type ModelSelection,
  type PromptCostAssessment,
  type PromptCostInput,
  type PromptCostMode,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { updateClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { usePromptCostAssessment } from "../../state/promptCost";
import { useDebouncedValue } from "../../state/queries";
import { serverEnvironment } from "../../state/server";
import type { ComposerPromptCostSwitchedFrom } from "./ComposerPromptCost";
import {
  buildPromptCostAttachments,
  buildPromptCostPromptHash,
  chipState,
  createAppliedHashRecorder,
  MAX_PROMPT_COST_TEXT_LENGTH,
  MIN_PROMPT_COST_LENGTH,
  PROMPT_COST_DEBOUNCE_MS,
  shouldAutoSwitchPromptCost,
  type PromptCostChipState,
} from "./promptCostChip.logic";

const selectSupportsPromptCost = (config: ServerConfig | null): boolean =>
  config?.environment.capabilities.promptCostClassifier === true;

const promptCostPermissions = createCommandPermissions(
  connectionAtomRuntime,
  WS_METHODS.serverPredictPromptCost,
);

interface SwitchedFromRecord {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly origin: ComposerPromptCostSwitchedFrom;
  readonly targetInstanceId: ProviderInstanceId;
  readonly targetModel: string;
}

interface SelectionSnapshot {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

interface OwnSelectionTarget extends SelectionSnapshot {
  readonly pendingHash: string | null;
}

export interface UseComposerPromptCostParams {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly prompt: string;
  readonly composerFiles: ReadonlyArray<{ readonly sizeBytes: number }>;
  readonly composerImages: ReadonlyArray<{ readonly sizeBytes: number }>;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly selectedModel: string;
  readonly selectedModelLabel: string;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  readonly compactFirst: boolean;
  readonly settings: UnifiedSettings;
  readonly onProviderModelSelect: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => void;
}

interface UseComposerPromptCostResult {
  readonly state: PromptCostChipState;
  readonly assessment: PromptCostAssessment | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly mode: PromptCostMode;
  readonly switchedFrom: ComposerPromptCostSwitchedFrom | null;
  readonly selectAlternative: (instanceId: ProviderInstanceId, model: string) => void;
  readonly revertModel: () => void;
  readonly setMode: (mode: PromptCostMode) => void;
}

export function useComposerPromptCost(
  params: UseComposerPromptCostParams,
): UseComposerPromptCostResult {
  const {
    environmentId,
    threadId,
    prompt,
    composerFiles,
    composerImages,
    selectedInstanceId,
    selectedModel,
    selectedModelLabel,
    lockedProvider,
    multipleModelSelections,
    compactFirst,
    settings,
    onProviderModelSelect,
  } = params;

  const mode = settings.promptCostEstimate;
  const supportsPromptCost = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    selectSupportsPromptCost,
  );
  const canUseClassifier = useAtomValue(
    promptCostPermissions.permissionAtom(environmentId, { useClassifier: true }),
  );
  const debouncedPrompt = useDebouncedValue(prompt, PROMPT_COST_DEBOUNCE_MS);
  const clampedPrompt = debouncedPrompt.slice(0, MAX_PROMPT_COST_TEXT_LENGTH);
  const trimmedModel = selectedModel.trim();
  const attachments = buildPromptCostAttachments(composerFiles, composerImages);
  const enabled =
    mode !== "off" &&
    supportsPromptCost &&
    trimmedModel.length > 0 &&
    clampedPrompt.length >= MIN_PROMPT_COST_LENGTH;
  const useClassifier =
    canUseClassifier &&
    mode !== "off" &&
    (settings.promptCostClassifier !== null || mode === "auto");

  const input: PromptCostInput | null = enabled
    ? {
        providerInstanceId: selectedInstanceId,
        model: trimmedModel,
        threadId,
        promptText: clampedPrompt,
        attachments: [...attachments],
        compactFirst,
        useClassifier,
      }
    : null;

  const { assessment, isPending, error } = usePromptCostAssessment({
    environmentId: enabled ? environmentId : null,
    input,
  });

  const promptHash = enabled ? buildPromptCostPromptHash(clampedPrompt, attachments) : null;
  const appliedHashesRef = useRef(createAppliedHashRecorder());
  const lastOwnSelectionRef = useRef<OwnSelectionTarget | null>(null);
  const lastObservedSelectionRef = useRef<SelectionSnapshot>({
    environmentId,
    threadId,
    instanceId: selectedInstanceId,
    model: selectedModel,
  });
  const [switchedFrom, setSwitchedFrom] = useState<SwitchedFromRecord | null>(null);

  const sameSwitchedScope =
    switchedFrom !== null &&
    switchedFrom.environmentId === environmentId &&
    switchedFrom.threadId === threadId;
  const onSwitchedTarget =
    sameSwitchedScope &&
    selectedInstanceId === switchedFrom.targetInstanceId &&
    selectedModel === switchedFrom.targetModel;
  if (switchedFrom !== null && !onSwitchedTarget) {
    setSwitchedFrom(null);
  }
  const visibleSwitchedFrom = onSwitchedTarget ? switchedFrom.origin : null;

  const markCurrentPromptApplied = useStableCallback(() => {
    if (promptHash !== null) {
      appliedHashesRef.current.mark(promptHash);
    }
    const livePrompt = prompt.slice(0, MAX_PROMPT_COST_TEXT_LENGTH);
    if (livePrompt.length >= MIN_PROMPT_COST_LENGTH) {
      appliedHashesRef.current.mark(buildPromptCostPromptHash(livePrompt, attachments));
    }
  });

  const state = chipState({ enabled, isPending, error, assessment });

  const applyAutoSwitch = useStableCallback(
    (targetInstanceId: ProviderInstanceId, targetModel: string, hash: string) => {
      lastOwnSelectionRef.current = {
        environmentId,
        threadId,
        instanceId: targetInstanceId,
        model: targetModel,
        pendingHash: hash,
      };
      setSwitchedFrom({
        environmentId,
        threadId,
        origin: {
          instanceId: selectedInstanceId,
          model: selectedModel,
          label: selectedModelLabel,
        },
        targetInstanceId,
        targetModel,
      });
      onProviderModelSelect(targetInstanceId, targetModel, { focusComposer: false });
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks external model selections and triggers the one-shot auto-switch callback into the composer host
  useEffect(() => {
    const previous = lastObservedSelectionRef.current;
    const sameScope = previous.environmentId === environmentId && previous.threadId === threadId;
    const selectionChanged =
      sameScope && (previous.instanceId !== selectedInstanceId || previous.model !== selectedModel);

    if (!sameScope) {
      lastOwnSelectionRef.current = null;
    } else if (selectionChanged) {
      const ownTarget = lastOwnSelectionRef.current;
      const matchesOwnTarget =
        ownTarget !== null &&
        ownTarget.environmentId === environmentId &&
        ownTarget.threadId === threadId &&
        ownTarget.instanceId === selectedInstanceId &&
        ownTarget.model === selectedModel;
      lastOwnSelectionRef.current = null;
      if (matchesOwnTarget) {
        if (ownTarget.pendingHash !== null) {
          appliedHashesRef.current.mark(ownTarget.pendingHash);
        }
      } else {
        markCurrentPromptApplied();
      }
    } else if (
      lastOwnSelectionRef.current !== null &&
      lastOwnSelectionRef.current.pendingHash !== promptHash
    ) {
      lastOwnSelectionRef.current = null;
    }

    lastObservedSelectionRef.current = {
      environmentId,
      threadId,
      instanceId: selectedInstanceId,
      model: selectedModel,
    };

    if (promptHash === null || assessment === null) {
      return;
    }
    const canSwitch = shouldAutoSwitchPromptCost({
      mode,
      assessment,
      selectedInstanceId,
      selectedModel,
      lockedProvider,
      multipleModelSelections,
      promptHash,
      hasAppliedHash: appliedHashesRef.current.has(promptHash),
    });
    if (!canSwitch || assessment.recommendation === null) return;
    applyAutoSwitch(
      assessment.recommendation.instanceId,
      assessment.recommendation.model,
      promptHash,
    );
  }, [
    applyAutoSwitch,
    assessment,
    environmentId,
    lockedProvider,
    markCurrentPromptApplied,
    mode,
    multipleModelSelections,
    promptHash,
    selectedInstanceId,
    selectedModel,
    threadId,
  ]);

  const selectAlternative = useStableCallback(
    (targetInstanceId: ProviderInstanceId, targetModel: string) => {
      if (targetInstanceId === selectedInstanceId && targetModel === selectedModel) return;
      lastOwnSelectionRef.current = {
        environmentId,
        threadId,
        instanceId: targetInstanceId,
        model: targetModel,
        pendingHash: promptHash,
      };
      setSwitchedFrom((current) => {
        const reuseOrigin =
          current !== null &&
          current.environmentId === environmentId &&
          current.threadId === threadId &&
          selectedInstanceId === current.targetInstanceId &&
          selectedModel === current.targetModel;
        return {
          environmentId,
          threadId,
          origin: reuseOrigin
            ? current.origin
            : {
                instanceId: selectedInstanceId,
                model: selectedModel,
                label: selectedModelLabel,
              },
          targetInstanceId,
          targetModel,
        };
      });
      onProviderModelSelect(targetInstanceId, targetModel, { focusComposer: true });
    },
  );

  const revertModel = useStableCallback(() => {
    if (visibleSwitchedFrom === null) return;
    lastOwnSelectionRef.current = {
      environmentId,
      threadId,
      instanceId: visibleSwitchedFrom.instanceId,
      model: visibleSwitchedFrom.model,
      pendingHash: promptHash,
    };
    const { instanceId, model } = visibleSwitchedFrom;
    setSwitchedFrom(null);
    onProviderModelSelect(instanceId, model, { focusComposer: true });
  });

  const setMode = useStableCallback((nextMode: PromptCostMode) => {
    void updateClientSettings({ promptCostEstimate: nextMode });
  });

  return {
    state,
    assessment,
    isPending,
    error,
    mode,
    switchedFrom: visibleSwitchedFrom,
    selectAlternative,
    revertModel,
    setMode,
  };
}
