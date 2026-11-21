import { Effect, Option } from "effect";

import type { ToolFailed } from "../model-gateway/agent-tool.ts";

export interface InputApprovalSummary<Input> {
  readonly isInput: (value: unknown) => value is Input;
  readonly of: (input: Input) => Effect.Effect<string, ToolFailed>;
}

export type ApprovalSummaryOf = (
  input: unknown
) => Effect.Effect<Option.Option<string>, ToolFailed>;

export const approvalSummaryOf =
  <Input>(
    summary: InputApprovalSummary<Input> | undefined
  ): ApprovalSummaryOf =>
  (input) =>
    summary !== undefined && summary.isInput(input)
      ? summary.of(input).pipe(Effect.map(Option.some))
      : Effect.succeed(Option.none());

export const maxSummaryLength = 3500;

export const quoted = (text: string) => `"${text}"`;

export const fitsOneApprovalRow = (summary: string) =>
  summary.length <= maxSummaryLength;

export const countOf = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
