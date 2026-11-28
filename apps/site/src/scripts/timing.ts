// Small timing helpers for the played conversations. Under reduced motion
// every wait is zero, so a script lands on its finished picture at once.

const isReduced = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const wait = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  window.setTimeout(() => resolve(undefined), isReduced() ? 0 : ms);
  return promise;
};

/** Two frames: long enough for a class change to start a transition. */
export const frame = () => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
  return promise;
};

/** Runs `run` for each item, one after another. */
export const inSequence = <T>(
  items: Iterable<T>,
  run: (item: T, index: number) => Promise<unknown> | unknown
) => {
  const list = [...items];
  const step = async (index: number): Promise<void> => {
    if (index >= list.length) {
      return;
    }
    await run(list[index] as T, index);
    return step(index + 1);
  };
  return step(0);
};

/** Waits, then runs `body`. */
export const after = async (ms: number, body: () => Promise<unknown>) => {
  await wait(ms);
  await body();
};

/** Runs `body` again and again while `live` says so. */
export const repeat = async (
  live: () => boolean,
  body: (turn: number) => Promise<unknown>,
  turn = 0
): Promise<void> => {
  if (!live()) {
    return;
  }
  await body(turn);
  return repeat(live, body, turn + 1);
};
