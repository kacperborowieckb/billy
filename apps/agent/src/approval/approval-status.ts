import { DateTime, Option } from "effect";

import type { PendingApproval } from "./pending-approvals.ts";

export const expiredNotice = "This expired";

export const alreadyAnsweredNotice = "This was already answered";

export const doneStatus = "Approved, done";

export const rejectedStatus = "Rejected";

export const expiredStatus = "Expired";

export const failedStatus = (reason: string) =>
  `Approved, but it failed: ${reason}`;

export const unconfirmedStatus =
  "Approved, but it is not confirmed that it ran";

export const approvedStatus = "Approved";

const statusOfState: Readonly<
  Record<Exclude<PendingApproval["state"], "failed">, string | undefined>
> = {
  draft: undefined,
  pending: undefined,
  approved: approvedStatus,
  rejected: rejectedStatus,
  expired: expiredStatus,
  executed: doneStatus,
  unconfirmed: unconfirmedStatus,
};

export const statusOfApproval = (approval: PendingApproval) =>
  approval.state === "failed"
    ? failedStatus(approval.result ?? "no reason")
    : statusOfState[approval.state];

const lowerFirst = (text: string) =>
  `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

export const conversationEntryOf = (summary: string, status: string) =>
  `Approval for ${summary}: ${lowerFirst(status)}`;

const hasExpired = (approval: PendingApproval, now: DateTime.Utc) =>
  approval.state === "expired" ||
  (approval.state === "pending" &&
    DateTime.isLessThanOrEqualTo(DateTime.makeUnsafe(approval.expiresAt), now));

export const shownStatusOf = (approval: PendingApproval, now: DateTime.Utc) =>
  hasExpired(approval, now) ? expiredStatus : statusOfApproval(approval);

export const lateNoticeOf = (
  approval: Option.Option<PendingApproval>,
  now: DateTime.Utc
): string | undefined => {
  if (Option.isNone(approval)) {
    return alreadyAnsweredNotice;
  }
  if (hasExpired(approval.value, now)) {
    return expiredNotice;
  }
  return approval.value.state === "pending" ? undefined : alreadyAnsweredNotice;
};
