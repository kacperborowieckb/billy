import { Effect } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { refuseAtAgentScheduleLimit } from "./active-agent-schedule-limit-reached.ts";
import { refuseAtScheduledTaskLimit } from "./active-scheduled-task-limit-reached.ts";
import type { Schedules } from "./schedules.ts";

const toolFailedOn =
  (readFailedMessage: string) =>
  <A, E, R>(effect: Effect.Effect<A, E | ToolFailed, R>) =>
    effect.pipe(
      Effect.mapError((failure) =>
        failure instanceof ToolFailed
          ? failure
          : new ToolFailed({ message: readFailedMessage })
      )
    );

export const requireRoomForScheduledTask = (
  schedules: Schedules["Service"],
  limit: number,
  readFailedMessage: string
) =>
  schedules
    .requireRoomForScheduledTask(limit)
    .pipe(refuseAtScheduledTaskLimit, toolFailedOn(readFailedMessage));

export const requireRoomForAgentSchedule = (
  schedules: Schedules["Service"],
  limit: number,
  readFailedMessage: string
) =>
  schedules
    .requireRoomForAgentSchedule(limit)
    .pipe(refuseAtAgentScheduleLimit, toolFailedOn(readFailedMessage));
