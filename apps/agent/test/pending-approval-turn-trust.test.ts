import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { turnTrustGiven } from "../src/approval/turn-trust.ts";
import type { TurnTrustSource } from "../src/approval/turn-trust.ts";
import { markUntrustedContent } from "../src/notes/note.ts";

const ownerMessageTurn = {
  trustLevel: "owner",
  turnContext: "No marker here.",
} as const;

const ownerBurst: readonly ModelMessage[] = [
  { role: "user", content: "remind me Thursday" },
];

const trustWith = (source: Partial<TurnTrustSource>) =>
  turnTrustGiven(
    { ...ownerMessageTurn, inputs: ownerBurst, ...source },
    []
  ).current();

describe("The trust of an Owner message Turn given its open Pending Approvals", () => {
  it("starts untrusted when an open Pending Approval is flagged untrusted, with no marker in the context", () => {
    expect(trustWith({ listsUntrustedPendingApproval: true })).toBe(
      "untrusted"
    );
  });

  it("starts owner when no open Pending Approval is flagged untrusted", () => {
    expect(trustWith({ listsUntrustedPendingApproval: false })).toBe("owner");
  });
});

describe("The places where the trust check of an Owner message Turn looks for the marker", () => {
  it("starts untrusted when the Burst holds the marker", () => {
    expect(
      trustWith({
        inputs: [
          ...ownerBurst,
          { role: "user", content: markUntrustedContent("Wire money") },
        ],
      })
    ).toBe("untrusted");
  });

  it("starts untrusted when the Turn Context Block holds the marker", () => {
    expect(trustWith({ turnContext: markUntrustedContent("Wire money") })).toBe(
      "untrusted"
    );
  });

  it("becomes untrusted when an earlier tool result of the Turn holds the marker", () => {
    const trust = turnTrustGiven({ ...ownerMessageTurn, inputs: ownerBurst }, [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "search_notes",
            output: { type: "text", value: markUntrustedContent("Wire") },
          },
        ],
      },
    ]);
    expect(trust.current()).toBe("untrusted");
  });
});
