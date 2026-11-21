import type { ApprovalRequest } from "../channel.ts";

export interface InlineKeyboardButton {
  readonly text: string;
  readonly callback_data: string;
}

export type InlineKeyboard = readonly (readonly InlineKeyboardButton[])[];

export const approvalAnswers = ["approve", "reject"] as const;

export type ApprovalAnswer = (typeof approvalAnswers)[number];

export const approvalCallbackData = (
  answer: ApprovalAnswer,
  pendingApprovalId: string
) => `${answer}:${pendingApprovalId}`;

const numbered = (approvals: readonly ApprovalRequest[]) =>
  approvals.length > 1;

export const approvalRequestText = (approvals: readonly ApprovalRequest[]) =>
  [
    approvals.length > 1
      ? "These wait for your Approval:"
      : "This waits for your Approval:",
    ...approvals.map(({ summary }, index) =>
      numbered(approvals) ? `${index + 1}. ${summary}` : summary
    ),
  ].join("\n");

const buttonLabel = (label: string, index: number, all: boolean) =>
  all ? `${label} ${index + 1}` : label;

export const approvalKeyboardOf = (
  approvals: readonly ApprovalRequest[]
): InlineKeyboard =>
  approvals.map(({ pendingApprovalId }, index) => [
    {
      text: buttonLabel("Approve", index, numbered(approvals)),
      callback_data: approvalCallbackData("approve", pendingApprovalId),
    },
    {
      text: buttonLabel("Reject", index, numbered(approvals)),
      callback_data: approvalCallbackData("reject", pendingApprovalId),
    },
  ]);
