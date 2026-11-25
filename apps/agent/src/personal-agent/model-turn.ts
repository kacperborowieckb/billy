import type { ModelMessage } from "ai";
import { Clock, Effect, Option } from "effect";

import { dropDraftsOf } from "../approval/pending-approvals.ts";
import { turnTrustGiven } from "../approval/turn-trust.ts";
import type { TurnMetricResult } from "../tracing/operator-metrics.ts";
import { Redactor } from "../tracing/redactor.ts";
import { tracedRequestOf } from "../tracing/traced-request.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import { AgentStorage } from "./agent-storage.ts";
import { staySilent } from "./delivery.ts";
import { keepFinishedSteps, stepsNotKeptReason } from "./kept-steps.ts";
import { recordModelSteps } from "./model-step-metrics.ts";
import type { ModelTurn } from "./model-turn-kind.ts";
import { sent, silentResult, superseded } from "./model-turn-result.ts";
import type { ModelTurnResult } from "./model-turn-result.ts";
import { generateWithOutcomeTools } from "./outcome-tools.ts";
import { failAtStepLimit } from "./step-limit-failure.ts";
import type { OutcomeKind } from "./storage-values.ts";
import { reacted, replied, silent, unanswered } from "./stored-turn.ts";
import type { TurnEnding } from "./stored-turn.ts";
import { approvalAskingOf, deliverTurnOutcome } from "./turn-delivery.ts";
import { recordTurnMetric } from "./turn-metric.ts";
import { unpreparedTurn } from "./turn-preparation.ts";
import { TurnProgress } from "./turn-progress.ts";
import {
  modelFailureReason,
  responseMessagesOf,
  stepMessagesOfReply,
} from "./turn-record.ts";
import { recordSuperseded, restartCountForTurn } from "./turn-restart.ts";
import type { Restart } from "./turn-restart.ts";

