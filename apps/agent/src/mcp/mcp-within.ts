import { Effect } from "effect";

export const within = <Value>(work: Promise<Value>, millis: number) =>
  Effect.runPromise(
    Effect.tryPromise(() => work).pipe(Effect.timeoutOption(millis))
  );
