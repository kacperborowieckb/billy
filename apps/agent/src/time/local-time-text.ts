import { DateTime, Option } from "effect";

import { realLocalDueTimeOf } from "./local-due-time.ts";
import type { RecurrenceRule } from "./recurrence-rule.ts";

const localDueTimeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const partOf = (
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes
) => parts.find((part) => part.type === type)?.value ?? "";

export const localDueTimeText = (localDueTime: string) =>
  Option.match(realLocalDueTimeOf(localDueTime), {
    onNone: () => `${localDueTime} (not a real date and time)`,
    onSome: (dueTime) => {
      const parts = localDueTimeFormat.formatToParts(
        DateTime.toEpochMillis(dueTime)
      );
      return `${partOf(parts, "weekday")} ${partOf(parts, "day")} ${partOf(parts, "month")} ${partOf(parts, "year")}, ${partOf(parts, "hour")}:${partOf(parts, "minute")}`;
    },
  });

const listText = (items: readonly string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const dayOfMonthText = (day: number | "last") =>
  day === "last"
    ? "on the last day of each month"
    : `on day ${day} of each month`;

export const recurrenceText = (rule: RecurrenceRule) => {
  if (rule._tag === "Daily") {
    return `every day at ${rule.time}`;
  }
  if (rule._tag === "Weekly") {
    return `every ${listText(rule.weekdays)} at ${rule.time}`;
  }
  return `${dayOfMonthText(rule.day)} at ${rule.time}`;
};