export const runModelTurn = <Failure, Requirements>({
  ownerId,
  behavior,
  session,
  kind,
}: ModelTurn<Failure, Requirements>) =>
  Effect.gen(function* runModelTurnEffect() {
    const { event } = kind;
    const { eventId } = event;
    const { database } = yield* AgentStorage;
    const traces = yield* TurnTraces;
    const redactor = yield* Redactor;
    const progress = yield* TurnProgress;

    const startedAt = yield* Clock.currentTimeMillis;
    const restartsDone = yield* restartCountForTurn(event.eventId);
    const stepsUsed = yield* progress.usedStepCount(eventId);
    const preparation =
      kind.prepare === undefined ? unpreparedTurn : yield* kind.prepare;
    const earlier = yield* progress.completedFor(eventId);
    const stepsLeft = behavior.maxToolSteps - stepsUsed;
    if (stepsLeft <= 0) {
      return yield* failAtStepLimit({ session, kind, earlier, behavior });
    }
    const sessionRequest = yield* session.request({
      eventId,
      behavior,
      instructions: kind.instructions ?? [],
      situation: [
        ...(restartsDone > 0 && kind.restartSection !== undefined
          ? [kind.restartSection]
          : []),
        ...preparation.situation,
      ],
      inputs: kind.inputs,
      earlier,
    });
    const { system, ownerContext, turnContext, messages } = sessionRequest;
    const tracedRequest = yield* tracedRequestOf(
      { ...sessionRequest, task: kind.task, tools: kind.tools },
      redactor
    );
    const turn = { eventId, turnContext, inputs: kind.inputs };
    const finished = (steps: readonly ModelMessage[], ending: TurnEnding) =>
      session.commit({ ...turn, steps, ending });
    const trust = turnTrustGiven({ ...kind, ...preparation, ...turn }, earlier);
    const decided = yield* generateWithOutcomeTools({
      eventId,
      earlierMessages: earlier,
      request: {
        task: kind.task,
        system,
        messages,
        tools: kind.tools,
        trust,
        stepLimit: stepsLeft,
      },
      tools: kind.tools,
      defaultReaction: behavior.defaultReaction,
      approvalAsking: approvalAskingOf(behavior, kind.asksOwnerForApproval),
    });
    const { outcome } = decided;
    yield* recordModelSteps({
      ownerId,
      kind,
      stepsUsed,
      system,
      ownerContext,
      outcome,
    });
    const modelLatencyMillis = (yield* Clock.currentTimeMillis) - startedAt;
    const traceInput = {
      request: tracedRequest.pointer,
      outcome,
      modelLatencyMillis,
      redactor,
      outcomeKind: decided.kind,
      reaction: decided.reaction,
      refusedOutcomeTools: decided.refusedOutcomeTools,
      trustLevelChange: Option.getOrUndefined(trust.change()),
    };
    const recordTrace = (delivered: boolean) =>
      traces.recordModelTurn({
        trace: kind.traceOf({ ...traceInput, delivered }),
        requestParts: tracedRequest.parts,
      });
    const recordMetric = (
      result: TurnMetricResult,
      outcomeKind?: OutcomeKind,
      restartCount = restartsDone
    ) =>
      recordTurnMetric({
        ownerId,
        eventId,
        outcome,
        result,
        outcomeKind,
        startedAt,
        restartCount,
      });
    const restart =
      kind.restartBeforeDelivery === undefined
        ? Option.none<Restart>()
        : yield* kind.restartBeforeDelivery(restartsDone);
    if (Option.isSome(restart)) {
      const { coveredEventIds, newEventIds } = restart.value;
      yield* recordSuperseded(
        restart.value,
        {
          trace: kind.traceOf({
            ...traceInput,
            delivered: false,
            restart: { coveredEventIds, newEventIds },
          }),
          requestParts: tracedRequest.parts,
        },
        eventId
      );
      yield* recordMetric("superseded", undefined, restart.value.restartCount);
      return superseded;
    }
    yield* recordTrace(true);

    const keptSteps = (turnMessages: readonly ModelMessage[]) =>
      keepFinishedSteps({ eventId, earlier, turnMessages });
    const endFailed = Effect.fnUntraced(function* endFailed(
      reason: string,
      steps: Option.Option<readonly ModelMessage[]>
    ) {
      yield* dropDraftsOf(eventId);
      yield* finished(
        Option.isSome(steps)
          ? steps.value
          : yield* progress.completedFor(eventId),
        unanswered
      );
      yield* recordMetric("model_failed");
      return { _tag: "Failed", reason } satisfies ModelTurnResult;
    });
    if (outcome._tag === "ModelFailed") {
      return yield* endFailed(
        modelFailureReason(outcome.error, redactor),
        yield* keptSteps(responseMessagesOf(outcome))
      );
    }
    if (decided.kind === "silent") {
      const stayedSilent = yield* database.transaction(() =>
        keptSteps(responseMessagesOf(outcome)).pipe(
          Effect.flatMap((steps) =>
            Option.isNone(steps)
              ? Effect.succeed(false)
              : finished(steps.value, silent).pipe(
                  Effect.andThen(staySilent(event)),
                  Effect.as(true)
                )
          )
        )
      );
      if (!stayedSilent) {
        return yield* endFailed(stepsNotKeptReason, Option.none());
      }
      yield* recordMetric("silent", "silent");
      return silentResult;
    }
    const outcomeKind = decided.reaction === undefined ? "reply" : "reaction";
    const kept = yield* keptSteps(
      outcomeKind === "reply"
        ? stepMessagesOfReply(outcome)
        : responseMessagesOf(outcome)
    );
    if (Option.isNone(kept)) {
      return yield* endFailed(stepsNotKeptReason, Option.none());
    }
    const steps = kept.value;
    const text = preparation.lateText(redactor.redact(outcome.reply.text));
    const delivery = yield* deliverTurnOutcome({
      event,
      text,
      drafts: decided.drafts,
      reaction: decided.reaction,
      replyTo: kind.replyTo ?? event,
    });
    if (delivery._tag === "Failed") {
      yield* finished(steps, unanswered);
      if (kind.tracesSendFailure === true) {
        yield* recordTrace(false);
      }
      yield* recordMetric("send_failed", outcomeKind);
      return {
        _tag: "SendFailed",
        reason: delivery.reason,
      } satisfies ModelTurnResult;
    }
    yield* finished(steps, outcomeKind === "reply" ? replied(text) : reacted);
    yield* recordMetric(
      outcomeKind === "reply" ? "replied" : "reacted",
      outcomeKind
    );
    return sent;
  });
