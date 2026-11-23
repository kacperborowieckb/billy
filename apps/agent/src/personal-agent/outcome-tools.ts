import type { ModelMessage } from "ai";
import { Effect } from "effect";

import type { DraftApproval } from "../approval/pending-approvals.ts";
import { Channel } from "../channels/channel.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import type {
  ModelReply,
  ModelRequest,
} from "../model-gateway/model-gateway.ts";
import type { ModelStep } from "../model-gateway/model-step.ts";
import { ModelUnavailable } from "../model-gateway/model-unavailable.ts";
import { StepLimitReached } from "../model-gateway/step-limit-reached.ts";
import { sumUsage } from "../model-gateway/usage-ledger.ts";
import { answerApprovalRequests } from "./approval-step.ts";
import type { ApprovalAsking } from "./approval-step.ts";
import {
  defaultReactionAllowed,
  outcomeWhileApprovalWaitsMessage,
  refusalOfOutcomeTool,
} from "./outcome-refusal.ts";
import {
  reactionAcceptedOutput,
  reactionFor,
  requestedEmojiOf,
} from "./react-tool.ts";
import { silenceAcceptedOutput } from "./stay-silent-tool.ts";
import { closeLastStep, sameOutputFor } from "./step-closing.ts";
import type { OutcomeKind } from "./storage-values.ts";
import type {
  ModelFailure,
  ModelOutcome,
  ReactionOutcome,
} from "./turn-record.ts";

export interface DecidedOutcome {
  readonly outcome: ModelOutcome;
  readonly kind: OutcomeKind | undefined;
  readonly reaction?: ReactionOutcome;
  readonly refusedOutcomeTools: readonly string[];
  readonly drafts: readonly DraftApproval[];
}

const withEarlierSteps = (
  error: ModelFailure,
  earlier: readonly ModelStep[]
): ModelFailure =>
  error._tag === "StepLimitReached"
    ? new StepLimitReached({
        modelId: error.modelId,
        reasoningEffort: error.reasoningEffort,
        stepLimit: error.stepLimit,
        steps: [...earlier, ...error.steps],
      })
    : new ModelUnavailable({
        modelId: error.modelId,
        reasoningEffort: error.reasoningEffort,
        cause: error.cause,
        steps: [...earlier, ...error.steps],
      });

interface OutcomeGeneration {
  readonly eventId: string;
  readonly earlierMessages: readonly ModelMessage[];
  readonly request: ModelRequest;
  readonly tools: AgentTools;
  readonly defaultReaction: string;
  readonly approvalAsking: ApprovalAsking;
}

export const generateWithOutcomeTools = Effect.fnUntraced(
  function* generateWithOutcomeTools({
    eventId,
    earlierMessages,
    request,
    tools,
    defaultReaction,
    approvalAsking,
  }: OutcomeGeneration) {
    const modelGateway = yield* ModelGateway;
    const channel = yield* Channel;
    let earlier: readonly ModelStep[] = [];
    const refused: string[] = [];
    const drafts: DraftApproval[] = [];
    const stepLimitFailure = (
      reply: ModelReply,
      steps: readonly ModelStep[]
    ): DecidedOutcome => ({
      outcome: {
        _tag: "ModelFailed",
        error: new StepLimitReached({
          modelId: reply.modelId,
          reasoningEffort: reply.reasoningEffort,
          stepLimit: request.stepLimit,
          steps,
        }),
      },
      kind: undefined,
      refusedOutcomeTools: refused,
      drafts,
    });

    for (;;) {
      const stepLimit = request.stepLimit - earlier.length;
      const generated = yield* modelGateway
        .generate({
          ...request,
          messages: [
            ...request.messages,
            ...earlier.flatMap((step) => step.responseMessages),
          ],
          stepLimit,
        })
        .pipe(
          Effect.map((reply) => ({ _tag: "Replied", reply }) as const),
          Effect.catchTags({
            ModelUnavailable: (error) =>
              Effect.succeed({ _tag: "ModelFailed", error } as const),
            StepLimitReached: (error) =>
              Effect.succeed({ _tag: "ModelFailed", error } as const),
          })
        );
      if (generated._tag === "ModelFailed") {
        return {
          outcome: {
            _tag: "ModelFailed",
            error: withEarlierSteps(generated.error, earlier),
          },
          kind: undefined,
          refusedOutcomeTools: refused,
          drafts,
        } satisfies DecidedOutcome;
      }
      const { reply } = generated;
      const steps = [...earlier, ...reply.steps];
      const replied = (
        finalSteps: readonly ModelStep[],
        kind: OutcomeKind,
        reaction?: ReactionOutcome
      ): DecidedOutcome => ({
        outcome: {
          _tag: "Replied",
          reply: {
            ...reply,
            steps: finalSteps,
            usage: sumUsage(finalSteps.map((step) => step.usage)),
          },
        },
        kind,
        ...(reaction === undefined ? {} : { reaction }),
        refusedOutcomeTools: refused,
        drafts,
      });
      const calls = reply.endedWith;
      if (reply.awaitingApproval.length > 0) {
        const answered = yield* answerApprovalRequests(
          {
            asking: approvalAsking,
            turnEventId: eventId,
            trustLevel: request.trust.current(),
            tools,
          },
          reply.awaitingApproval
        );
        drafts.push(...answered.drafts);
        refused.push(...calls.map((call) => call.name));
        earlier = closeLastStep(steps, [
          ...answered.results,
          ...sameOutputFor(calls, outcomeWhileApprovalWaitsMessage, true),
        ]);
        if (earlier.length >= request.stepLimit) {
          return stepLimitFailure(reply, earlier);
        }
        continue;
      }
      if (calls.length === 0) {
        const reactionInstead =
          drafts.length === 0 &&
          reply.text.trim().length === 0 &&
          (yield* defaultReactionAllowed({
            eventId,
            steps,
            earlierMessages,
            tools,
            approvalWaits: false,
          }));
        return reactionInstead
          ? replied(steps, "reaction", { emoji: defaultReaction })
          : replied(steps, "reply");
      }
      const refusals: readonly (string | undefined)[] = yield* Effect.all(
        calls.map((call) =>
          refusalOfOutcomeTool({
            eventId,
            name: call.name,
            steps,
            earlierMessages,
            tools,
            approvalWaits: drafts.length > 0,
          })
        )
      );
      const refusal = refusals.find((found) => found !== undefined);
      if (refusal === undefined) {
        const requested = requestedEmojiOf(calls);
        if (requested === undefined) {
          return replied(
            closeLastStep(
              steps,
              sameOutputFor(calls, silenceAcceptedOutput, false)
            ),
            "silent"
          );
        }
        const reaction = reactionFor(
          requested,
          channel.allowedReaction,
          defaultReaction
        );
        return replied(
          closeLastStep(
            steps,
            sameOutputFor(calls, reactionAcceptedOutput(reaction.emoji), false)
          ),
          "reaction",
          reaction
        );
      }
      refused.push(...calls.map((call) => call.name));
      earlier = closeLastStep(steps, sameOutputFor(calls, refusal, true));
      if (earlier.length >= request.stepLimit) {
        return stepLimitFailure(reply, earlier);
      }
    }
  }
);
