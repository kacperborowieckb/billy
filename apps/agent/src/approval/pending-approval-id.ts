import { Schema } from "effect";

const pendingApprovalIdBytes = 9;

export const newPendingApprovalId = () =>
  btoa(
    String.fromCodePoint(
      ...crypto.getRandomValues(new Uint8Array(pendingApprovalIdBytes))
    )
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_");

export const pendingApprovalIdLength = (pendingApprovalIdBytes / 3) * 4;

export const isPendingApprovalId = Schema.is(
  Schema.String.pipe(
    Schema.check(
      Schema.isPattern(new RegExp(`^[\\w-]{${pendingApprovalIdLength}}$`, "u"))
    )
  )
);
