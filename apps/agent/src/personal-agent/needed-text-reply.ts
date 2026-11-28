import type { DraftApproval } from "../approval/pending-approvals.ts";

export const noTextForNeededReplyReason =
  "The model sent no text for a Turn that must answer with text";

interface ReplyEnd {
  readonly textReplyNeeded: boolean;
  readonly drafts: readonly DraftApproval[];
  readonly text: string;
}

export const missesNeededText = ({ textReplyNeeded, drafts, text }: ReplyEnd) =>
  textReplyNeeded && drafts.length === 0 && text.trim().length === 0;
