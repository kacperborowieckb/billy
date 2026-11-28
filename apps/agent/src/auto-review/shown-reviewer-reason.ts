import type { Redactor } from "../tracing/redactor.ts";

export const maxReviewerReasonLength = 200;

const unprintable = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu;

const wellFormedPrefix = (text: string) => {
  const prefix = text.slice(0, maxReviewerReasonLength);
  return prefix.isWellFormed() ? prefix : prefix.slice(0, -1);
};

export const shownReviewerReason = (
  redactor: Redactor["Service"],
  reason: string
): string | undefined => {
  const line = redactor.redact(reason).replaceAll(unprintable, " ").trim();
  if (line === "") {
    return undefined;
  }
  return line.length <= maxReviewerReasonLength
    ? line
    : `${wellFormedPrefix(line)}...`;
};
