import type { JSONValue, ModelMessage } from "ai";

import { waitingForApprovalOutput } from "../approval/draft-approval.ts";
import type { DraftOutcome } from "../approval/draft-approval.ts";
import type {
  ApprovalRequestedCall,
  ModelStep,
  PendingToolCall,
} from "../model-gateway/model-step.ts";

export interface ClosingResult {
  readonly call: PendingToolCall;
  readonly output: JSONValue;
  readonly failed: boolean;
  readonly failureIsToolError?: boolean;
}

const outputTextOf = (output: JSONValue) =>
  typeof output === "string" ? output : JSON.stringify(output);

const resultOutputOf = ({ output, failureIsToolError }: ClosingResult) => {
  if (failureIsToolError === true) {
    return { type: "error-text", value: outputTextOf(output) } as const;
  }
  return typeof output === "string"
    ? ({ type: "text", value: output } as const)
    : ({ type: "json", value: output } as const);
};

const toolResultMessage = (result: ClosingResult): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: result.call.callId,
      toolName: result.call.name,
      output: resultOutputOf(result),
    },
  ],
});

export const closeLastStep = (
  steps: readonly ModelStep[],
  results: readonly ClosingResult[]
): readonly ModelStep[] => {
  const last = steps.at(-1);
  if (last === undefined) {
    return steps;
  }
  return [
    ...steps.slice(0, -1),
    {
      ...last,
      toolCalls: [
        ...last.toolCalls,
        ...results.map(({ call, output, failed }) => ({
          callId: call.callId,
          name: call.name,
          input: call.input,
          output: outputTextOf(output),
          failed,
        })),
      ],
      responseMessages: [
        ...last.responseMessages,
        ...results.map(toolResultMessage),
      ],
    },
  ];
};

export const sameOutputFor = (
  calls: readonly PendingToolCall[],
  output: JSONValue,
  failed: boolean
): readonly ClosingResult[] => calls.map((call) => ({ call, output, failed }));

const pendingCallOf = (call: ApprovalRequestedCall): PendingToolCall => ({
  callId: call.callId,
  name: call.name,
  input: JSON.stringify(call.input) ?? "null",
});

export const approvalResultOf = (
  call: ApprovalRequestedCall,
  drafted: DraftOutcome
): ClosingResult =>
  drafted._tag === "Drafted"
    ? {
        call: pendingCallOf(call),
        output: waitingForApprovalOutput(drafted.draft.pendingApprovalId),
        failed: false,
      }
    : {
        call: pendingCallOf(call),
        output: drafted.reason,
        failed: true,
        failureIsToolError: true,
      };
