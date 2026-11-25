import { isStepCount, ToolLoopAgent, wrapLanguageModel } from "ai";
import type { ModelMessage } from "ai";
import { Clock, Context, Effect, Layer, Schedule } from "effect";

import type { TurnTrust } from "../approval/turn-trust.ts";
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
import {
  approvalRequestedCallsOf,
  modelStepOf,
  pendingToolCallsOf,
} from "./model-step-of.ts";
import type {
  ApprovalRequestedCall,
  ModelStep,
  PendingToolCall,
} from "./model-step.ts";
import { ModelUnavailable } from "./model-unavailable.ts";
import { StepLimitReached } from "./step-limit-reached.ts";
import {
  approvalStatusOf,
  toolInputGateOf,
  blockedCallReachingTheGate,
} from "./tool-approval.ts";
import type { TurnGate } from "./tool-approval.ts";
import { sumUsage, UsageLedger } from "./usage-ledger.ts";
import type { Usage } from "./usage-ledger.ts";

export interface ModelRequest {
  readonly task: ModelTask;
  readonly eventId?: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: AgentTools;
  readonly trust: TurnTrust;
  readonly asksOwnerForApproval: boolean;
  readonly stepLimit: number;
  readonly maxOutputTokens?: number;
}

export interface ModelReply {
  readonly modelId: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly text: string;
  readonly usage: Usage;
  readonly steps: readonly ModelStep[];
  readonly endedWith: readonly PendingToolCall[];
  readonly awaitingApproval: readonly ApprovalRequestedCall[];
  readonly reachedOutputLimit: boolean;
}

const attemptTimeout = `${attemptTimeoutMillis} millis` as const;
const firstRetryDelay = "1 second";

const aiSdkToolsOf = (
  tools: AgentTools,
  turnGate: TurnGate,
  runTool: RunToolEffect
) =>
  Object.fromEntries(
    Object.entries(tools).map(([name, agentTool]) => [
      name,
      agentTool.toAiSdkTool(runTool, toolInputGateOf(agentTool, turnGate)),
    ])
  );

interface AgentRun {
  readonly runTool: RunToolEffect;
  readonly onCallStarted: () => void;
}

const toolLoopAgentOf = (
  route: ResolvedRoute,
  request: ModelRequest,
  { runTool, onCallStarted }: AgentRun
) =>
  new ToolLoopAgent({
    model: retryingModelCalls(route.model, onCallStarted),
    instructions: request.system,
    tools: aiSdkToolsOf(request.tools ?? noTools, request, runTool),
    toolApproval: approvalStatusOf(request.tools ?? noTools, request),
    repairToolCall: blockedCallReachingTheGate(request.tools ?? noTools),
    stopWhen: isStepCount(request.stepLimit),
    maxRetries: 0,
    ...(request.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: request.maxOutputTokens }),
  });

const retryingModelCalls = (
  model: ResolvedRoute["model"],
  onCallStarted: () => void
): ResolvedRoute["model"] =>
  wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ params }) => {
        const attempt = Effect.tryPromise({
          try: (abortSignal) => {
            onCallStarted();
            return model.doGenerate({ ...params, abortSignal });
          },
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
): Omit<
  ModelReply,
  "endedWith" | "awaitingApproval" | "reachedOutputLimit"
> => ({
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
    request: ModelRequest,
    modelId: string,
    steps: readonly ModelStep[]
  ) =>
    Effect.forEach(
      steps,
      (step) => ledger.record(request, modelId, step.usage),
      { discard: true }
    );

  const generate = (request: ModelRequest) =>
    Effect.gen(function* generateEffect() {
      const route = provider.route(request.task);
      const { modelId } = route.model;
      const { reasoningEffort } = route;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const runTool = runToolEffect(runPromise);
      const clock = yield* Clock.Clock;
      let callStartedAt = clock.currentTimeMillisUnsafe();
      const agent = toolLoopAgentOf(route, request, {
        runTool,
        onCallStarted: () => {
          callStartedAt = clock.currentTimeMillisUnsafe();
        },
      });
      const finishedSteps: ModelStep[] = [];

      const result = yield* Effect.tryPromise({
        try: (abortSignal) =>
          agent.generate({
            messages: [...request.messages],
            abortSignal,
            onStepFinish: (step) => {
              finishedSteps.push(modelStepOf(step, callStartedAt));
              request.trust.readToolResults(step.toolResults);
            },
          }),
        catch: (cause) =>
          new ModelUnavailable({
            modelId,
            reasoningEffort,
            cause,
            steps: [...finishedSteps],
          }),
      }).pipe(
        Effect.tapError((error) => recordUsage(request, modelId, error.steps))
      );

      const steps: readonly ModelStep[] = [...finishedSteps];
      yield* recordUsage(request, modelId, steps);

      const lastStep = result.steps.at(-1);
      const endedWith =
        lastStep === undefined ? [] : pendingToolCallsOf(lastStep);
      const awaitingApproval =
        lastStep === undefined ? [] : approvalRequestedCallsOf(lastStep);
      if (
        lastStep?.finishReason === "tool-calls" &&
        endedWith.length === 0 &&
        awaitingApproval.length === 0
      ) {
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
        awaitingApproval,
        reachedOutputLimit: lastStep?.finishReason === "length",
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
