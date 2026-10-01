import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from '@earendil-works/pi-ai';

export async function* streamWithProxyRetry(options: {
  start: () => AssistantMessageEventStream;
  rotate?: () => void;
  refreshVersion?: () => Promise<void>;
  signal?: AbortSignal;
  onMessage: (message: AssistantMessage) => void;
}): AsyncGenerator<AssistantMessageEvent> {
  let rotations = 0;
  let versionRefreshed = false;
  for (;;) {
    const stream = options.start();
    let started = false;
    for await (const event of stream) {
      if (event.type === 'error') break;
      if (event.type === 'done') {
        options.onMessage(event.message);
        yield event;
        return;
      }
      started = true;
      yield event;
    }

    const message = await stream.result();
    const status =
      !started && !options.signal?.aborted && message.stopReason === 'error'
        ? /^grok-cli API error \((\d+)\)/.exec(message.errorMessage ?? '')?.[1]
        : undefined;
    if (status === '426' && !versionRefreshed && options.refreshVersion) {
      versionRefreshed = true;
      await options.refreshVersion();
      continue;
    }
    if (
      (status === '401' || status === '502' || status === '520') &&
      rotations < 2 &&
      options.rotate
    ) {
      try {
        options.rotate();
        rotations += 1;
        continue;
      } catch {
        // A failed session write must not replace the original proxy error.
      }
    }
    if (message.stopReason === 'pending') {
      throw new Error('Grok CLI response ended without a stop reason');
    }
    options.onMessage(message);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      yield { type: 'error', reason: message.stopReason, error: message };
      return;
    }
    yield { type: 'done', reason: message.stopReason, message };
    return;
  }
}
