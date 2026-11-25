import { Schema } from "effect";

import {
  localDueTimeFormat,
  LocalDueTimeSchema,
} from "../time/local-due-time.ts";
import { RecurrenceRuleSchema } from "../time/recurrence-rule.ts";
import { fixedFollowUpPrompt } from "./fixed-follow-up-prompt.ts";
import { ScheduleActionInputSchema } from "./schedule-action-input.ts";

export const maxOpenLoopIdsPerSchedule = 20;

export const SetScheduleInput = Schema.Struct({
  action: ScheduleActionInputSchema,
  localDueTime: Schema.optionalKey(
    LocalDueTimeSchema.pipe(
      Schema.annotate({
        description: `For a one-time Schedule: the local date and time of the Owner when it is due, as ${localDueTimeFormat} with no time zone or offset, for example 2026-11-19T09:00. Work it out from the current local time that you were given. Leave it out when you give repeat.`,
      })
    )
  ),
  repeat: Schema.optionalKey(
    RecurrenceRuleSchema.pipe(
      Schema.annotate({
        description:
          'For a repeating Schedule: the rule, for example {"_tag":"Weekly","weekdays":["Monday"],"time":"09:00"}, {"_tag":"Daily","time":"08:00"}, or {"_tag":"Monthly","day":"last","time":"18:00"}. The time is the local time of the Owner and stays the same when daylight saving time changes. Leave out localDueTime when you give repeat.',
      })
    )
  ),
  noteId: Schema.optionalKey(
    Schema.String.pipe(
      Schema.annotate({
        description:
          "The id of the Note that this Schedule is about, when the Owner asked for the Schedule together with something to keep. Use an id that capture_note or search_notes returned.",
      })
    )
  ),
  openLoopIds: Schema.optionalKey(
    Schema.Array(Schema.String).pipe(
      Schema.check(Schema.isMaxLength(maxOpenLoopIdsPerSchedule)),
      Schema.annotate({
        description:
          "The ids of the Open Loops (Notes with an Open Loop) that this Schedule is about. Give them for a follow-up that you set yourself: a RunPrompt Schedule before the due date of an Open Loop, or one check on an Open Loop that had no change for about a day. Use ids that list_open_loops, search_notes, or capture_note returned. Leave them out for a Schedule that the Owner asked for.",
      })
    )
  ),
  ownerAskedForSchedule: Schema.optionalKey(
    Schema.Boolean.pipe(
      Schema.annotate({
        description:
          "Set true only when the Owner asked in this message for this Schedule. Leave it out for a follow-up that you set yourself with openLoopIds.",
      })
    )
  ),
});

export type SetScheduleCall = typeof SetScheduleInput.Type;

export const followUpWithFixedPrompt = ({
  localDueTime,
  repeat,
  openLoopIds = [],
}: SetScheduleCall): SetScheduleCall => ({
  action: { _tag: "RunPrompt", prompt: fixedFollowUpPrompt(openLoopIds) },
  ...(localDueTime === undefined ? {} : { localDueTime }),
  ...(repeat === undefined ? {} : { repeat }),
  openLoopIds,
});
