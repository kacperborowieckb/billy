import { Effect } from "effect";

import { McpFlowFailed } from "./flow-failed.ts";

export const flowCheck = (step: string, holds: boolean, detail: string) =>
  holds ? Effect.void : Effect.fail(new McpFlowFailed({ step, detail }));
