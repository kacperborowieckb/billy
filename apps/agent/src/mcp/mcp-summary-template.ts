import { Predicate } from "effect";

export const summaryPlaceholderPattern = /\{(?<field>[^{}]*)\}/gu;

export const summaryOptionalPartPattern = /\[(?<part>[^[\]]*)\]/gu;

export const summaryFieldPattern =
  /^[A-Za-z][A-Za-z0-9_]{0,31}(?:\.[A-Za-z][A-Za-z0-9_]{0,31})*$/u;

const maxShownValueLength = 60;

const unknownValue = "...";

export const summaryPathsOf = (placeholder: string) => placeholder.split("|");

const wellFormedPrefix = (text: string, length: number) => {
  const prefix = text.slice(0, length);
  return prefix.isWellFormed() ? prefix : prefix.slice(0, -1);
};

const oneLine = (text: string) => text.replaceAll(/\s+/gu, " ").trim();

const shortened = (text: string) =>
  text.length <= maxShownValueLength
    ? text
    : `${wellFormedPrefix(text, maxShownValueLength)}...`;

export const isScalar = Predicate.or(
  Predicate.isString,
  Predicate.or(Predicate.isNumber, Predicate.isBoolean)
);

export const shownScalar = (value: string | number | boolean) =>
  typeof value === "string"
    ? JSON.stringify(shortened(oneLine(value)))
    : String(value);

interface FoundValue {
  readonly value: unknown;
  readonly others: number;
}

const firstOf = ({ value, others }: FoundValue): FoundValue =>
  Array.isArray(value)
    ? { value: value[0], others: others + Math.max(0, value.length - 1) }
    : { value, others };

const memberOf = (value: unknown, key: string) =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

const valueAt = (args: unknown, path: string) => {
  let found: FoundValue = { value: args, others: 0 };
  for (const key of path.split(".")) {
    const { value, others } = firstOf(found);
    found = { value: memberOf(value, key), others };
  }
  return firstOf(found);
};

const withOthers = (shown: string, others: number) =>
  others === 0 ? shown : `${shown} and ${others} more`;

const filledPlaceholder = (placeholder: string, args: unknown) => {
  const found = summaryPathsOf(placeholder).map((path) => valueAt(args, path));
  for (const { value, others } of found) {
    if (isScalar(value)) {
      return withOthers(shownScalar(value as string), others);
    }
  }
  return withOthers(
    unknownValue,
    Math.max(0, ...found.map(({ others }) => others))
  );
};

const isGiven = (placeholder: string, args: unknown) =>
  summaryPathsOf(placeholder).some(
    (path) => valueAt(args, path).value !== undefined
  );

const withoutAbsentParts = (template: string, args: unknown) =>
  template.replaceAll(summaryOptionalPartPattern, (_match, part: string) =>
    [...part.matchAll(summaryPlaceholderPattern)].some(([, placeholder]) =>
      isGiven(placeholder ?? "", args)
    )
      ? part
      : ""
  );

export const filledSummaryTemplate = (template: string, args: unknown) =>
  withoutAbsentParts(template, args).replaceAll(
    summaryPlaceholderPattern,
    (_match, placeholder: string) => filledPlaceholder(placeholder, args)
  );
