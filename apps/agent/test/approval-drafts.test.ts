import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  maxApprovalsPerTurn,
  maxSummaryCharacters,
  summaryWithinLimit,
} from "../src/approval/approval-summary.ts";
import { holdsOperatorSecret } from "../src/approval/draft-approval.ts";
import { approvalRequestText } from "../src/channels/telegram/approval-keyboard.ts";
import { telegramTextLimit } from "../src/channels/telegram/telegram-channel.ts";
import { Redactor } from "../src/tracing/redactor.ts";

const redactorWith = (secrets: readonly string[]) =>
  Effect.runSync(Redactor.pipe(Effect.provide(Redactor.layer(secrets))));

describe("A draft Pending Approval", () => {
  it("finds an Operator secret in any string or key of the input, also one that JSON would escape", () => {
    const redactor = redactorWith(['se"cr\\et']);

    expect(holdsOperatorSecret(redactor, { text: 'a se"cr\\et b' })).toBe(true);
    expect(
      holdsOperatorSecret(redactor, { list: [{ deep: 'se"cr\\et' }] })
    ).toBe(true);
    expect(holdsOperatorSecret(redactor, { 'se"cr\\et': 1 })).toBe(true);
    expect(holdsOperatorSecret(redactor, { text: "safe", count: 3 })).toBe(
      false
    );
  });

  it("fits the most Approvals of one Turn, with the longest summaries, in one Telegram message", () => {
    const summary = summaryWithinLimit("x".repeat(maxSummaryCharacters * 2));
    expect([...summary]).toHaveLength(maxSummaryCharacters);

    const text = approvalRequestText(
      Array.from({ length: maxApprovalsPerTurn }, (_, index) => ({
        pendingApprovalId: `id-${index}`,
        summary,
      }))
    );

    expect(text.length).toBeLessThanOrEqual(telegramTextLimit);
  });
});
