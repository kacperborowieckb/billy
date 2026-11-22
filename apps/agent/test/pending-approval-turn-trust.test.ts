import { describe, expect, it } from "vitest";

import { turnTrustGiven } from "../src/approval/turn-trust.ts";

const ownerMessageTurn = {
  trustLevel: "owner",
  asksOwnerForApproval: true,
} as const;

const turnTrustWith = (holdsUntrustedContent: boolean) =>
  turnTrustGiven(
    ownerMessageTurn,
    { history: [], situation: ["No marker here."], holdsUntrustedContent },
    []
  ).current();

describe("The trust of an Owner message Turn given its open Pending Approvals", () => {
  it("starts untrusted when an open Pending Approval is flagged untrusted, with no marker in the context", () => {
    expect(turnTrustWith(true)).toBe("untrusted");
  });

  it("starts owner when no open Pending Approval is flagged untrusted", () => {
    expect(turnTrustWith(false)).toBe("owner");
  });
});
