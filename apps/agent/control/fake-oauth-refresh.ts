export const createFakeRefreshGrant = (initialRefreshToken: string) => {
  const state = {
    rotates: false,
    refreshes: 0,
    validTokens: new Set<string>([initialRefreshToken]),
    hold: Promise.resolve(undefined) as Promise<undefined>,
    bodyNeverEnds: false,
    status: undefined as number | undefined,
  };

  const bodyOf = (text: string) =>
    state.bodyNeverEnds
      ? new ReadableStream({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode(text.slice(0, 10)));
          },
        })
      : text;

  const answer = async (
    form: URLSearchParams,
    issueAccessToken: () => string
  ) => {
    await state.hold;
    if (state.status !== undefined) {
      return new Response(null, { status: state.status });
    }
    const presented = form.get("refresh_token") ?? "";
    if (!state.validTokens.has(presented)) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    state.refreshes += 1;
    const rotated = `${initialRefreshToken}-rotated-${state.refreshes}`;
    if (state.rotates) {
      state.validTokens.delete(presented);
      state.validTokens.add(rotated);
    }
    const text = JSON.stringify({
      access_token: issueAccessToken(),
      token_type: "Bearer",
      expires_in: 3600,
      ...(state.rotates ? { refresh_token: rotated } : {}),
    });
    return new Response(bodyOf(text), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return {
    answer,
    controls: {
      rotateRefreshTokens: (rotate: boolean) => {
        state.rotates = rotate;
      },
      revokeRefreshTokens: () => {
        state.validTokens.clear();
      },
      holdRefreshResponses: () => {
        const { promise, resolve } = Promise.withResolvers<undefined>();
        state.hold = promise;
        return () => resolve(undefined);
      },
      cutRefreshResponseBodies: (cut: boolean) => {
        state.bodyNeverEnds = cut;
      },
      failRefreshesWith: (status: number | undefined) => {
        state.status = status;
      },
    },
    reset: () => {
      state.rotates = false;
      state.refreshes = 0;
      state.validTokens = new Set([initialRefreshToken]);
      state.hold = Promise.resolve(undefined);
      state.bodyNeverEnds = false;
      state.status = undefined;
    },
  };
};
