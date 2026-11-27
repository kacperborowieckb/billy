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

const memberOf = (value: unknown, key: string) =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

const valuesAt = (
  value: unknown,
  keys: readonly string[]
): readonly unknown[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => valuesAt(item, keys));
  }
  const [key, ...rest] = keys;
  return key === undefined ? [value] : valuesAt(memberOf(value, key), rest);
};

const withOthers = (shown: string, count: number) =>
  count > 1 ? `${shown} and ${count - 1} more` : shown;

const filledPlaceholder = (placeholder: string, args: unknown) => {
  const found = summaryPathsOf(placeholder).map((path) =>
    valuesAt(args, path.split("."))
  );
  for (const values of found) {
    const scalars = values.filter(isScalar);
    const shown = scalars.find((value) => value === true) ?? scalars[0];
    if (shown !== undefined) {
      return withOthers(shownScalar(shown), values.length);
    }
  }
  return withOthers(
    unknownValue,
    Math.max(0, ...found.map((values) => values.length))
  );
};

const isGiven = (placeholder: string, args: unknown) =>
  summaryPathsOf(placeholder).some((path) =>
    valuesAt(args, path.split(".")).some((value) => value !== undefined)
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
