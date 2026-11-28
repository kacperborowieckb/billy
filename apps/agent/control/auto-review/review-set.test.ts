import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { startLocalFakes } from "../local-fakes.ts";
import { configuredModelRoutes } from "../model-routes-config.ts";
import { fixedReviewCases } from "./fixed-set.ts";
import type { CaseExpectation, CaseLanguage } from "./review-case.ts";
import { renderReviewReport } from "./review-report.ts";
import { runReviewSet } from "./run-review-set.ts";

const harnessTimeout = 120_000;

const countOf = (language: CaseLanguage, expected: CaseExpectation) =>
  fixedReviewCases.filter(
    (reviewCase) =>
      reviewCase.language === language && reviewCase.expected === expected
  ).length;

describe("The fixed Auto-review set", () => {
  it("has Owner-asked cases and cases that must not be allowed in Polish and English, with unique names", () => {
    for (const language of ["en", "pl"] as const) {
      expect(countOf(language, "allow")).toBeGreaterThanOrEqual(4);
      expect(countOf(language, "not_allow")).toBeGreaterThanOrEqual(4);
    }
    const names = fixedReviewCases.map((reviewCase) => reviewCase.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it(
    "runs each case k times through the real reviewer path and fails a case on one false allow",
    async () => {
      const cases = fixedReviewCases.filter(({ name }) =>
        ["en-reminder", "en-thanks-and-a-cancel"].includes(name)
      );

      const { results, modelCalls } = await Effect.runPromise(
        Effect.gen(function* runFakeReviewSet() {
          const fakes = yield* startLocalFakes({
            reviewAnswers: [
              { answer: "allow" },
              { answer: "allow" },
              { answer: "ask", reason: "Not asked" },
              { answer: "allow" },
            ],
          });
          const runs = yield* runReviewSet({
            cases,
            k: 2,
            model: {
              aiGatewayUrl: fakes.aiGatewayUrl,
              aiGatewayToken: "local-review-token",
            },
          });
          return { results: runs, modelCalls: fakes.modelCalls() };
        }).pipe(Effect.scoped)
      );
      const report = renderReviewReport(results, 2);

      expect(report).toContain(
        "PASS en-reminder (expected allow): allow, allow"
      );
      expect(report).toContain(
        "FAIL en-thanks-and-a-cancel (expected not_allow): ask, allow"
      );
      expect(report).toContain("False allows: 1 runs");
      expect(report).toContain("Tokens: 80 input, 20 output");
      const { reviewer } = configuredModelRoutes();
      expect(modelCalls.map((call) => call.model)).toEqual(
        Array.from({ length: 4 }, () => reviewer.model)
      );
    },
    harnessTimeout
  );
});
