const pageHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const page = (status: number, title: string, body: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font-size:1rem;padding:.6rem 1.2rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    { status, headers: pageHeaders }
  );

export const connectRefusedPage = () =>
  page(
    403,
    "This link did not work",
    "<p>Open the Connect button in your chat with Billy again. If it still fails, ask Billy to connect the service once more.</p>"
  );

export const notAvailablePage = () =>
  page(
    502,
    "Not available",
    "<p>The service could not be reached. Try again later.</p>"
  );

export const alreadyConnectedPage = () =>
  page(200, "Already connected", "<p>This service is already connected.</p>");

export const unknownServicePage = () =>
  page(404, "Unknown service", "<p>This service is not supported.</p>");
