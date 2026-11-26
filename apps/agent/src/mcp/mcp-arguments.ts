import { Validator } from "@cfworker/json-schema";

const maxProblemsShown = 3;

const maxLocationLength = 60;

const draft = "2020-12";

const unsupportedKeywords = [
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
] as const;

const cannotCheck =
  "The input schema of the tool cannot be used to check the arguments";

const safeLocationPattern = /[^A-Za-z0-9_.#/-]/gu;

const safeKeywordPattern = /^[A-Za-z$]{1,32}$/u;

const usesUnsupportedKeyword = (
  inputSchema: Readonly<Record<string, unknown>>
) => {
  const text = JSON.stringify(inputSchema);
  return unsupportedKeywords.some((keyword) => text.includes(`"${keyword}"`));
};

const problemOf = ({
  instanceLocation,
  keyword,
}: {
  readonly instanceLocation: string;
  readonly keyword: string;
}) => {
  const location = instanceLocation
    .replaceAll(safeLocationPattern, "?")
    .slice(0, maxLocationLength);
  return safeKeywordPattern.test(keyword)
    ? `${location} fails ${keyword}`
    : `${location} is not valid`;
};

export const mcpArgumentProblemOf = (
  inputSchema: Readonly<Record<string, unknown>>,
  args: Readonly<Record<string, unknown>>
): string | undefined => {
  if (usesUnsupportedKeyword(inputSchema)) {
    return cannotCheck;
  }
  try {
    const result = new Validator(inputSchema, draft, false).validate(args);
    return result.valid
      ? undefined
      : result.errors.slice(0, maxProblemsShown).map(problemOf).join("; ");
  } catch {
    return cannotCheck;
  }
};
