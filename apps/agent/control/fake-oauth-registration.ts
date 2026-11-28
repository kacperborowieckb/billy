export const answerFakeRegistration = (
  metadata: Readonly<Record<string, unknown>>,
  { method, secret }: { readonly method: string; readonly secret: string }
) =>
  Response.json(
    {
      redirect_uris: metadata["redirect_uris"],
      client_id: "fake-dcr-client",
      ...(method === "none" ? {} : { client_secret: secret }),
      token_endpoint_auth_method: method,
    },
    { status: 201 }
  );
