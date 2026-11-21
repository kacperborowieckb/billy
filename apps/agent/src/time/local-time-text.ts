import { DateTime, Option } from "effect";

import { instantOfLocalDueTime, realLocalDueTimeOf } from "./local-due-time.ts";
import type { RecurrenceRule } from "./recurrence-rule.ts";

const formatIn = (timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
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

export const instantText = (instant: DateTime.DateTime, timeZone: string) => {
  const parts = formatIn(timeZone).formatToParts(
    DateTime.toEpochMillis(instant)
  );
  return `${partOf(parts, "weekday")} ${partOf(parts, "day")} ${partOf(parts, "month")} ${partOf(parts, "year")}, ${partOf(parts, "hour")}:${partOf(parts, "minute")}`;
};

const textInZone = (
  localDueTime: string,
  asWritten: string,
  timeZone: DateTime.TimeZone
) =>
  Option.match(instantOfLocalDueTime(localDueTime, timeZone), {
    onNone: () => asWritten,
    onSome: (instant) => {
      const zoneName = DateTime.zoneToString(timeZone);
      const dueText = instantText(instant, zoneName);
      return dueText === asWritten
        ? asWritten
        : `${asWritten} (this time does not exist in ${zoneName}, so it is due ${dueText})`;
    },
  });

export const localDueTimeText = (
  localDueTime: string,
  timeZone: Option.Option<DateTime.TimeZone>
) =>
  Option.match(realLocalDueTimeOf(localDueTime), {
    onNone: () => `${localDueTime} (not a real date and time)`,
    onSome: (asUtc) => {
      const asWritten = instantText(asUtc, "UTC");
      return Option.match(timeZone, {
        onNone: () => asWritten,
        onSome: (zone) => textInZone(localDueTime, asWritten, zone),
      });
    },
  });

const listText = (items: readonly string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const dayOfMonthText = (day: number | "last") => {
  if (day === "last") {
    return "on the last day of each month";
  }
  return day > 28
    ? `on day ${day} of each month, or on the last day of a shorter month`
    : `on day ${day} of each month`;
};

export const recurrenceText = (rule: RecurrenceRule) => {
  if (rule._tag === "Daily") {
    return `every day at ${rule.time}`;
  }
  if (rule._tag === "Weekly") {
    return `every ${listText(rule.weekdays)} at ${rule.time}`;
  }
  return `${dayOfMonthText(rule.day)} at ${rule.time}`;
};
