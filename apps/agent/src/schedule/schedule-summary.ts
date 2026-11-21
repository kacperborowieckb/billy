import { DateTime, Effect, Option } from "effect";

import { quoted } from "../approval/approval-summary.ts";
import { ToolFailed } from "../model-gateway/agent-tool.ts";
import {
  instantText,
  localDueTimeText,
  recurrenceText,
} from "../time/local-time-text.ts";
import type { RecurrenceRule } from "../time/recurrence-rule.ts";
import type { ScheduleAction } from "./schedule-action.ts";
import { noActiveScheduleMessage } from "./schedule-presentation.ts";
import type { Schedule } from "./schedule.ts";
import type { Schedules } from "./schedules.ts";

export const scheduleActionText = (action: ScheduleAction) =>
  action._tag === "SendText"
    ? `Reminder ${quoted(action.text)}`
    : `Scheduled Task ${quoted(action.prompt)}`;

export interface ScheduleDueInput {
  readonly localDueTime?: string | undefined;
  readonly repeat?: RecurrenceRule | undefined;
}

export const scheduleDueText = (
  { localDueTime, repeat }: ScheduleDueInput,
  timeZone: Option.Option<DateTime.TimeZone>
) =>
  [
    ...(localDueTime === undefined
      ? []
      : [localDueTimeText(localDueTime, timeZone)]),
    ...(repeat === undefined ? [] : [recurrenceText(repeat)]),
  ].join(", ");

export const schedulesNotReadMessage =
  "The Schedules could not be read, so nothing waits for the Owner's Approval. Tell the Owner that you could not do it.";

const activeScheduleTextOf = (
  schedule: Schedule,
  timeZone: Option.Option<DateTime.TimeZone>
) => {
  const zoneName = DateTime.zoneToString(
    schedule.repeat?.timeZone ??
      Option.getOrElse(timeZone, () => DateTime.zoneMakeNamedUnsafe("UTC"))
  );
  return [
    scheduleActionText(schedule.action),
    `next due ${instantText(schedule.nextDueAt, zoneName)}`,
    ...(schedule.repeat === undefined
      ? []
      : [recurrenceText(schedule.repeat.rule)]),
  ].join(", ");
};

export const activeScheduleText = (
  schedules: Schedules["Service"],
  scheduleId: string,
  timeZone: Option.Option<DateTime.TimeZone>
) =>
  schedules.byId(scheduleId).pipe(
    Effect.mapError(() => new ToolFailed({ message: schedulesNotReadMessage })),
    Effect.flatMap((found) =>
      Option.isSome(found) && found.value.state === "active"
        ? Effect.succeed(activeScheduleTextOf(found.value, timeZone))
        : Effect.fail(
            new ToolFailed({ message: noActiveScheduleMessage(scheduleId) })
          )
    )
  );

export interface SetScheduleSummary {
  readonly action: ScheduleAction;
  readonly due: string;
  readonly followUp: boolean;
  readonly about: readonly string[];
  readonly followedUp: readonly string[];
}

export const setScheduleSummaryText = ({
  action,
  due,
  followUp,
  about,
  followedUp,
}: SetScheduleSummary) =>
  [
    followUp
      ? `Set a follow-up of the agent, ${scheduleActionText(action)}`
      : `Set ${scheduleActionText(action)}`,
    due,
    ...(about.length === 0 ? [] : [`about ${about.join(", ")}`]),
    ...(followedUp.length === 0
      ? []
      : [`to follow up ${followedUp.join(", ")}`]),
  ].join(", ");
