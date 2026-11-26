import { DateTime, Effect, Option } from "effect";

import { openApprovals } from "../approval/open-approvals.ts";
import type { PendingApproval } from "../approval/pending-approvals.ts";
import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { listOpenLoopsToolName } from "../notes/list-open-loops-tool.ts";
import { Notes } from "../notes/notes.ts";
import type { Note } from "../notes/notes.ts";
import type { OpenLoopPage } from "../notes/open-loop-store.ts";
import type { OwnerTimeZone } from "../notes/recalled-note.ts";
import { listSchedulesToolName } from "../schedule/list-schedules-tool.ts";
import { Schedules } from "../schedule/schedules.ts";
import type { Schedule } from "../schedule/schedules.ts";
import { recurrenceText } from "../time/local-time-text.ts";
import { localTimeOf } from "../time/local-time.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";

export const openItemsPerKind = 10;

export const openLoopIdsPerSchedule = 3;

export interface OpenItems {
  readonly listedAt: DateTime.Utc;
  readonly timeZone: OwnerTimeZone;
  readonly openLoops: OpenLoopPage;
  readonly schedules: readonly Schedule[];
  readonly pendingApprovals: readonly PendingApproval[];
}

const timeText = (
  instant: DateTime.Utc,
  timeZone: Option.Option<DateTime.TimeZone>
) =>
  Option.match(timeZone, {
    onNone: () => `${DateTime.formatIso(instant)} (UTC)`,
    onSome: (zone) => localTimeOf(instant, zone),
  });

const moreLine = (more: number, where: string) =>
  more > 0 ? [`- ${more} more${where}.`] : [];

const openLoopLine = (note: Note, timeZone: OwnerTimeZone) => {
  const dueAt = note.openLoop?.dueAt;
  return dueAt === undefined
    ? `- ${note.noteId}: no due time`
    : `- ${note.noteId}: due ${timeText(dueAt, timeZone)}`;
};

const openLoopIdsText = (openLoopIds: readonly string[]) => {
  const more = openLoopIds.length - openLoopIdsPerSchedule;
  return [
    `Open Loops ${openLoopIds.slice(0, openLoopIdsPerSchedule).join(" ")}`,
    ...(more > 0 ? [`and ${more} more`] : []),
  ].join(" ");
};

const scheduleLine = (schedule: Schedule, timeZone: OwnerTimeZone) =>
  [
    `- ${schedule.scheduleId}: ${schedule.action._tag === "SendText" ? "Reminder" : "Scheduled Task"}`,
    `set by ${schedule.setBy}`,
    `next due ${timeText(
      schedule.nextDueAt,
      Option.orElse(
        Option.fromNullishOr(schedule.repeat?.timeZone),
        () => timeZone
      )
    )}`,
    ...(schedule.repeat === undefined
      ? []
      : [`repeats ${recurrenceText(schedule.repeat.rule)}`]),
    ...(schedule.openLoopIds.length === 0
      ? []
      : [openLoopIdsText(schedule.openLoopIds)]),
  ].join(", ");

const pendingApprovalLine = (
  { pendingApprovalId, toolName, expiresAt }: PendingApproval,
  timeZone: OwnerTimeZone
) =>
  `- ${pendingApprovalId}: ${toolName}, expires ${timeText(DateTime.makeUnsafe(expiresAt), timeZone)}`;

const section = (heading: string, lines: readonly string[]) =>
  lines.length === 0 ? [] : [heading, ...lines];

export const openItemsText = ({
  listedAt,
  timeZone,
  openLoops,
  schedules,
  pendingApprovals,
}: OpenItems) => {
  const shownSchedules = schedules.slice(0, openItemsPerKind);
  const shownApprovals = pendingApprovals.slice(0, openItemsPerKind);
  const lines = [
    ...section("Notes with an open Open Loop (the earliest due first):", [
      ...openLoops.notes.map((note) => openLoopLine(note, timeZone)),
      ...moreLine(
        openLoops.openLoopCount - openLoops.notes.length,
        `: call ${listOpenLoopsToolName}`
      ),
    ]),
    ...section("Active Schedules (the earliest due first):", [
      ...shownSchedules.map((schedule) => scheduleLine(schedule, timeZone)),
      ...moreLine(
        schedules.length - shownSchedules.length,
        `: call ${listSchedulesToolName}`
      ),
    ]),
    ...section("Pending Approvals that wait for the Owner:", [
      ...shownApprovals.map((approval) =>
        pendingApprovalLine(approval, timeZone)
      ),
      ...moreLine(pendingApprovals.length - shownApprovals.length, ""),
    ]),
  ];
  return [
    `Open items when code wrote this Summary (${timeText(listedAt, timeZone)}). Code listed them from storage. They can be out of date: call ${listOpenLoopsToolName} or ${listSchedulesToolName} for the current state.`,
    ...(lines.length === 0 ? ["None were open."] : lines),
  ].join("\n");
};

export const openItemsOf = Effect.fnUntraced(function* openItemsOf(
  behavior: Pick<BehaviorConfig, "defaultTimeZone">
) {
  const notes = yield* Notes;
  const schedules = yield* Schedules;
  return {
    listedAt: yield* DateTime.now,
    timeZone: yield* ownerTimeZone(behavior),
    openLoops: yield* notes.listOpenLoops({
      offset: 0,
      limit: openItemsPerKind,
    }),
    schedules: yield* schedules.listActive,
    pendingApprovals: yield* openApprovals,
  } satisfies OpenItems;
});
