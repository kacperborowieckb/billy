import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import { DateTime, Effect, Option, Schema } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { McpCallOutputSchema } from "../mcp/mcp-call-output.ts";
import {
  callMcpToolToolName,
  findMcpToolsToolName,
} from "../mcp/mcp-tool-names.ts";
import { closeOpenLoopToolName } from "../notes/close-open-loop-tool.ts";
import { listLinkedNotesToolName } from "../notes/list-linked-notes-tool.ts";
import { listOpenLoopsToolName } from "../notes/list-open-loops-tool.ts";
import { searchNotesToolName } from "../notes/search-notes-tool.ts";
import { briefPrompt } from "../schedule/brief-prompt.ts";
import { listSchedulesToolName } from "../schedule/list-schedules-tool.ts";
import type { Schedule } from "../schedule/schedule.ts";
import { setScheduleToolName } from "../schedule/set-schedule-tool.ts";
import { localTimeOf } from "../time/local-time.ts";
import { ownerTimeZone } from "../time/owner-current-time.ts";
import {
  assistantPartsOf,
  isToolCall,
  noteIdsOf,
  storedToolNameOf,
  toolCallStatusOf,
  toolOutputsOf,
} from "./conversation-stubs.ts";
import type { ScheduleFiredEvent } from "./inbox.ts";
import type { WriteBackKind } from "./storage-values.ts";

export interface WriteBackMarker {
  readonly kind: WriteBackKind;
  readonly localTime: string;
}

export const writeBackKindOf = (
  schedule: Option.Option<Schedule>
): WriteBackKind => {
  if (Option.isNone(schedule)) {
    return "Schedule";
  }
  const { action, setBy } = schedule.value;
  if (action._tag === "SendText") {
    return "Reminder";
  }
  if (setBy === "owner") {
    return "Scheduled Task";
  }
  return action.prompt === briefPrompt ? "Brief" : "Follow-up";
};

export const writeBackMarkerOf = Effect.fnUntraced(function* writeBackMarkerOf(
  behavior: Pick<BehaviorConfig, "defaultTimeZone">,
  event: ScheduleFiredEvent,
  schedule: Option.Option<Schedule>
) {
  const dueAt = DateTime.makeUnsafe(event.dueAt);
  const timeZone = yield* ownerTimeZone(behavior);
  return {
    kind: writeBackKindOf(schedule),
    localTime: Option.isSome(timeZone)
      ? localTimeOf(dueAt, timeZone.value)
      : `${DateTime.formatIso(dueAt)} UTC`,
  } satisfies WriteBackMarker;
});

const markerText = ({ kind, localTime }: WriteBackMarker) =>
  `[${kind}, ${localTime}]`;

const sentTextRemoved = "sent to the Owner. Text removed from the history";

const readToolNames: ReadonlySet<string> = new Set([
  searchNotesToolName,
  listLinkedNotesToolName,
  listOpenLoopsToolName,
  listSchedulesToolName,
]);

const decodeMcpCallOutput = Schema.decodeUnknownOption(McpCallOutputSchema);

const FoundMcpToolsOutput = Schema.Struct({
  connection: Schema.String,
  matchCount: Schema.Int,
});

const decodeFoundMcpToolsOutput =
  Schema.decodeUnknownOption(FoundMcpToolsOutput);

const connectionsReadBy = ({ call, output }: SucceededCall): string[] => {
  if (output.type !== "json") {
    return [];
  }
  if (call.toolName === findMcpToolsToolName) {
    const found = decodeFoundMcpToolsOutput(output.value);
    return found._tag === "Some" && found.value.matchCount > 0
      ? [found.value.connection]
      : [];
  }
  if (call.toolName !== callMcpToolToolName) {
    return [];
  }
  const decoded = decodeMcpCallOutput(output.value);
  return decoded._tag === "Some" && decoded.value.result !== undefined
    ? [decoded.value.connection]
    : [];
};

