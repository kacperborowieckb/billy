export const riskClasses = ["read", "change", "approve", "blocked"] as const;

export type RiskClass = (typeof riskClasses)[number];

const rankOf = (riskClass: RiskClass) => riskClasses.indexOf(riskClass);

export const higherRiskClass = (
  declared: RiskClass,
  ofInput: RiskClass
): RiskClass => (rankOf(ofInput) > rankOf(declared) ? ofInput : declared);

export interface RiskClassified {
  readonly riskClass: RiskClass;
  readonly riskClassOf: (input: unknown) => RiskClass;
}

export const riskClassified = <Input>(
  riskClass: RiskClass,
  riskClassOfInput?: (input: Input) => RiskClass
): RiskClassified => ({
  riskClass,
  riskClassOf: (input) =>
    riskClassOfInput === undefined
      ? riskClass
      : higherRiskClass(riskClass, riskClassOfInput(input as Input)),
});
