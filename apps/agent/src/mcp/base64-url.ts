export const base64UrlOf = (bytes: Uint8Array) =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const bytesOfBase64 = (text: string) => {
  const standard = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  return Uint8Array.from(
    atob(padded),
    (character) => character.codePointAt(0) ?? 0
  );
};
