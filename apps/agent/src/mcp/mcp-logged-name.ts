const loggableName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

const maxLoggedNames = 120;

export const loggedToolNameOf = (name: string) =>
  loggableName.test(name) ? name : "unloggable_name";

export const loggedToolNamesOf = (names: readonly string[]) =>
  names.slice(0, maxLoggedNames).map(loggedToolNameOf);
