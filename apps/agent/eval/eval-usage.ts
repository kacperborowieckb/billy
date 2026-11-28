import { Effect, Layer } from "effect";

import type { ModelTask } from "../src/model-gateway/model-provider.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import type { Usage } from "../src/model-gateway/usage-ledger.ts";
import type { ObservedUsage } from "./eval-contract.ts";

export const observedUsageOf = (
  task: ModelTask,
  usage: Usage
): ObservedUsage => ({
  task,
  inputTokens: usage.inputTokens ?? null,
  outputTokens: usage.outputTokens ?? null,
  cachedInputTokens: usage.cachedInputTokens ?? null,
  costUsd: usage.costUsd ?? null,
});

export const collectedUsageLedger = (collected: Usage[]) =>
  Layer.succeed(UsageLedger, {
    record: (_task, _modelId, usage) =>
      Effect.sync(() => {
        collected.push(usage);
      }),
    read: Effect.succeed([]),
    tokensSpent: () => Effect.succeed(0),
    stepsAfterEvent: () => Effect.succeed([]),
  });
