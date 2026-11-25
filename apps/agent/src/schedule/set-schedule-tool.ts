import { DateTime, Effect, Option } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { closedOpenLoopsAmong, knownNotesOf } from "../notes/known-notes.ts";
import { noteToolFailureMessage } from "../notes/note-tool-failure-message.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { setTimeZoneToolName } from "../preferences/set-time-zone-tool.ts";
import { localDueTimeFormat } from "../time/local-due-time.ts";
import { refuseAtAgentScheduleLimit } from "./active-agent-schedule-limit-reached.ts";
import { refuseAtScheduledTaskLimit } from "./active-scheduled-task-limit-reached.ts";
import { notOpenLoopsMessage, refuseNotOpenLoops } from "./not-open-loops.ts";
import { resolveScheduleDue } from "./schedule-due.ts";
import { scheduleOf } from "./schedule-presentation.ts";
import {
  requireRoomForAgentSchedule,
  requireRoomForScheduledTask,
} from "./schedule-room.ts";
import { scheduleActionText, scheduleDueText } from "./schedule-summary.ts";
import type { ScheduleToolServices } from "./schedule-tool-services.ts";
import {
  followUpWithFixedPrompt,
  SetScheduleInput,
} from "./set-schedule-input.ts";
import type { SetScheduleCall } from "./set-schedule-input.ts";

export const setScheduleToolName = "set_schedule";

export const scheduleNotSetMessage =
  "The Schedule was not set. Tell the Owner that you could not set it.";

export const noTimeZoneForScheduleMessage = `The time zone of the Owner is not known, so no Schedule was set. Ask the Owner where they live or for their time zone, call ${setTimeZoneToolName}, and then set the Schedule.`;

export const invalidLocalDueTimeMessage = `The due time is not a real local date and time in the form ${localDueTimeFormat}. No Schedule was set. Check the date and call ${setScheduleToolName} again.`;

export const dueTimeInThePastMessage =
  "The due time is in the past, so no Schedule was set. Tell the Owner that the time has passed and ask for a time in the future.";

export const noDueGivenMessage = `Neither a local due time nor a repeat rule was given, so no Schedule was set. Ask the Owner when the Schedule is due, and call ${setScheduleToolName} again.`;

export const dueAndRepeatGivenMessage = `Both a local due time and a repeat rule were given, so no Schedule was set. Give only one of them and call ${setScheduleToolName} again.`;

export const mutedOpenLoopsMessage = (noteIds: readonly string[]) =>
  `The Owner asked for less of these Open Loops: ${noteIds.join(", ")}. No Schedule was set. They appear only in the Brief. Set no follow-up for them.`;

export const followUpNeedsOpenLoopsMessage = `A follow-up needs at least one Open Loop and the RunPrompt Action, so no Schedule was set. Pass the ids of the Open Loops in openLoopIds, with a RunPrompt action, and call ${setScheduleToolName} again.`;

