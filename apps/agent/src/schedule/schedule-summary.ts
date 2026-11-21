import { Effect, Option } from "effect";
import type { DateTime } from "effect";

import { quoted } from "../approval/approval-summary.ts";
import { localDueTimeText, recurrenceText } from "../time/local-time-text.ts";
import type { RecurrenceRule } from "../time/recurrence-rule.ts";
import type { ScheduleAction } from "./schedule-action.ts";
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

export const storedScheduleText = (
  schedules: Schedules["Service"],
  scheduleId: string
) =>
  schedules.byId(scheduleId).pipe(
    Effect.map(
      Option.match({
        onNone: () => `Schedule ${scheduleId}`,
        onSome: (schedule) => scheduleActionText(schedule.action),
      })
    ),
    Effect.orElseSucceed(() => `Schedule ${scheduleId}`)
  );
