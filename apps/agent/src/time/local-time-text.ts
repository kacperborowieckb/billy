import { localDueTimePattern } from "./local-due-time.ts";
import { weekdayNames } from "./recurrence-rule.ts";
import type { RecurrenceRule } from "./recurrence-rule.ts";

const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export const localDueTimeText = (localDueTime: string) => {
  const parts = localDueTimePattern.exec(localDueTime)?.groups;
  if (parts === undefined) {
    return localDueTime;
  }
  const year = Number(parts["year"]);
  const month = Number(parts["month"]);
  const day = Number(parts["day"]);
  const weekday =
    weekdayNames[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday?.slice(0, 3)} ${day} ${monthNames[month - 1]} ${year}, ${parts["hour"]}:${parts["minute"]}`;
};

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
