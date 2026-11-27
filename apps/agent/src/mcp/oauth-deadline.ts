import { Effect } from "effect";

export const oauthRequestDeadlineMillis = 3000;

export const withinDeadline = <Value>(
  run: (signal: AbortSignal) => Promise<Value>,
  deadlineMillis = oauthRequestDeadlineMillis
) =>
  Effect.runPromise(
    Effect.tryPromise((signal) => run(signal)).pipe(
      Effect.timeout(deadlineMillis)
    )
  );
