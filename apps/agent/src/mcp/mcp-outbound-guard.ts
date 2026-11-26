import { Data } from "effect";

export class OutboundRefused extends Data.TaggedError("OutboundRefused")<{
  readonly message: string;
}> {}

const ipv4Octets = (hostname: string) => {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return;
  }
  const octets = parts.map((part) =>
    /^\d{1,3}$/u.test(part) ? Number(part) : -1
  );
  return octets.every((octet) => octet >= 0 && octet <= 255)
    ? octets
    : undefined;
};

const isPrivateIpv4 = ([first = 0, second = 0]: readonly number[]) => {
  const blocks = [
    first === 0 || first === 10 || first === 127 || first >= 224,
    first === 100 && second >= 64 && second <= 127,
    first === 169 && second === 254,
    first === 172 && second >= 16 && second <= 31,
    first === 192 && (second === 168 || second === 0),
    first === 198 && (second === 18 || second === 19),
  ];
  return blocks.some(Boolean);
};

const mappedIpv4 = /^::ffff:(?<octets>\d+\.\d+\.\d+\.\d+)$/u;

const isPrivateIpv6 = (literal: string) => {
  const address = literal.slice(1, -1).toLowerCase();
  const mapped = mappedIpv4.exec(address)?.groups?.["octets"];
  if (mapped !== undefined) {
    const octets = ipv4Octets(mapped);
    return octets === undefined || isPrivateIpv4(octets);
  }
  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("::ffff:") ||
    /^f[cd]/u.test(address) ||
    /^fe[89ab]/u.test(address) ||
    address.startsWith("ff")
  );
};

const internalSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".lan",
  ".home.arpa",
];

const isInternalName = (hostname: string) =>
  hostname === "localhost" ||
  !hostname.includes(".") ||
  internalSuffixes.some((suffix) => hostname.endsWith(suffix));

const privateHostReason = (hostname: string) => {
  if (hostname.startsWith("[")) {
    return isPrivateIpv6(hostname) ? "The address is private" : undefined;
  }
  const octets = ipv4Octets(hostname);
  if (octets !== undefined) {
    return isPrivateIpv4(octets) ? "The address is private" : undefined;
  }
  return isInternalName(hostname) ? "The address is internal" : undefined;
};

export const refusedReasonOf = (
  url: URL,
  allowedOrigins: readonly string[]
): string | undefined => {
  if (allowedOrigins.includes(url.origin)) {
    return undefined;
  }
  return url.protocol === "https:"
    ? privateHostReason(url.hostname.toLowerCase())
    : "The address is not HTTPS";
};

export type FetchFunction = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export const guardedFetch =
  (send: FetchFunction, allowedOrigins: readonly string[]): FetchFunction =>
  async (input, init) => {
    const request = new Request(input, init);
    const reason = refusedReasonOf(new URL(request.url), allowedOrigins);
    if (reason !== undefined) {
      throw new OutboundRefused({
        message: `The MCP Hub refused a request: ${reason}`,
      });
    }
    const response = await send(request, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new OutboundRefused({ message: "The MCP Hub refused a redirect" });
    }
    return response;
  };
