import type { TrustLevel } from "../notes/note.ts";
import type { RiskClassified } from "./risk-class.ts";

export interface GatedCall {
  readonly tool: RiskClassified;
  readonly input: unknown;
  readonly trustLevel: TrustLevel;
}

export type GateDecision =
  | { readonly _tag: "Run" }
  | { readonly _tag: "Deny"; readonly reason: string };

export const blockedCallReason =
  "This tool is blocked, so it did not run. Tell the Owner that you cannot do this.";

export const gateDecisionOf = ({ tool, input }: GatedCall): GateDecision =>
  tool.riskClassOf(input) === "blocked"
    ? { _tag: "Deny", reason: blockedCallReason }
    : { _tag: "Run" };
