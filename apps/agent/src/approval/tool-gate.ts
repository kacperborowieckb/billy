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

export type GateDecision =
  | { readonly _tag: "Run" }
  | { readonly _tag: "RunCodeWrittenInput" }
  | { readonly _tag: "RunMarkedUntrusted" }
  | { readonly _tag: "AskOwner" }
  | { readonly _tag: "Deny"; readonly reason: string };

export const blockedCallReason =
  "This tool is blocked, so it did not run. Tell the Owner that you cannot do this.";

export const untrustedChangeWithoutOwnerReason =
  "This run read text from outside, and it cannot ask the Owner for Approval, so this change did not run. Do not try it again. Tell the Owner in your message what you would change.";

const run: GateDecision = { _tag: "Run" };

const runCodeWrittenInput: GateDecision = { _tag: "RunCodeWrittenInput" };

const runMarkedUntrusted: GateDecision = { _tag: "RunMarkedUntrusted" };

const askOwner: GateDecision = { _tag: "AskOwner" };

const untrustedChangeWithoutOwner: GateDecision = {
  _tag: "Deny",
  reason: untrustedChangeWithoutOwnerReason,
};

const untrustedChangeDecision = ({
  tool,
  asksOwnerForApproval,
}: GatedCall): GateDecision => {
  if (asksOwnerForApproval) {
    return askOwner;
  }
  return tool.hasCodeWrittenInput
    ? runCodeWrittenInput
    : untrustedChangeWithoutOwner;
};

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
