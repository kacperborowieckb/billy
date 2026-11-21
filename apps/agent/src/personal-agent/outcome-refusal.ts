import type { ModelMessage } from "ai";
import { Effect } from "effect";

import { Journal } from "../journal/journal.ts";
import type { JournalRecord } from "../journal/journal.ts";
import { toolNamed } from "../model-gateway/agent-tool.ts";
import type { AgentTools } from "../model-gateway/agent-tool.ts";
import type { ModelStep } from "../model-gateway/model-step.ts";
import { reactToolName, reactionAfterFailureMessage } from "./react-tool.ts";
import {
  silenceAfterChangeMessage,
  silenceAfterFailureMessage,
  staySilentToolName,
} from "./stay-silent-tool.ts";

export const unknownOutcomeToolMessage =
  "This tool is not available. Answer the Owner with a text.";

export const outcomeWhileApprovalWaitsMessage =
  "A call in this Turn waits for the Owner's Approval, so the Owner must get a text reply with the Approval buttons. Answer the Owner with a short text that says what waits for their Approval.";

const ownerDataChanges: ReadonlySet<JournalRecord["_tag"]> = new Set([
  "NoteCaptured",
  "NoteUpdated",
  "OpenLoopOpened",
  "OpenLoopChanged",
  "OpenLoopClosed",
  "ProfileEntryAdded",
  "ProfileEntryRemoved",
  "ScheduleSet",
  "ScheduleChanged",
  "ScheduleCancelled",
  "BriefCreated",
  "OwnerPreferenceChanged",
  "ProactiveMuteChanged",
]);

interface OutcomeToolCall {
  readonly eventId: string;
  readonly name: string;
  readonly steps: readonly ModelStep[];
  readonly earlierMessages: readonly ModelMessage[];
  readonly tools: AgentTools;
  readonly approvalWaits: boolean;
}

const failedOutputTypes: ReadonlySet<string> = new Set([
  "error-text",
  "error-json",
  "execution-denied",
]);

const failedCallIdsOf = (messages: readonly ModelMessage[]) =>
  new Set(
    messages.flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result" &&
            failedOutputTypes.has(part.output.type)
              ? [part.toolCallId]
              : []
          )
        : []
    )
  );

const toolCallsOf = (messages: readonly ModelMessage[]) =>
  messages.flatMap((message) =>
    message.role === "assistant" && typeof message.content !== "string"
      ? message.content.flatMap((part) =>
          part.type === "tool-call" ? [part] : []
        )
      : []
  );

type CallInput = "exact" | "recorded";

const isReadCall = (
  tools: AgentTools,
  call: { readonly toolName: string; readonly input: unknown },
  callInput: CallInput
) => {
  const tool = toolNamed(tools, call.toolName);
  if (tool === undefined) {
    return false;
  }
  return callInput === "exact"
    ? tool.riskClassOf(call.input) === "read"
    : tool.readsForEveryInput;
};

const aChangingCallFailed = (
  tools: AgentTools,
  messages: readonly ModelMessage[],
  callInput: CallInput
) => {
  const failed = failedCallIdsOf(messages);
  return toolCallsOf(messages).some(
    (call) => failed.has(call.toolCallId) && !isReadCall(tools, call, callInput)
  );
};

export const refusalOfOutcomeTool = Effect.fnUntraced(
  function* refusalOfOutcomeTool({
    eventId,
    name,
    steps,
    earlierMessages,
    tools,
    approvalWaits,
  }: OutcomeToolCall) {
    if (
      !(name in tools) ||
      (name !== staySilentToolName && name !== reactToolName)
    ) {
      return unknownOutcomeToolMessage;
    }
    if (approvalWaits) {
      return outcomeWhileApprovalWaitsMessage;
    }
    const changeFailed =
      aChangingCallFailed(tools, earlierMessages, "recorded") ||
      aChangingCallFailed(
        tools,
        steps.flatMap((step) => step.responseMessages),
        "exact"
      );
    if (changeFailed) {
      return name === reactToolName
        ? reactionAfterFailureMessage
        : silenceAfterFailureMessage;
    }
    if (name === reactToolName) {
      return;
    }
    const journal = yield* Journal;
    const entries = yield* journal.readForEvent(eventId);
    return entries.some((entry) => ownerDataChanges.has(entry.record._tag))
      ? silenceAfterChangeMessage
      : undefined;
  }
);

export const defaultReactionAllowed = Effect.fnUntraced(
  function* defaultReactionAllowed(call: Omit<OutcomeToolCall, "name">) {
    const silenceRefusal = yield* refusalOfOutcomeTool({
      ...call,
      name: staySilentToolName,
    });
    const reactionRefusal = yield* refusalOfOutcomeTool({
      ...call,
      name: reactToolName,
    });
    return (
      silenceRefusal === silenceAfterChangeMessage &&
      reactionRefusal === undefined
    );
  }
);
