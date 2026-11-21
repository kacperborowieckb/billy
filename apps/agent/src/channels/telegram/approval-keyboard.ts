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

const headerOf = (approvals: readonly ApprovalRequest[]) =>
  approvals.length > 1
    ? "These wait for your Approval:"
    : "This waits for your Approval:";

const lineOf = (
  { summary }: ApprovalRequest,
  index: number,
  approvals: readonly ApprovalRequest[]
) => (approvals.length > 1 ? `${index + 1}. ${summary}` : summary);

const rowOf = (
  { pendingApprovalId }: ApprovalRequest,
  index: number,
  approvals: readonly ApprovalRequest[]
): readonly InlineKeyboardButton[] => {
  const label = (answer: string) =>
    approvals.length > 1 ? `${answer} ${index + 1}` : answer;
  return [
    {
      text: label("Approve"),
      callback_data: approvalCallbackData("approve", pendingApprovalId),
    },
    {
      text: label("Reject"),
      callback_data: approvalCallbackData("reject", pendingApprovalId),
    },
  ];
};

export interface ApprovalBlock {
  readonly text: string;
  readonly keyboard: InlineKeyboard;
  readonly pendingApprovalIds: readonly string[];
}

interface ApprovalRow {
  readonly line: string;
  readonly buttons: readonly InlineKeyboardButton[];
  readonly pendingApprovalId: string;
}

const blockOf = (
  header: readonly string[],
  rows: readonly ApprovalRow[]
): ApprovalBlock => ({
  text: [...header, ...rows.map(({ line }) => line)].join("\n"),
  keyboard: rows.map(({ buttons }) => buttons),
  pendingApprovalIds: rows.map(({ pendingApprovalId }) => pendingApprovalId),
});

export const approvalBlocksOf = (
  approvals: readonly ApprovalRequest[],
  textLimit: number
): readonly ApprovalBlock[] => {
  const rows = approvals.map((approval, index): ApprovalRow => ({
    line: lineOf(approval, index, approvals),
    buttons: rowOf(approval, index, approvals),
    pendingApprovalId: approval.pendingApprovalId,
  }));
  const blocks: ApprovalBlock[] = [];
  let header: readonly string[] = [headerOf(approvals)];
  let open: readonly ApprovalRow[] = [];
  for (const row of rows) {
    const grown = blockOf(header, [...open, row]);
    if (open.length > 0 && grown.text.length > textLimit) {
      blocks.push(blockOf(header, open));
      header = [];
      open = [];
    }
    open = [...open, row];
  }
  blocks.push(blockOf(header, open));
  return blocks;
};
