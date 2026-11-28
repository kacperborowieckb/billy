import { Effect } from "effect";

export interface ApprovalPathStep {
  readonly pendingApprovalId: string;
  readonly step:
    | "press_found_no_open_approval"
    | "answer_lost_to_another_press"
    | "run_finished"
    | "run_could_not_start"
    | "run_failed_unexpectedly"
    | "lost_run_set_unconfirmed"
    | "message_has_nothing_to_edit";
  readonly toolName?: string;
  readonly result?: "executed" | "failed" | "unconfirmed";
  readonly reason?: string;
  readonly durationMillis?: number;
}

export const approvalPathLog = (step: ApprovalPathStep) =>
  Effect.logInfo("Approval path", JSON.stringify(step));
