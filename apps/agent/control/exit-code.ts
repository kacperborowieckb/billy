import { Effect } from "effect";

export const exitWithFailureWhen = (failed: boolean) =>
  Effect.sync(() => {
    if (failed) {
      process.exitCode = 1;
    }
  });
