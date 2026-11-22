import { maxStatusLength } from "../../approval/approval-status.ts";
import type { ApprovalAnswer } from "../../event.ts";
import { approvalAnswers } from "../../personal-agent/storage-values.ts";
import type { ApprovalRequest, ShownApproval } from "../channel.ts";

export interface InlineKeyboardButton {
  readonly text: string;
  readonly callback_data: string;
}

export type InlineKeyboard = readonly (readonly InlineKeyboardButton[])[];

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

const statusLineRoom = 1 + maxStatusLength;

const textWithRoomForStatuses = (block: ApprovalBlock) =>
  block.text.length + block.pendingApprovalIds.length * statusLineRoom;

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
    if (open.length > 0 && textWithRoomForStatuses(grown) > textLimit) {
      blocks.push(blockOf(header, open));
      header = [];
      open = [];
    }
    open = [...open, row];
  }
  blocks.push(blockOf(header, open));
  return blocks;
};

const callbackDataPattern = new RegExp(
  `^(${approvalAnswers.join("|")}):([A-Za-z0-9_-]{12})$`,
  "u"
);

export interface ApprovalPressData {
  readonly answer: ApprovalAnswer;
  readonly pendingApprovalId: string;
}

const isApprovalAnswer = (value: string): value is ApprovalAnswer =>
  approvalAnswers.some((answer) => answer === value);

export const approvalPressDataOf = (
  data: string
): ApprovalPressData | undefined => {
  const [, answer, pendingApprovalId] = callbackDataPattern.exec(data) ?? [];
  return answer !== undefined &&
    pendingApprovalId !== undefined &&
    isApprovalAnswer(answer)
    ? { answer, pendingApprovalId }
    : undefined;
};

const answeredSummaryLength = 100;

const wellFormedPrefix = (text: string, length: number) => {
  const prefix = text.slice(0, length);
  return prefix.isWellFormed() ? prefix : prefix.slice(0, -1);
};

const shortened = (summary: string) =>
  summary.length <= answeredSummaryLength
    ? summary
    : `${wellFormedPrefix(summary, answeredSummaryLength)}...`;

const shownLineOf = (
  approval: ShownApproval,
  index: number,
  turnApprovals: readonly ShownApproval[]
) =>
  approval.status === undefined
    ? lineOf(approval, index, turnApprovals)
    : `${lineOf(approval, index, turnApprovals)}\n${approval.status}`;

const withShortenedAnswer = (approval: ShownApproval): ShownApproval =>
  approval.status === undefined
    ? approval
    : { ...approval, summary: shortened(approval.summary) };

export const editedApprovalBlockOf = (
  turnApprovals: readonly ShownApproval[],
  channelMessageId: string,
  textLimit: number
): ApprovalBlock => {
  const shown = turnApprovals
    .map((approval, index) => ({ approval, index }))
    .filter(({ approval }) => approval.channelMessageId === channelMessageId);
  const header =
    turnApprovals[0]?.channelMessageId === channelMessageId
      ? [headerOf(turnApprovals)]
      : [];
  const textOf = (shape: (approval: ShownApproval) => ShownApproval) =>
    [
      ...header,
      ...shown.map(({ approval, index }) =>
        shownLineOf(shape(approval), index, turnApprovals)
      ),
    ].join("\n");
  const full = textOf((approval) => approval);
  const fitting = full.length <= textLimit ? full : textOf(withShortenedAnswer);
  return {
    text: wellFormedPrefix(fitting, textLimit),
    keyboard: shown
      .filter(({ approval }) => approval.status === undefined)
      .map(({ approval, index }) => rowOf(approval, index, turnApprovals)),
    pendingApprovalIds: shown.map(({ approval }) => approval.pendingApprovalId),
  };
};
