const isRevocationForm = async (request: Request) => {
  const form = new URLSearchParams(await request.text());
  return !form.has("grant_type") && form.has("token");
};

export const createFakeRevocationEndpoint = () => {
  const requests: Record<string, string>[] = [];
  const state = {
    advertised: true,
    atTokenEndpoint: false,
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
    takes: async (request: Request) => {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST") {
        return false;
      }
      return (
        pathname.endsWith("/revoke") ||
        (state.atTokenEndpoint &&
          pathname.endsWith("/token") &&
          (await isRevocationForm(request.clone())))
      );
    },
    metadataOf: (issuer: string) =>
      state.advertised
        ? {
            revocation_endpoint: `${issuer}/${state.atTokenEndpoint ? "token" : "revoke"}`,
          }
        : {},
    exposed: {
      revokeAtTokenEndpoint: (enabled: boolean) => {
        state.atTokenEndpoint = enabled;
      },
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
      state.atTokenEndpoint = false;
      state.hold = Promise.resolve(undefined);
      state.status = undefined;
      state.bodyNeverEnds = false;
      requests.length = 0;
    },
  };
};
