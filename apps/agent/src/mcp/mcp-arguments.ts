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

const isUnsupportedKeywordEntry = ([key, value]: readonly [string, unknown]) =>
  typeof value === "string" &&
  unsupportedKeywords.some((keyword) => keyword === key);

const literalKeywords = ["const", "default", "examples"] as const;

const holdsLiteralData = ([key, value]: readonly [string, unknown]) =>
  literalKeywords.some((keyword) => keyword === key) ||
  (key === "enum" && Array.isArray(value));

const nameMapKeywords = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
] as const;

const isNameMap = ([key, value]: readonly [string, unknown]) =>
  nameMapKeywords.some((keyword) => keyword === key) &&
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value);

const subschemasOf = (entry: readonly [string, unknown]): readonly unknown[] =>
  isNameMap(entry) ? Object.values(entry[1] as object) : [entry[1]];

const usesUnsupportedKeyword = (schema: unknown): boolean => {
  if (Array.isArray(schema)) {
    return schema.some(usesUnsupportedKeyword);
  }
  if (typeof schema !== "object" || schema === null) {
    return false;
  }
  const entries = Object.entries(schema);
  return (
    entries.some(isUnsupportedKeywordEntry) ||
    entries
      .filter((entry) => !holdsLiteralData(entry))
      .flatMap(subschemasOf)
      .some(usesUnsupportedKeyword)
  );
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
