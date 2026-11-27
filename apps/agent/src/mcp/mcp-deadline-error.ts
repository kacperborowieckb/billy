const requestTimeoutCode = -32_001;

const isDeadlineSignal = (error: object) =>
  ("code" in error && error.code === requestTimeoutCode) ||
  ("name" in error && error.name === "TimeoutError");

export const isDeadlineError = (error: unknown): boolean => {
  const seen = new Set<object>();
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    if (isDeadlineSignal(current)) {
      return true;
    }
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
};