const isMcpTool = ({ call }: SucceededCall) =>
  call.toolName === callMcpToolToolName ||
  call.toolName === findMcpToolsToolName;

const SetScheduleOutput = Schema.Struct({
  openLoopIds: Schema.Array(Schema.String.pipe(Schema.check(Schema.isUUID()))),
  due: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^[A-Z][a-z]+day \d{4}-\d{2}-\d{2}, \d{2}:\d{2}$/u)
    )
  ),
});

const isSetScheduleOutput = Schema.is(SetScheduleOutput);

type ToolOutput = ToolResultPart["output"];

const setScheduleChangeText = (output: ToolOutput) => {
  const value = output.type === "json" ? output.value : undefined;
  if (!isSetScheduleOutput(value)) {
    return "set a Schedule";
  }
  return value.openLoopIds.length === 0
    ? `set a Schedule for ${value.due}`
    : `set a follow-up for ${value.openLoopIds.join(", ")} on ${value.due}`;
};

const closeOpenLoopChangeText = (output: ToolOutput) => {
  const ids = noteIdsOf(output);
  return ids.length === 0
    ? "closed an Open Loop"
    : `closed the Open Loop of ${ids.join(", ")}`;
};

const changeTextOf = (toolName: string, output: ToolOutput) => {
  switch (toolName) {
    case setScheduleToolName: {
      return setScheduleChangeText(output);
    }
    case closeOpenLoopToolName: {
      return closeOpenLoopChangeText(output);
    }
    default: {
      return `${storedToolNameOf(toolName)} done`;
    }
  }
};

interface SucceededCall {
  readonly call: ToolCallPart;
  readonly output: ToolOutput;
}

const RepeatedChangeOutput = Schema.Union([
  Schema.Struct({ alreadySet: Schema.Literal(true) }),
  Schema.Struct({ alreadyClosed: Schema.Literal(true) }),
]);

const isRepeatedChangeOutput = Schema.is(RepeatedChangeOutput);

const changedSomething = (output: ToolOutput) =>
  !(output.type === "json" && isRepeatedChangeOutput(output.value));

const succeededCallsOf = (steps: readonly ModelMessage[]) => {
  const outputs = toolOutputsOf(steps);
  return steps.flatMap((message) =>
    assistantPartsOf(message)
      .filter(isToolCall)
      .flatMap((call): readonly SucceededCall[] => {
        const output = outputs.get(call.toolCallId);
        return output !== undefined && toolCallStatusOf(output) === "done"
          ? [{ call, output }]
          : [];
      })
  );
};

const runLineOf = (steps: readonly ModelMessage[]) => {
  const succeeded = succeededCallsOf(steps);
  const changes = succeeded
    .filter(
      (succeededCall) =>
        !readToolNames.has(succeededCall.call.toolName) &&
        !isMcpTool(succeededCall) &&
        changedSomething(succeededCall.output)
    )
    .map(({ call, output }) => changeTextOf(call.toolName, output));
  const sources = [
    ...new Set([
      ...succeeded
        .filter(({ call }) => readToolNames.has(call.toolName))
        .map(({ call }) => call.toolName),
      ...succeeded.flatMap(connectionsReadBy),
    ]),
  ];
  const parts = [
    ...(changes.length === 0
      ? []
      : [`done in this run: ${changes.join(", ")}`]),
    ...(sources.length === 0 ? [] : [`read: ${sources.join(", ")}`]),
  ];
  return parts.length === 0 ? [] : [`(${parts.join("; ")})`];
};

export interface WriteBack {
  readonly marker: WriteBackMarker;
  readonly text: string;
  readonly steps: readonly ModelMessage[];
  readonly heldUntrustedContent: boolean;
}

export const writeBackMessageOf = ({
  marker,
  text,
  steps,
  heldUntrustedContent,
}: WriteBack): ModelMessage => ({
  role: "assistant",
  content: [
    `${markerText(marker)} ${heldUntrustedContent ? sentTextRemoved : text}`,
    ...runLineOf(steps),
  ].join("\n"),
});
