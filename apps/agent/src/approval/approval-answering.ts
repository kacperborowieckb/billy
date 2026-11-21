import type { ApprovalAnswer } from "../event.ts";

export interface ApprovalAnswering {
  readonly eventId: string;
  readonly pendingApprovalId: string;
  readonly answer: ApprovalAnswer;
}

export type ApprovalRunOutcome =
  | { readonly result: "executed"; readonly output: unknown }
  | { readonly result: "failed"; readonly reason: string };

export interface ApprovalRunRecord {
  readonly eventId: string;
  readonly pendingApprovalId: string;
  readonly outcome: ApprovalRunOutcome;
}
