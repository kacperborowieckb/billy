import { Validator } from "@cfworker/json-schema";

const maxProblemsShown = 3;

const maxProblemLength = 160;

const draft = "2020-12";

const shortened = (text: string) =>
  text.length <= maxProblemLength
    ? text
    : `${text.slice(0, maxProblemLength)}...`;

export const mcpArgumentProblemOf = (
  inputSchema: Readonly<Record<string, unknown>>,
  args: Readonly<Record<string, unknown>>
): string | undefined => {
  try {
    const result = new Validator(inputSchema, draft, false).validate(args);
    if (result.valid) {
      return undefined;
    }
    return result.errors
      .slice(0, maxProblemsShown)
      .map(({ instanceLocation, error }) =>
        shortened(`${instanceLocation}: ${error}`)
      )
      .join("; ");
  } catch {
    return "The input schema of the tool cannot be used to check the arguments";
  }
};
