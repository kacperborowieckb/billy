import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  failedStatus,
  maxFailureReasonLength,
  maxStatusLength,
} from "../src/approval/approval-status.ts";
import {
  fitsOneApprovalRow,
  maxSummaryLength,
} from "../src/approval/approval-summary.ts";
import { holdsOperatorSecret } from "../src/approval/draft-approval.ts";
import {
  allAnsweredNotice,
  approvalBlocksOf,
  editedApprovalBlockOf,
} from "../src/channels/telegram/approval-keyboard.ts";
import { telegramTextLimit } from "../src/channels/telegram/telegram-send.ts";
import { Redactor } from "../src/tracing/redactor.ts";

const redactorWith = (secrets: readonly string[]) =>
  Effect.runSync(Redactor.pipe(Effect.provide(Redactor.layer(secrets))));

const summaryOf = (index: number) => `${index}: ${"y".repeat(80)}`;

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

  it("splits the Approval rows into messages within the Telegram limit and keeps one numbering", () => {
    const summary = "x".repeat(maxSummaryLength);
    expect(fitsOneApprovalRow(summary)).toBe(true);
    expect(fitsOneApprovalRow(`${summary}x`)).toBe(false);
    const approvals = Array.from({ length: 3 }, (_, index) => ({
      pendingApprovalId: `id-${index}`,
      summary,
    }));

    const blocks = approvalBlocksOf(approvals, telegramTextLimit);

    expect(blocks.map((block) => block.pendingApprovalIds)).toEqual([
      ["id-0"],
      ["id-1"],
      ["id-2"],
    ]);
    for (const block of blocks) {
      expect(block.text.length).toBeLessThanOrEqual(telegramTextLimit);
    }
    expect(
      blocks[0]?.text.startsWith("These wait for your Approval:\n1. ")
    ).toBe(true);
    expect(blocks[2]?.text.startsWith("3. ")).toBe(true);
    expect(blocks[2]?.keyboard).toEqual([
      [
        { text: "Approve 3", callback_data: "approve:id-2" },
        { text: "Reject 3", callback_data: "reject:id-2" },
        { text: "Details 3", callback_data: "details:id-2" },
      ],
    ]);
  });

  it("keeps short Approval rows in one message", () => {
    const blocks = approvalBlocksOf(
      [
        {
          pendingApprovalId: "a",
          summary: "Set the time zone to Europe/Warsaw",
        },
        { pendingApprovalId: "b", summary: "Show the Quiet Hours" },
      ],
      telegramTextLimit
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.pendingApprovalIds).toEqual(["a", "b"]);
  });

  it("bounds a long failure reason without splitting a surrogate pair", () => {
    const reason = `${"a".repeat(maxFailureReasonLength - 4)}😀${"b".repeat(500)}`;

    const status = failedStatus(reason);

    expect(status.length).toBeLessThanOrEqual(maxStatusLength);
    expect(status.endsWith("...")).toBe(true);
    expect(status.isWellFormed()).toBe(true);
    expect(failedStatus("short")).toBe("Approved, but it failed: short");
  });

  it("keeps the edited message within the limit when every row has the longest failure status", () => {
    const approvals = Array.from({ length: 300 }, (_, index) => ({
      pendingApprovalId: `id-${index}`,
      summary: "y".repeat(40),
    }));
    const blocks = approvalBlocksOf(approvals, telegramTextLimit);
    expect(blocks.length).toBeGreaterThan(1);

    for (const block of blocks) {
      const channelMessageId = block.pendingApprovalIds.join(",");
      const shown = approvals.map((approval) => ({
        ...approval,
        channelMessageId: block.pendingApprovalIds.includes(
          approval.pendingApprovalId
        )
          ? channelMessageId
          : "other",
        status: failedStatus("z".repeat(1000)),
      }));

      const edited = editedApprovalBlockOf(
        shown,
        channelMessageId,
        telegramTextLimit
      );

      expect(edited.pendingApprovalIds).toEqual(block.pendingApprovalIds);
      expect(edited.text.length).toBeLessThanOrEqual(telegramTextLimit);
    }
  });

  it("keeps one row of the longest summary within the limit with its status", () => {
    const summary = "x".repeat(maxSummaryLength);
    const edited = editedApprovalBlockOf(
      [
        {
          pendingApprovalId: "a",
          summary,
          channelMessageId: "1",
          status: failedStatus("z".repeat(1000)),
        },
      ],
      "1",
      telegramTextLimit
    );

    expect(edited.text.length).toBeLessThanOrEqual(telegramTextLimit);
  });

  it("shortens answered summaries of a message that was sent before the status room existed", () => {
    const summary = "x".repeat(2000);
    const failure = failedStatus("z".repeat(1000));
    const edited = editedApprovalBlockOf(
      [
        {
          pendingApprovalId: "a",
          summary,
          channelMessageId: "1",
          status: failure,
        },
        {
          pendingApprovalId: "b",
          summary,
          channelMessageId: "1",
          status: failure,
        },
      ],
      "1",
      telegramTextLimit
    );

    expect(edited.text.length).toBeLessThanOrEqual(telegramTextLimit);
    expect(edited.text).toContain(failure);
    expect(edited.text.isWellFormed()).toBe(true);
  });

  it("keeps every status and every active row of an old message with many rows", () => {
    const failure = failedStatus("z".repeat(1000));
    const rows = Array.from({ length: 20 }, (_, index) => ({
      pendingApprovalId: `id-${index}`,
      summary: "y".repeat(40),
      channelMessageId: "1",
      ...(index < 19 ? { status: failure } : {}),
    }));

    const edited = editedApprovalBlockOf(rows, "1", telegramTextLimit);

    const lines = edited.text.split("\n");
    expect(edited.text.length).toBeLessThanOrEqual(telegramTextLimit);
    expect(
      lines.filter((line) => line.startsWith("Approved, but"))
    ).toHaveLength(19);
    expect(lines.some((line) => line.startsWith("20. "))).toBe(true);
    expect(edited.keyboard).toHaveLength(1);
  });

  it("keeps the full summary of every pending row of a legacy message with 40 rows and failed statuses", () => {
    const failure = failedStatus("z".repeat(1000));
    const rows = Array.from({ length: 40 }, (_, index) => ({
      pendingApprovalId: `id-${index}`,
      summary: summaryOf(index),
      channelMessageId: "1",
      ...(index < 30 ? { status: failure } : {}),
    }));

    const edited = editedApprovalBlockOf(rows, "1", telegramTextLimit);

    expect(edited.text.length).toBeLessThanOrEqual(telegramTextLimit);
    expect(edited.keyboard).toHaveLength(10);
    for (let index = 30; index < 40; index += 1) {
      expect(edited.text).toContain(`${index + 1}. ${summaryOf(index)}`);
    }
  });

  it("keeps the full summary of a pending row when the answered rows cannot be shown", () => {
    const failure = failedStatus("z".repeat(1000));
    const pendingSummary = "p".repeat(3500);
    const edited = editedApprovalBlockOf(
      [
        ...Array.from({ length: 5 }, (_, index) => ({
          pendingApprovalId: `id-${index}`,
          summary: "a".repeat(100),
          channelMessageId: "1",
          status: failure,
        })),
        {
          pendingApprovalId: "id-pending",
          summary: pendingSummary,
          channelMessageId: "1",
        },
      ],
      "1",
      telegramTextLimit
    );

    expect(edited.text).toContain(pendingSummary);
    expect(edited.text.length).toBeLessThanOrEqual(telegramTextLimit);
    expect(edited.keyboard).toHaveLength(1);
  });

  it("sends a non-empty text for a non-first legacy message where every row is answered and none fits", () => {
    const failure = failedStatus("z".repeat(1000));
    const rows = [
      {
        pendingApprovalId: "first",
        summary: "f".repeat(50),
        channelMessageId: "1",
      },
      ...Array.from({ length: 60 }, (_, index) => ({
        pendingApprovalId: `id-${index}`,
        summary: "a".repeat(60),
        channelMessageId: "2",
        status: failure,
      })),
    ];

    const edited = editedApprovalBlockOf(rows, "2", telegramTextLimit);

    expect(edited.text).toBe(allAnsweredNotice);
    expect(edited.keyboard).toEqual([]);
  });
});
