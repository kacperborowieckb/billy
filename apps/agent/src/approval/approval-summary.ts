import { Effect, Option } from "effect";

export interface InputApprovalSummary<Input> {
  readonly isInput: (value: unknown) => value is Input;
  readonly of: (input: Input) => Effect.Effect<string>;
}

export type ApprovalSummaryOf = (
  input: unknown
) => Effect.Effect<Option.Option<string>>;

export const approvalSummaryOf =
  <Input>(
    summary: InputApprovalSummary<Input> | undefined
  ): ApprovalSummaryOf =>
  (input) =>
    summary !== undefined && summary.isInput(input)
      ? summary.of(input).pipe(Effect.map(Option.some))
      : Effect.succeed(Option.none());

export const maxSummaryLength = 3500;

export const quoted = (text: string) =>
  `"${text.replaceAll(/\s+/gu, " ").trim()}"`;

export const fitsOneApprovalRow = (summary: string) =>
  summary.length <= maxSummaryLength;

export const countOf = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
