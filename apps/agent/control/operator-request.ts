import { Data, Effect } from "effect";

export class OperatorUrlRefused extends Data.TaggedError("OperatorUrlRefused")<{
  readonly origin: string;
}> {
  override get message() {
    return `The Operator token was not sent to ${this.origin}. Use an https URL. An http URL is permitted only for a Worker on this machine.`;
  }
}

const loopbackHosts: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

const keepsTokenPrivate = ({ protocol, hostname }: URL) =>
  protocol === "https:" ||
  (protocol === "http:" && loopbackHosts.has(hostname));

export const operatorPost = Effect.fnUntraced(function* operatorPost({
  workerUrl,
  path,
  token,
  body,
}: {
  readonly workerUrl: string;
  readonly path: string;
  readonly token: string;
  readonly body: unknown;
}) {
  const url = new URL(path, workerUrl);
  if (!keepsTokenPrivate(url)) {
    return yield* new OperatorUrlRefused({ origin: url.origin });
  }
  return yield* Effect.promise(() =>
    fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );
});
