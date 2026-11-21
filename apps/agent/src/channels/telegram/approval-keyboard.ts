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

interface OpenBlock {
  readonly lines: readonly string[];
  readonly rows: InlineKeyboard;
  readonly pendingApprovalIds: readonly string[];
}

const closed = (block: OpenBlock): ApprovalBlock => ({
  text: block.lines.join("\n"),
  keyboard: block.rows,
  pendingApprovalIds: block.pendingApprovalIds,
});

export const approvalBlocksOf = (
  approvals: readonly ApprovalRequest[],
  textLimit: number
): readonly ApprovalBlock[] => {
  const blocks: ApprovalBlock[] = [];
  let open: OpenBlock = {
    lines: [headerOf(approvals)],
    rows: [],
    pendingApprovalIds: [],
  };
  for (const [index, approval] of approvals.entries()) {
    const line = lineOf(approval, index, approvals);
    const grown = [...open.lines, line].join("\n");
    if (open.rows.length > 0 && grown.length > textLimit) {
      blocks.push(closed(open));
      open = { lines: [], rows: [], pendingApprovalIds: [] };
    }
    open = {
      lines: [...open.lines, line],
      rows: [...open.rows, rowOf(approval, index, approvals)],
      pendingApprovalIds: [
        ...open.pendingApprovalIds,
        approval.pendingApprovalId,
      ],
    };
  }
  blocks.push(closed(open));
  return blocks;
};
