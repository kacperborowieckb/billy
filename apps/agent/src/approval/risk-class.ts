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
  readonly readsForEveryInput: boolean;
}

export interface InputRiskClass<Input> {
  readonly isInput: (value: unknown) => value is Input;
  readonly of: (input: Input) => RiskClass;
}

export const riskClassified = <Input>(
  riskClass: RiskClass,
  inputRiskClass?: InputRiskClass<Input>
): RiskClassified => ({
  riskClass,
  riskClassOf: (input) =>
    inputRiskClass !== undefined && inputRiskClass.isInput(input)
      ? higherRiskClass(riskClass, inputRiskClass.of(input))
      : riskClass,
  readsForEveryInput: riskClass === "read" && inputRiskClass === undefined,
});