const resolveSet = (
  {
    schedules,
    notes,
    ownerTimeZone,
    mutedAmong,
    turnOrigin,
    maxActiveScheduledTasks,
    maxActiveAgentSchedules,
  }: ScheduleToolServices,
  eventId: string
) =>
  Effect.fnUntraced(function* resolveSetEffect({
    action,
    localDueTime,
    repeat,
    noteId,
    openLoopIds = [],
    ownerAskedForSchedule,
  }: SetScheduleCall) {
    const hasOpenLoops = openLoopIds.length > 0;
    const isFollowUp =
      turnOrigin === "proactive" ||
      (hasOpenLoops && ownerAskedForSchedule !== true);
    if (isFollowUp && (!hasOpenLoops || action._tag !== "RunPrompt")) {
      return yield* new ToolFailed({ message: followUpNeedsOpenLoopsMessage });
    }
    if (isFollowUp) {
      const muted = yield* mutedAmong(openLoopIds).pipe(
        Effect.mapError(
          () => new ToolFailed({ message: scheduleNotSetMessage })
        )
      );
      if (muted.length > 0) {
        return yield* new ToolFailed({ message: mutedOpenLoopsMessage(muted) });
      }
    }
    const timeZone = yield* ownerTimeZone;
    if (Option.isNone(timeZone)) {
      return yield* new ToolFailed({ message: noTimeZoneForScheduleMessage });
    }
    const due = yield* resolveScheduleDue(
      { localDueTime, repeat },
      timeZone.value,
      {
        bothGiven: dueAndRepeatGivenMessage,
        invalidLocalDueTime: invalidLocalDueTimeMessage,
        localDueTimeInThePast: dueTimeInThePastMessage,
      }
    );
    if (Option.isNone(due)) {
      return yield* new ToolFailed({ message: noDueGivenMessage });
    }
    yield* knownNotesOf(
      notes,
      [...(noteId === undefined ? [] : [noteId]), ...openLoopIds],
      {
        consequence: "No Schedule was set.",
        readFailed: scheduleNotSetMessage,
      }
    );
    const setBy = isFollowUp ? ("agent" as const) : ("owner" as const);
    const alreadySet = yield* schedules
      .isAlreadySet({
        action,
        setBy,
        noteId,
        openLoopIds,
        dueAt: due.value.dueAt,
        repeat: due.value.repeat,
        sourceEventId: eventId,
      })
      .pipe(
        Effect.mapError(
          () => new ToolFailed({ message: scheduleNotSetMessage })
        )
      );
    if (!alreadySet) {
      const notOpen = yield* closedOpenLoopsAmong(
        notes,
        openLoopIds,
        scheduleNotSetMessage
      );
      if (notOpen.length > 0) {
        return yield* new ToolFailed({ message: notOpenLoopsMessage(notOpen) });
      }
      if (setBy === "agent") {
        yield* requireRoomForAgentSchedule(
          schedules,
          maxActiveAgentSchedules,
          scheduleNotSetMessage
        );
      } else if (action._tag === "RunPrompt") {
        yield* requireRoomForScheduledTask(
          schedules,
          maxActiveScheduledTasks,
          scheduleNotSetMessage
        );
      }
    }
    return {
      action,
      setBy,
      noteId,
      openLoopIds,
      due: due.value,
      timeZone: timeZone.value,
      dueText: scheduleDueText({ localDueTime, repeat }),
    };
  });

export const setScheduleTool = (
  services: ScheduleToolServices,
  eventId: string
) => {
  const {
    schedules,
    progress,
    redactor,
    maxActiveScheduledTasks,
    maxActiveAgentSchedules,
  } = services;
  return recordedTool(
    { eventId, progress, redactor },
    {
      name: setScheduleToolName,
      riskClass: "change",
      resolve: resolveSet(services, eventId),
      approvalSummary: ({ action, dueText }) =>
        `Set ${scheduleActionText(action)}, ${dueText}`,
      description:
        "Set a Schedule for the Owner, one-time with localDueTime or repeating with repeat. The action says what happens at the due time. With SendText, the saved text is sent to the Owner in the chat; use it for fixed words for the Owner, such as a Reminder. With RunPrompt, the agent runs the saved prompt at the due time and sends the result. This is a Scheduled Task. A follow-up is a RunPrompt Schedule that you set yourself with openLoopIds, when the Owner did not ask for a Schedule (leave out ownerAskedForSchedule): set one before the due date of an Open Loop, and one when an Open Loop had no change for about a day. When a follow-up fires, you can set the next one the same way. Use it for work to do at the due time, such as listing open tasks from the Notes of that day. Give times as the local time of the Owner. Fails with a message when the time zone is not known, neither or both of localDueTime and repeat are given, the time is in the past, or the time is not real. Say that the Schedule is set only after it succeeded, and give the local date, weekday, and time of the first due time that it returns, and for a repeating Schedule how it repeats.",
      inputSchema: SetScheduleInput,
      codeWrittenInput: followUpWithFixedPrompt,
      failureMessage: (cause) =>
        noteToolFailureMessage(cause, {
          unknownNotesConsequence: "No Schedule was set.",
          otherwise: scheduleNotSetMessage,
        }),
      work: Effect.fnUntraced(function* storeScheduleEffect({
        action,
        setBy,
        noteId,
        openLoopIds,
        due,
        timeZone,
      }) {
        const { schedule: stored, alreadySet } = yield* schedules
          .set({
            action,
            setBy,
            noteId,
            openLoopIds,
            dueAt: due.dueAt,
            repeat: due.repeat,
            sourceEventId: eventId,
            activeScheduledTaskLimit: maxActiveScheduledTasks,
            activeAgentScheduleLimit: maxActiveAgentSchedules,
          })
          .pipe(
            refuseAtScheduledTaskLimit,
            refuseAtAgentScheduleLimit,
            refuseNotOpenLoops
          );
        return {
          ...scheduleOf(stored, timeZone),
          timeZone: DateTime.zoneToString(timeZone),
          alreadySet,
        };
      }),
    }
  );
};
