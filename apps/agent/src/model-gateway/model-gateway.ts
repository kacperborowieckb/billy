import { isStepCount, ToolLoopAgent, wrapLanguageModel } from "ai";
import type { ModelMessage, StepResult, ToolSet } from "ai";
import { Context, Effect, Layer, Schedule } from "effect";

import type { TrustLevel } from "../notes/note.ts";
import { noTools, runToolEffect } from "./agent-tool.ts";
import type { AgentTools, RunToolEffect } from "./agent-tool.ts";
import { ModelCallFailed } from "./model-call-failed.ts";
import { attemptTimeoutMillis, modelAttempts } from "./model-call-policy.ts";
import { ModelProvider } from "./model-provider.ts";
import type {
  ModelTask,
  ReasoningEffort,
  ResolvedRoute,
} from "./model-provider.ts";
import { modelStepOf, pendingToolCallsOf } from "./model-step-of.ts";
import type { ModelStep, PendingToolCall } from "./model-step.ts";
import { ModelUnavailable } from "./model-unavailable.ts";
import { StepLimitReached } from "./step-limit-reached.ts";
import { approvalStatusOf } from "./tool-approval.ts";
import { sumUsage, UsageLedger } from "./usage-ledger.ts";
import type { Usage } from "./usage-ledger.ts";

export interface ModelRequest {
  readonly task: ModelTask;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: AgentTools;
  readonly trustLevel: TrustLevel;
  readonly stepLimit: number;
}

export interface ModelReply {
  readonly modelId: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly text: string;
  readonly usage: Usage;
  readonly steps: readonly ModelStep[];
  readonly endedWith: readonly PendingToolCall[];
}

const attemptTimeout = `${attemptTimeoutMillis} millis` as const;
const firstRetryDelay = "1 second";

const aiSdkToolsOf = (tools: AgentTools, runTool: RunToolEffect) =>
  Object.fromEntries(
    Object.entries(tools).map(([name, agentTool]) => [
      name,
      agentTool.toAiSdkTool(runTool),
    ])
  );

const toolLoopAgentOf = (
  route: ResolvedRoute,
  request: ModelRequest,
  runTool: RunToolEffect
) =>
  new ToolLoopAgent({
    model: retryingModelCalls(route.model),
    instructions: request.system,
    tools: aiSdkToolsOf(request.tools ?? noTools, runTool),
    toolApproval: approvalStatusOf(
      request.tools ?? noTools,
      request.trustLevel
    ),
    stopWhen: isStepCount(request.stepLimit),
    maxRetries: 0,
  });

const retryingModelCalls = (
  model: ResolvedRoute["model"]
): ResolvedRoute["model"] =>
  wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ params }) => {
        const attempt = Effect.tryPromise({
          try: (abortSignal) => model.doGenerate({ ...params, abortSignal }),
          catch: (cause) => new ModelCallFailed({ cause }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: attemptTimeout,
            orElse: () =>
              Effect.fail(new ModelCallFailed({ cause: "timeout" })),
          }),
          Effect.retry({
            times: modelAttempts - 1,
            schedule: Schedule.exponential(firstRetryDelay),
          })
        );
        const outcome = await Effect.runPromise(
          attempt.pipe(
            Effect.map((result) => ({ _tag: "Succeeded", result }) as const),
            Effect.catchTag("ModelCallFailed", (failure) =>
              Effect.succeed({ _tag: "Failed", cause: failure.cause } as const)
            )
          ),
          { signal: params.abortSignal }
        );
        if (outcome._tag === "Failed") {
          throw outcome.cause;
        }
        return outcome.result;
      },
    },
  });

const replyOf = (
  route: ResolvedRoute,
  text: string,
  steps: readonly ModelStep[]
): Omit<ModelReply, "endedWith"> => ({
  modelId: route.model.modelId,
  reasoningEffort: route.reasoningEffort,
  text,
  usage: sumUsage(steps.map((step) => step.usage)),
  steps,
});

const makeModelGateway = Effect.gen(function* makeModelGatewayEffect() {
  const provider = yield* ModelProvider;
  const ledger = yield* UsageLedger;

  const recordUsage = (
    task: ModelTask,
    modelId: string,
    steps: readonly ModelStep[]
  ) =>
    Effect.forEach(steps, (step) => ledger.record(task, modelId, step.usage), {
      discard: true,
    });

  const generate = (request: ModelRequest) =>
    Effect.gen(function* generateEffect() {
      const route = provider.route(request.task);
      const { modelId } = route.model;
      const { reasoningEffort } = route;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const runTool = runToolEffect(runPromise);
      const agent = toolLoopAgentOf(route, request, runTool);
      const finishedSteps: StepResult<ToolSet>[] = [];

      const result = yield* Effect.tryPromise({
        try: (abortSignal) =>
          agent.generate({
            messages: [...request.messages],
            abortSignal,
            onStepFinish: (step) => {
              finishedSteps.push(step);
            },
          }),
        catch: (cause) =>
          new ModelUnavailable({
            modelId,
            reasoningEffort,
            cause,
            steps: finishedSteps.map(modelStepOf),
          }),
      }).pipe(
        Effect.tapError((error) =>
          recordUsage(request.task, modelId, error.steps)
        )
      );

      const steps = result.steps.map(modelStepOf);
      yield* recordUsage(request.task, modelId, steps);

      const lastStep = result.steps.at(-1);
      const endedWith =
        lastStep === undefined ? [] : pendingToolCallsOf(lastStep);
      if (lastStep?.finishReason === "tool-calls" && endedWith.length === 0) {
        return yield* new StepLimitReached({
          modelId,
          reasoningEffort,
          stepLimit: request.stepLimit,
          steps,
        });
      }
      return {
        ...replyOf(route, result.text, steps),
        endedWith,
      } satisfies ModelReply;
    });

  return { generate };
});

export class ModelGateway extends Context.Service<
  ModelGateway,
  Effect.Success<typeof makeModelGateway>
>()("ModelGateway") {
  static readonly layer = Layer.effect(ModelGateway, makeModelGateway);
}
