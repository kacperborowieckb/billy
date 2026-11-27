const requestTimeoutCode = -32_001;

const isDeadlineSignal = (error: object) =>
  ("code" in error && error.code === requestTimeoutCode) ||
  ("name" in error && error.name === "TimeoutError");

export const isDeadlineError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (
    isDeadlineSignal(error) ||
    ("cause" in error && isDeadlineError(error.cause))
  );
};
