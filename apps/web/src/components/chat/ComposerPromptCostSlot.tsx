import { memo } from "react";

import type { ComposerControlSize } from "./ComposerControl";
import { ComposerPromptCost } from "./ComposerPromptCost";
import { useComposerPromptCost, type UseComposerPromptCostParams } from "./useComposerPromptCost";

export interface ComposerPromptCostSlotProps extends UseComposerPromptCostParams {
  readonly size?: ComposerControlSize;
  readonly hidden?: boolean;
}

export const ComposerPromptCostSlot = memo(function ComposerPromptCostSlot(
  props: ComposerPromptCostSlotProps,
) {
  const { size = "sm", hidden, ...hookParams } = props;
  const promptCost = useComposerPromptCost(hookParams);
  if (promptCost.state === "hidden") return null;
  return (
    <ComposerPromptCost
      state={promptCost.state}
      assessment={promptCost.assessment}
      isPending={promptCost.isPending}
      error={promptCost.error}
      mode={promptCost.mode}
      size={size}
      {...(hidden === undefined ? {} : { hidden })}
      switchedFrom={promptCost.switchedFrom}
      onSelectAlternative={promptCost.selectAlternative}
      onRevertModel={promptCost.revertModel}
      onModeChange={promptCost.setMode}
    />
  );
});
