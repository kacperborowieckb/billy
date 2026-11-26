import type { ApprovalAnswer } from "../event.ts";

export interface ApprovalAnswering {
  readonly eventId: string;
  readonly pendingApprovalId: string;
  readonly answer: ApprovalAnswer;
}

export type ApprovalRunOutcome =
  | { readonly result: "executed"; readonly output: unknown }
  | { readonly result: "failed"; readonly reason: string }
  | { readonly result: "unconfirmed" };

export interface ApprovalRunRecord {
  readonly eventId: string;
  readonly pendingApprovalId: string;
  readonly outcome: ApprovalRunOutcome;
}

export const asUnknownOutcome =
  <Output>(outcomeOf: (output: Output) => ApprovalRunOutcome) =>
  (output: unknown) =>
    outcomeOf(output as Output);
