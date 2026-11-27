export const createFakeRevocationEndpoint = () => {
  const requests: Record<string, string>[] = [];
  const state = {
    advertised: true,
    hold: Promise.resolve(undefined) as Promise<undefined>,
    status: undefined as number | undefined,
    bodyNeverEnds: false,
  };

  const answer = async (request: Request) => {
    const form = new URLSearchParams(await request.text());
    requests.push(Object.fromEntries(form));
    await state.hold;
    if (state.bodyNeverEnds) {
      return new Response(new ReadableStream(), { status: 200 });
    }
    return new Response(null, { status: state.status ?? 200 });
  };

  return {
    answer,
    isRevocation: (request: Request) =>
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/revoke"),
    isAdvertised: () => state.advertised,
    exposed: {
      revocationRequests: requests,
      advertiseRevocation: (advertised: boolean) => {
        state.advertised = advertised;
      },
      holdRevocations: () => {
        const { promise, resolve } = Promise.withResolvers<undefined>();
        state.hold = promise;
        return () => resolve(undefined);
      },
      failRevocationsWith: (status: number | undefined) => {
        state.status = status;
      },
      cutRevocationBodies: (cut: boolean) => {
        state.bodyNeverEnds = cut;
      },
    },
    reset: () => {
      state.advertised = true;
      state.hold = Promise.resolve(undefined);
      state.status = undefined;
      state.bodyNeverEnds = false;
      requests.length = 0;
    },
  };
};
