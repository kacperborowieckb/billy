export const createFakeNotificationStream = () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    open: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (opened) => {
            controller = opened;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      ),
    get isOpen() {
      return controller !== undefined;
    },
    notifyToolsListChanged: () => {
      controller?.enqueue(
        new TextEncoder().encode(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`
        )
      );
    },
    close: () => {
      try {
        controller?.close();
      } catch {
        controller = undefined;
      }
      controller = undefined;
    },
  };
};
