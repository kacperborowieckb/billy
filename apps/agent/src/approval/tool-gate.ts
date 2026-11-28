import type { TrustLevel } from "../notes/note.ts";
import type { RiskClass, RiskClassified } from "./risk-class.ts";

export interface GatedTool extends RiskClassified {
  readonly marksItsWorkUntrusted: (input: unknown) => boolean;
  readonly hasCodeWrittenInput: boolean;
}

export interface GatedCall {
  readonly tool: GatedTool;
  readonly input: unknown;
  readonly trustLevel: TrustLevel;
  readonly asksOwnerForApproval: boolean;
}

export type SettledGateDecision =
  | { readonly _tag: "Run" }
  | { readonly _tag: "RunCodeWrittenInput" }
  | { readonly _tag: "RunMarkedUntrusted" }
  | { readonly _tag: "AskOwner"; readonly reviewerReason?: string }
  | { readonly _tag: "Deny"; readonly reason: string };

export type GateDecision =
  | SettledGateDecision
  | { readonly _tag: "AskReviewer" };

export type ReviewVerdict =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Ask"; readonly reason?: string }
  | { readonly _tag: "Refuse"; readonly reason: string };

export const blockedCallReason =
  "This tool is blocked, so it did not run. Tell the Owner that you cannot do this.";

export const reviewStoppedReason =
  "A safety check refused several calls in this reply, so code runs no more changes. Do not call a tool again.";

export const untrustedChangeWithoutOwnerReason =
  "This run read text from outside, and it cannot ask the Owner for Approval, so this change did not run. Do not try it again. Tell the Owner in your message what you would change.";

const run: SettledGateDecision = { _tag: "Run" };

const runCodeWrittenInput: SettledGateDecision = {
  _tag: "RunCodeWrittenInput",
};

const runMarkedUntrusted: SettledGateDecision = { _tag: "RunMarkedUntrusted" };

const askReviewer: GateDecision = { _tag: "AskReviewer" };

const askOwner: SettledGateDecision = { _tag: "AskOwner" };

const untrustedChangeWithoutOwner: SettledGateDecision = {
  _tag: "Deny",
  reason: untrustedChangeWithoutOwnerReason,
};

const untrustedChangeDecision = ({
  tool,
  asksOwnerForApproval,
}: GatedCall): GateDecision =>
  !asksOwnerForApproval && tool.hasCodeWrittenInput
    ? runCodeWrittenInput
    : askReviewer;

const changeDecision = (call: GatedCall): GateDecision => {
  if (call.trustLevel === "owner") {
    return run;
  }
  return call.tool.marksItsWorkUntrusted(call.input)
    ? runMarkedUntrusted
    : untrustedChangeDecision(call);
};

const decisionOfClass: Readonly<
  Record<RiskClass, (call: GatedCall) => GateDecision>
> = {
  read: () => run,
  change: changeDecision,
  approve: () => askOwner,
  blocked: () => ({ _tag: "Deny", reason: blockedCallReason }),
};

export const gateDecisionOf = (call: GatedCall): GateDecision =>
  decisionOfClass[call.tool.riskClassOf(call.input)](call);

export const decisionAfterReview = (
  verdict: ReviewVerdict,
  asksOwnerForApproval: boolean
): SettledGateDecision => {
  if (verdict._tag === "Allow") {
    return run;
  }
  if (!asksOwnerForApproval) {
    return untrustedChangeWithoutOwner;
  }
  return verdict._tag === "Ask"
    ? {
        _tag: "AskOwner",
        ...(verdict.reason === undefined
          ? {}
          : { reviewerReason: verdict.reason }),
      }
    : { _tag: "Deny", reason: verdict.reason };
};
