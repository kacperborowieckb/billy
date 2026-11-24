import type { ModelMessage } from "ai";
import { Clock, Effect, Option } from "effect";

import { dropDraftsOf } from "../approval/pending-approvals.ts";
import { turnTrustGiven } from "../approval/turn-trust.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { TrustLevel } from "../notes/note.ts";
import type { OwnerId } from "../owner-id.ts";
import type { TurnMetricResult } from "../tracing/operator-metrics.ts";
import { Redactor } from "../tracing/redactor.ts";
import { TurnTraces } from "../tracing/turn-trace.ts";
import type { TurnTrace } from "../tracing/turn-trace.ts";
import { AgentStorage } from "./agent-storage.ts";
import { staySilent } from "./delivery.ts";
import type { InboxEvent } from "./inbox.ts";
import { keepFinishedSteps, stepsNotKeptReason } from "./kept-steps.ts";
import { sent, silentResult, superseded } from "./model-turn-result.ts";
import type { ModelTurnResult } from "./model-turn-result.ts";
import { generateWithOutcomeTools } from "./outcome-tools.ts";
import type { OutcomeKind } from "./storage-values.ts";
import { reacted, replied, silent, unanswered } from "./stored-turn.ts";
import type { TurnEnding } from "./stored-turn.ts";
import { approvalAskingOf, deliverTurnOutcome } from "./turn-delivery.ts";
import { recordTurnMetric } from "./turn-metric.ts";
import { unpreparedTurn } from "./turn-preparation.ts";
import type { TurnPreparation } from "./turn-preparation.ts";
import { TurnProgress } from "./turn-progress.ts";
import {
  modelFailureReason,
  responseMessagesOf,
  stepLimitReason,
  stepMessagesOfReply,
} from "./turn-record.ts";
import type { ModelTraceInput } from "./turn-record.ts";
import { recordSuperseded, restartCountForTurn } from "./turn-restart.ts";
import type { Restart } from "./turn-restart.ts";
import type { TurnSession } from "./turn-session.ts";

export interface ModelTurnKind<Failure, Requirements> {
  readonly task: "reply" | "scheduled_task" | "proactive";
  readonly event: InboxEvent;
  readonly replyTo?: InboxEvent;
  readonly inputs: readonly ModelMessage[];
  readonly instructions?: readonly string[];
  readonly tools: AgentTools;
  readonly trustLevel: TrustLevel;
  readonly asksOwnerForApproval?: boolean;
  readonly traceOf: (model: ModelTraceInput) => TurnTrace;
  readonly restartSection?: string;
  readonly restartBeforeDelivery?: (
    restartsDone: number
  ) => Effect.Effect<Option.Option<Restart>, Failure, Requirements>;
  readonly prepare?: Effect.Effect<TurnPreparation, Failure, Requirements>;
  readonly tracesSendFailure?: boolean;
}

interface ModelTurn<Failure, Requirements> {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly session: TurnSession;
  readonly kind: ModelTurnKind<Failure, Requirements>;
}

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
      yield* session.commit({
        eventId,
        turnContext: yield* progress.turnContextFor(eventId),
        inputs: kind.inputs,
        steps: earlier,
        ending: unanswered,
      });
      return {
        _tag: "Failed",
        reason: stepLimitReason(behavior.maxToolSteps),
      } satisfies ModelTurnResult;
    }
    const { system, history, turnContext, messages } = yield* session.request({
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
    const turn = { eventId, turnContext, inputs: kind.inputs };
    const finished = (steps: readonly ModelMessage[], ending: TurnEnding) =>
      session.commit({ ...turn, steps, ending });
    const trust = turnTrustGiven(kind, { history, ...preparation }, earlier);
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
    const modelLatencyMillis = (yield* Clock.currentTimeMillis) - startedAt;
    const traceInput = {
      system,
      messages,
      outcome,
      modelLatencyMillis,
      redactor,
      outcomeKind: decided.kind,
      reaction: decided.reaction,
      refusedOutcomeTools: decided.refusedOutcomeTools,
      trustLevelChange: Option.getOrUndefined(trust.change()),
    };
    const recordTrace = (delivered: boolean) =>
      traces.record(kind.traceOf({ ...traceInput, delivered }));
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
        kind.traceOf({
          ...traceInput,
          delivered: false,
          restart: { coveredEventIds, newEventIds },
        }),
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
