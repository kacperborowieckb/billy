import { Clock, DateTime, Effect, Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { OwnerId } from "../owner-id.ts";
import { lateScheduledTaskText } from "../schedule/lateness.ts";
import type { RunPrompt } from "../schedule/schedule-action.ts";
import type { Schedule } from "../schedule/schedule.ts";
import { Schedules } from "../schedule/schedules.ts";
import { localTimeOf } from "../time/local-time.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import { Redactor } from "../tracing/redactor.ts";
import { agentToolServices } from "./agent-tool-services.ts";
import { fail, recordFailure, sendFailureNotice } from "./delivery.ts";
import { scheduledTaskInputMessage } from "./event-message.ts";
import { lateNoticeFor } from "./fired-schedule-lateness.ts";
import { nameOfPrompt } from "./fired-scheduled-task-name.ts";
import { skipOverBudget } from "./fired-scheduled-task-skip.ts";
import { Inbox } from "./inbox.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import { runModelTurn } from "./model-turn.ts";
import {
  scheduledTaskInstructions,
  scheduledTaskSection,
} from "./scheduled-task-section.ts";
import { scheduledTaskTools } from "./scheduled-task-tools.ts";
import type { TurnPreparation } from "./turn-preparation.ts";
import { TurnProgress } from "./turn-progress.ts";
import { scheduledTaskTraceOf } from "./turn-record.ts";
import type { TurnSession } from "./turn-session.ts";

export const scheduledTaskFailureText = Effect.fnUntraced(
  function* scheduledTaskFailureText(prompt: string) {
    const redactor = yield* Redactor;
    return `Your Scheduled Task "${nameOfPrompt(redactor.redact(prompt))}" did not run. I could not finish it this time.`;
  }
);

interface ScheduledTaskFailure {
  readonly event: ScheduleFiredEvent;
  readonly action: RunPrompt;
  readonly session: TurnSession;
  readonly reason: string;
}

const failScheduledTask = Effect.fnUntraced(function* failScheduledTask({
  event,
  action,
  session,
  reason,
}: ScheduledTaskFailure) {
  const schedules = yield* Schedules;

  yield* recordFailure(event, reason);
  yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
  yield* sendFailureNotice({
    event,
    session,
    text: yield* scheduledTaskFailureText(action.prompt),
  });
});

const scheduledTaskPreparation = Effect.fnUntraced(
  function* scheduledTaskPreparation(
    behavior: BehaviorConfig,
    event: ScheduleFiredEvent,
    schedule: Schedule
  ) {
    const lateNotice = yield* lateNoticeFor(behavior, event);
    const timeZone = yield* ownerTimeZone(behavior);
    const setAtText =
      timeZone._tag === "Some"
        ? `${localTimeOf(schedule.createdAt, timeZone.value)} (${DateTime.zoneToString(timeZone.value)})`
        : DateTime.formatIso(schedule.createdAt);
    return {
      situation: [scheduledTaskSection(setAtText)],
      lateText: (text: string) =>
        Option.isNone(lateNotice)
          ? text
          : lateScheduledTaskText(
              text,
              lateNotice.value.dueAt,
              lateNotice.value.timeZone
            ),
    } satisfies TurnPreparation;
  }
);

interface ScheduledTaskRun {
  readonly ownerId: OwnerId;
  readonly behavior: BehaviorConfig;
  readonly event: ScheduleFiredEvent;
  readonly schedule: Schedule;
  readonly action: RunPrompt;
  readonly session: TurnSession;
}

export const runScheduledTask = Effect.fnUntraced(function* runScheduledTask({
  ownerId,
  behavior,
  event,
  schedule,
  action,
  session,
}: ScheduledTaskRun) {
  const toolServices = yield* agentToolServices;
  const { schedules } = toolServices;
  const inbox = yield* Inbox;
  const progress = yield* TurnProgress;

  if ((yield* progress.usedStepCount(event.eventId)) === 0) {
    const startedAt = yield* Clock.currentTimeMillis;
    const check = yield* skipOverBudget({
      ownerId,
      behavior,
      event,
      action,
      session,
      startedAt,
    });
    if (check === "Stopped") {
      return;
    }
  }
  const result = yield* runModelTurn({
    ownerId,
    behavior,
    session,
    kind: {
      task: "scheduled_task",
      event,
      inputs: [scheduledTaskInputMessage(action.prompt)],
      instructions: [scheduledTaskInstructions],
      tools: scheduledTaskTools(event.eventId, { ...toolServices, behavior }),
      trustLevel: "owner",
      prepare: scheduledTaskPreparation(behavior, event, schedule),
      traceOf: (model) => scheduledTaskTraceOf({ event, ...model }),
    },
  });
  switch (result._tag) {
    case "Sent": {
      yield* schedules.complete(event.scheduleId, event.dueAt, event.eventId);
      yield* inbox.markDone([event]);
      break;
    }
    case "Silent": {
      yield* inbox.markDone([event]);
      break;
    }
    case "Superseded": {
      break;
    }
    case "Failed": {
      yield* failScheduledTask({
        event,
        action,
        session,
        reason: result.reason,
      });
      break;
    }
    case "SendFailed": {
      yield* fail(event, result.reason);
      break;
    }
    default: {
      return result satisfies never;
    }
  }
});
