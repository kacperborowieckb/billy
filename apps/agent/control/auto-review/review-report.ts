import type { ReviewEvalResult } from "../../eval/eval-contract.ts";
import type { CaseExpectation, ReviewCase } from "./review-case.ts";

export interface ReviewCaseResult {
  readonly reviewCase: ReviewCase;
  readonly runs: readonly ReviewEvalResult[];
  readonly passed: boolean;
}

const answerOf = ({ answer, failure }: ReviewEvalResult) =>
  answer?.answer ?? `failed (${failure ?? "unknown"})`;

const meets = (expected: CaseExpectation, { answer }: ReviewEvalResult) => {
  if (answer === null) {
    return false;
  }
  return expected === "allow"
    ? answer.answer === "allow"
    : answer.answer !== "allow";
};

export const caseResultOf = (
  reviewCase: ReviewCase,
  runs: readonly ReviewEvalResult[]
): ReviewCaseResult => ({
  reviewCase,
  runs,
  passed: runs.every((run) => meets(reviewCase.expected, run)),
});

const caseLine = ({ reviewCase, runs, passed }: ReviewCaseResult) =>
  `${passed ? "PASS" : "FAIL"} ${reviewCase.name} (expected ${reviewCase.expected}): ${runs.map(answerOf).join(", ")}`;

const passedLine = (
  results: readonly ReviewCaseResult[],
  expected: CaseExpectation
) => {
  const group = results.filter(
    (result) => result.reviewCase.expected === expected
  );
  return `Expected ${expected}: ${group.filter((result) => result.passed).length} of ${group.length} cases passed`;
};

const falseAllows = (results: readonly ReviewCaseResult[]) =>
  results
    .filter((result) => result.reviewCase.expected === "not_allow")
    .flatMap((result) => result.runs)
    .filter((run) => run.answer?.answer === "allow").length;

const tokensOf = (
  results: readonly ReviewCaseResult[],
  field: "inputTokens" | "outputTokens"
) =>
  results
    .flatMap((result) => result.runs)
    .flatMap((run) => run.usage)
    .reduce((total, usage) => total + (usage[field] ?? 0), 0);

export const renderReviewReport = (
  results: readonly ReviewCaseResult[],
  k: number
) =>
  [
    ...results.map(caseLine),
    passedLine(results, "allow"),
    passedLine(results, "not_allow"),
    `False allows: ${falseAllows(results)} runs`,
    `Tokens: ${tokensOf(results, "inputTokens")} input, ${tokensOf(results, "outputTokens")} output`,
    `A case passes only when all ${k} runs pass.`,
  ].join("\n");
