import { DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { noTools } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { OwnerId } from "../owner-id.ts";
import { ProactiveMessages } from "../proactive/proactive-messages.ts";
import type { RecordedOutcome } from "../proactive/proactive-outcomes.ts";
import { Schedules } from "../schedule/schedules.ts";
import { whileAcknowledging } from "./acknowledge.ts";
import { AgentStorage } from "./agent-storage.ts";
import { agentToolServices } from "./agent-tool-services.ts";
import { handleApprovalAnswered } from "./approval-answer.ts";
import { burstWaitOf } from "./burst-wait.ts";
import {
  burstInputs,
  linkBurst,
  newestEventOf,
  pendingBursts,
  settleBurst,
  trustLevelOfBurst,
  turnEventOf,
} from "./burst.ts";
import type { Burst } from "./burst.ts";
import { connectedProactivePreparation } from "./connected-proactive-section.ts";
import { fail, failWithNotice } from "./delivery.ts";
import { handleFiredSchedule } from "./fired-schedule.ts";
import { Inbox } from "./inbox.ts";
import type { ModelTurnResult } from "./model-turn-result.ts";
import { runModelTurn } from "./model-turn.ts";
import { openApprovalsSection } from "./open-approvals-section.ts";
import {
  recordOutcomeMetric,
  recordOutcomeOfConnectedTurn,
  recordOutcomesOfFinishedTurns,
} from "./outcome-records.ts";
import { ownerMessageTools } from "./owner-message-tools.ts";
import { reactSection } from "./react-tool.ts";
import { staySilentSection } from "./stay-silent-tool.ts";
import { traceOf } from "./turn-record.ts";
import { ownerMessageRecovery, settleFromJournal } from "./turn-recovery.ts";
import { restartOf, restartSection } from "./turn-restart.ts";
import { mainConversation } from "./turn-session.ts";

interface TurnSettings {
  readonly behavior: BehaviorConfig;
  readonly tools: AgentTools;
}

const settleSilentBurst = Effect.fnUntraced(function* settleSilentBurst(
  burst: Burst
) {
  const { database } = yield* AgentStorage;
  const inbox = yield* Inbox;
  const proactiveMessages = yield* ProactiveMessages;
  return yield* database.transaction(() =>
    Effect.gen(function* settleSilentBurstEffect() {
      const recorded: RecordedOutcome[] = [];
      yield* inbox.markDone(burst);
      for (const event of burst) {
        const outcome = yield* proactiveMessages.recordOutcomeOfConnectedTurn(
          event.eventId
        );
        if (Option.isSome(outcome)) {
          recorded.push(outcome.value);
        }
      }
      return recorded;
    })
  );
});

const settleAnswer = Effect.fnUntraced(function* settleAnswer(
  ownerId: OwnerId,
  burst: Burst,
  result: ModelTurnResult
) {
  const inbox = yield* Inbox;
  const event = turnEventOf(burst);
  switch (result._tag) {
    case "Sent": {
      yield* inbox.markDone([event]);
      break;
    }
    case "Silent": {
      const recorded = yield* settleSilentBurst(burst);
      for (const outcome of recorded) {
        yield* recordOutcomeMetric(ownerId, outcome);
      }
      break;
    }
    case "Failed": {
      yield* failWithNotice(event, result.reason, newestEventOf(burst));
      break;
    }
    case "SendFailed": {
      yield* fail(event, result.reason);
      break;
    }
    case "Superseded": {
      break;
    }
    default: {
      return result satisfies never;
    }
  }
});

const answer = (
  ownerId: OwnerId,
  { behavior, tools }: TurnSettings,
  burst: Burst
) => {
  const event = turnEventOf(burst);
  const replyTo = newestEventOf(burst);
  return Effect.gen(function* answerEffect() {
    const toolServices = yield* agentToolServices;
    const preparation = yield* connectedProactivePreparation(behavior, burst);
    const openApprovals = yield* openApprovalsSection;
    const ownerTools = ownerMessageTools(burst, { ...toolServices, behavior });

    yield* linkBurst(burst);
    const result = yield* runModelTurn({
      ownerId,
      behavior,
      session: mainConversation,
      kind: {
        task: "reply",
        event,
        replyTo,
        inputs: burstInputs(burst),
        instructions: [staySilentSection, reactSection],
        tools: { ...tools, ...ownerTools },
        trustLevel: trustLevelOfBurst(burst),
        asksOwnerForApproval: true,
        prepare: Effect.succeed({
          ...preparation,
          holdsUntrustedContent: openApprovals.holdsUntrustedContent,
          situation: [...openApprovals.situation, ...preparation.situation],
        }),
        traceOf: (model) => traceOf({ event, ...model }),
        restartSection,
        restartBeforeDelivery: (restartsDone) =>
          restartOf(burst, behavior, restartsDone),
      },
    });
    yield* settleAnswer(ownerId, burst, result);
    return result;
  }).pipe(
    whileAcknowledging(replyTo.conversationId, behavior.typingRepeatMillis)
  );
};

const answerBurst = Effect.fnUntraced(function* answerBurst(
  ownerId: OwnerId,
  settings: TurnSettings,
  burst: Burst
) {
  const outcome = yield* settleFromJournal(
    turnEventOf(burst),
    ownerMessageRecovery(burst)
  );
  if (
    outcome === "unanswered" &&
    (yield* answer(ownerId, settings, burst))._tag === "Superseded"
  ) {
    return;
  }
  yield* settleBurst(burst);
  for (const event of burst) {
    yield* recordOutcomeOfConnectedTurn(ownerId, event.eventId);
  }
});

interface TurnOptions {
  readonly tools?: AgentTools;
}

export const takeTurn = (
  ownerId: OwnerId,
  behavior: BehaviorConfig,
  { tools = noTools }: TurnOptions = {}
) =>
  Effect.gen(function* takeTurnEffect() {
    const inbox = yield* Inbox;
    const schedules = yield* Schedules;
    const startedAt = yield* DateTime.now;
    const wait = burstWaitOf(behavior);
    yield* recordOutcomesOfFinishedTurns(ownerId);
    const newBurstIsDue = yield* inbox.burstIsDue(wait);
    const events = yield* inbox.pending;
    for (const event of events) {
      if (event._tag === "ApprovalAnswered") {
        yield* handleApprovalAnswered({ behavior, tools }, event);
      }
    }
    const ownerMessages = events.filter(
      (event) => event._tag === "OwnerMessage"
    );
    const bursts = yield* pendingBursts(ownerMessages, newBurstIsDue);
    const inBursts = new Set(bursts.flat().map((event) => event.eventId));
    const waiting = new Set(
      (yield* inbox.pending).map((event) => event.eventId)
    );
    for (const event of ownerMessages) {
      if (!inBursts.has(event.eventId) && !waiting.has(event.eventId)) {
        yield* recordOutcomeOfConnectedTurn(ownerId, event.eventId);
      }
    }
    for (const burst of bursts) {
      yield* answerBurst(ownerId, { behavior, tools }, burst);
    }
    for (const event of events) {
      if (event._tag === "ScheduleFired") {
        yield* handleFiredSchedule(ownerId, behavior, event);
      }
    }
    yield* schedules.rearmWithoutFailing;
    const untaken = !newBurstIsDue || (yield* inbox.burstGrewSince(startedAt));
    return { nextBurstIsDue: untaken && (yield* inbox.burstIsDue(wait)) };
  });
