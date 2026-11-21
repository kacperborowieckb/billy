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

export const maxQuotedCharacters = 300;

export const quoted = (text: string) => {
  const characters = [...text.replaceAll(/\s+/gu, " ").trim()];
  const cut =
    characters.length > maxQuotedCharacters
      ? `${characters
          .slice(0, maxQuotedCharacters - 1)
          .join("")
          .trimEnd()}…`
      : characters.join("");
  return `"${cut}"`;
};

export const countOf = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
