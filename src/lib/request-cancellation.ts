import type { Response } from "express";

// Cancel retry waits and provider reads when an HTTP caller disconnects.
export function responseCancellation(response: Response) {
  const controller = new AbortController();
  const onClose = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.on("close", onClose);
  return { signal: controller.signal, dispose: () => response.off("close", onClose) };
}
