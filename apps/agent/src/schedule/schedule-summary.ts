import { quoted } from "../approval/approval-summary.ts";
import { localDueTimeText, recurrenceText } from "../time/local-time-text.ts";
import type { RecurrenceRule } from "../time/recurrence-rule.ts";
import type { ScheduleAction } from "./schedule-action.ts";
import type { Schedule } from "./schedule.ts";

export const scheduleActionText = (action: ScheduleAction) =>
  action._tag === "SendText"
    ? `Reminder ${quoted(action.text)}`
    : `Scheduled Task ${quoted(action.prompt)}`;

export interface ScheduleDueInput {
  readonly localDueTime?: string | undefined;
  readonly repeat?: RecurrenceRule | undefined;
}

export const scheduleDueText = ({ localDueTime, repeat }: ScheduleDueInput) =>
  [
    ...(localDueTime === undefined ? [] : [localDueTimeText(localDueTime)]),
    ...(repeat === undefined ? [] : [recurrenceText(repeat)]),
  ].join(", ");

export const storedScheduleText = ({ action }: Schedule) =>
  scheduleActionText(action);
