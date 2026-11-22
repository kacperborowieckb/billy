import { Effect, Option } from "effect";

import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { noActiveScheduleMessage } from "./schedule-presentation.ts";
import type { Schedules } from "./schedules.ts";

export const activeScheduleOf = (
  schedules: Schedules["Service"],
  scheduleId: string,
  readFailedMessage: string
) =>
  schedules.byId(scheduleId).pipe(
    Effect.mapError(() => new ToolFailed({ message: readFailedMessage })),
    Effect.flatMap((stored) =>
      Option.isSome(stored) && stored.value.state === "active"
        ? Effect.succeed(stored.value)
        : Effect.fail(
            new ToolFailed({ message: noActiveScheduleMessage(scheduleId) })
          )
    )
  );
