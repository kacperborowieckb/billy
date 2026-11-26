export const summaryPlaceholderPattern = /\{(?<field>[^{}]*)\}/gu;

export const summaryFieldPattern =
  /^[A-Za-z][A-Za-z0-9_]{0,31}(?:\.[A-Za-z][A-Za-z0-9_]{0,31})*$/u;

const maxShownValueLength = 60;

const unknownValue = "...";

const wellFormedPrefix = (text: string, length: number) => {
  const prefix = text.slice(0, length);
  return prefix.isWellFormed() ? prefix : prefix.slice(0, -1);
};

const oneLine = (text: string) => text.replaceAll(/\s+/gu, " ").trim();

const shortened = (text: string) =>
  text.length <= maxShownValueLength
    ? text
    : `${wellFormedPrefix(text, maxShownValueLength)}...`;

export const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

export const shownScalar = (value: string | number | boolean) =>
  typeof value === "string"
    ? JSON.stringify(shortened(oneLine(value)))
    : String(value);

const valueAt = (value: unknown, path: string): unknown => {
  let current = value;
  for (const key of path.split(".")) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !Object.hasOwn(current, key)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

export const filledSummaryTemplate = (template: string, args: unknown) =>
  template.replaceAll(summaryPlaceholderPattern, (_match, field: string) => {
    const value = valueAt(args, field);
    return isScalar(value) ? shownScalar(value) : unknownValue;
  });
