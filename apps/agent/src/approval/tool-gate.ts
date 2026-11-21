import type { TrustLevel } from "../notes/note.ts";
import type { RiskClass, RiskClassified } from "./risk-class.ts";

export interface GatedTool extends RiskClassified {
  readonly marksItsWorkUntrusted: boolean;
}

export interface GatedCall {
  readonly tool: GatedTool;
  readonly input: unknown;
  readonly trustLevel: TrustLevel;
}

export type GateDecision =
  | { readonly _tag: "Run" }
  | { readonly _tag: "AskOwner" }
  | { readonly _tag: "Deny"; readonly reason: string };

export const blockedCallReason =
  "This tool is blocked, so it did not run. Tell the Owner that you cannot do this.";

const run: GateDecision = { _tag: "Run" };

const askOwner: GateDecision = { _tag: "AskOwner" };

const decisionOfClass: Readonly<
  Record<RiskClass, (call: GatedCall) => GateDecision>
> = {
  read: () => run,
  change: ({ tool, trustLevel }) =>
    trustLevel === "owner" || tool.marksItsWorkUntrusted ? run : askOwner,
  approve: () => askOwner,
  blocked: () => ({ _tag: "Deny", reason: blockedCallReason }),
};

export const gateDecisionOf = (call: GatedCall): GateDecision =>
  decisionOfClass[call.tool.riskClassOf(call.input)](call);
