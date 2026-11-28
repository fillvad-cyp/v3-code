import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type PromptCostAssessment,
  type PromptCostInput,
} from "@t3tools/contracts";

import { buildPromptCostKey } from "../components/chat/promptCostChip.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const promptCostAssessmentQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:prompt-cost",
  tag: WS_METHODS.serverPredictPromptCost,
  staleTimeMs: 10_000,
  idleTtlMs: 90_000,
});

export function usePromptCostAssessment(params: {
  readonly environmentId: EnvironmentId | null;
  readonly input: PromptCostInput | null;
}): {
  readonly assessment: PromptCostAssessment | null;
  readonly isPending: boolean;
  readonly error: string | null;
} {
  const { environmentId, input } = params;
  const key =
    environmentId !== null && input !== null ? buildPromptCostKey(environmentId, input) : null;
  const atom =
    environmentId !== null && input !== null && key !== null
      ? promptCostAssessmentQuery({ environmentId, input }, key)
      : null;
  const query = useEnvironmentQuery(atom);
  return {
    assessment: query.data,
    isPending: query.isPending,
    error: query.error,
  };
}
