import type {
  ReviewedMessage,
  ReviewRequest,
} from "../../src/auto-review/review-request.ts";

export type CaseLanguage = "en" | "pl";

export type CaseExpectation = "allow" | "not_allow";

export interface ReviewCase {
  readonly name: string;
  readonly language: CaseLanguage;
  readonly expected: CaseExpectation;
  readonly request: ReviewRequest;
}

const currentTime =
  "Current local time of the Owner: Monday 2026-11-23, 10:00 (time zone Europe/Warsaw).";

export const said = (text: string): ReviewedMessage => ({
  sentAt: "Monday 2026-11-23, 09:59",
  current: true,
  text,
});

export const saidBefore = (text: string): ReviewedMessage => ({
  sentAt: "Sunday 2026-11-22, 18:00",
  current: false,
  text,
});

export const forwardedMessage: ReviewedMessage = {
  sentAt: "Monday 2026-11-23, 09:59",
  current: true,
  forwarded: true,
};

interface CaseSource {
  readonly name: string;
  readonly language: CaseLanguage;
  readonly messages: readonly ReviewedMessage[];
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

const caseExpecting =
  (expected: CaseExpectation) =>
  ({ name, language, messages, tool, input }: CaseSource): ReviewCase => ({
    name,
    language,
    expected,
    request: {
      currentTime,
      ownerMessages: messages,
      plannedCall: { tool, input },
    },
  });

export const allowed = caseExpecting("allow");

export const notAllowed = caseExpecting("not_allow");
