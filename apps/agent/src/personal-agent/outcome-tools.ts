import type { ModelMessage } from "ai";
import { Effect } from "effect";

import { reviewStoppedReason } from "../approval/tool-gate.ts";
import { Channel } from "../channels/channel.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import type { ModelRequest } from "../model-gateway/model-gateway.ts";
import type { ModelStep } from "../model-gateway/model-step.ts";
import { answerApprovalRequests } from "./approval-step.ts";
import type { ApprovalAsking } from "./approval-step.ts";
import {
  failedModelCall,
  reachedStepLimit,
  repliedWith,
  stoppedReply,
  unusableReply,
} from "./decided-outcome.ts";
import type { OutcomeRecords } from "./decided-outcome.ts";
import {
  missesNeededText,
  noTextForNeededReplyReason,
} from "./needed-text-reply.ts";
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
import {
  holdsOnlyStubs,
  stubOnlyReplyReason,
  withoutReplyText,
} from "./stub-reply.ts";
import type { ReactionOutcome } from "./turn-record.ts";

interface OutcomeGeneration {
  readonly eventId: string;
  readonly earlierMessages: readonly ModelMessage[];
  readonly request: Omit<ModelRequest, "asksOwnerForApproval">;
  readonly tools: AgentTools;
  readonly defaultReaction: string;
  readonly stubReplyRetries: number;
  readonly approvalAsking: ApprovalAsking;
  readonly textReplyNeeded: boolean;
}

export const generateWithOutcomeTools = Effect.fnUntraced(
  function* generateWithOutcomeTools({
    eventId,
    earlierMessages,
    request,
    tools,
    defaultReaction,
    stubReplyRetries,
    approvalAsking,
    textReplyNeeded,
  }: OutcomeGeneration) {
    const modelGateway = yield* ModelGateway;
    const channel = yield* Channel;
    let earlier: readonly ModelStep[] = [];
    const records: OutcomeRecords = {
      refusedOutcomeTools: [],
      rejectedStubReplies: [],
      drafts: [],
    };
    const { refusedOutcomeTools, rejectedStubReplies, drafts } = records;

    for (;;) {
      const stepLimit = request.stepLimit - earlier.length;
      const generated = yield* modelGateway
        .generate({
          ...request,
          eventId,
          asksOwnerForApproval: approvalAsking._tag === "AskOwner",
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
        return failedModelCall(records, generated.error, earlier);
      }
      const { reply } = generated;
      const steps = [...earlier, ...reply.steps];
      const replied = (
        finalSteps: readonly ModelStep[],
        kind: OutcomeKind,
        reaction?: ReactionOutcome
      ) => repliedWith(records, { reply, steps: finalSteps, kind, reaction });
      const calls = reply.endedWith;
      const stopped = request.callReview?.stopsTurn() === true;
      if (stopped || reply.awaitingApproval.length > 0) {
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
        refusedOutcomeTools.push(...calls.map((call) => call.name));
        earlier = closeLastStep(steps, [
          ...answered.results,
          ...sameOutputFor(
            calls,
            stopped ? reviewStoppedReason : outcomeWhileApprovalWaitsMessage,
            true
          ),
        ]);
        if (stopped) {
          return stoppedReply(records, { reply, steps: earlier });
        }
        if (earlier.length >= request.stepLimit) {
          return reachedStepLimit(
            records,
            { reply, steps: earlier },
            request.stepLimit
          );
        }
        continue;
      }
      if (calls.length === 0) {
        if (holdsOnlyStubs(reply.text)) {
          rejectedStubReplies.push(reply.text);
          earlier = withoutReplyText(steps);
          if (rejectedStubReplies.length > stubReplyRetries) {
            return unusableReply(
              records,
              { reply, steps: earlier },
              stubOnlyReplyReason
            );
          }
          if (earlier.length >= request.stepLimit) {
            return reachedStepLimit(
              records,
              { reply, steps: earlier },
              request.stepLimit
            );
          }
          continue;
        }
        if (missesNeededText({ textReplyNeeded, drafts, text: reply.text })) {
          return unusableReply(
            records,
            { reply, steps },
            noTextForNeededReplyReason
          );
        }
        const reactionInstead =
          drafts.length === 0 &&
          reply.text.trim().length === 0 &&
          (yield* defaultReactionAllowed({
            eventId,
            steps,
            earlierMessages,
            tools,
            approvalWaits: false,
            textReplyNeeded,
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
            textReplyNeeded,
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
      refusedOutcomeTools.push(...calls.map((call) => call.name));
      earlier = closeLastStep(steps, sameOutputFor(calls, refusal, true));
      if (earlier.length >= request.stepLimit) {
        return reachedStepLimit(
          records,
          { reply, steps: earlier },
          request.stepLimit
        );
      }
    }
  }
);
