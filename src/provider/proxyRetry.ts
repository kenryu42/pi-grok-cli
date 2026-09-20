import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from '@earendil-works/pi-ai';

export async function* streamWithProxyRetry(options: {
  start: () => AssistantMessageEventStream;
  rotate?: () => void;
  signal?: AbortSignal;
  onMessage: (message: AssistantMessage) => void;
}): AsyncGenerator<AssistantMessageEvent> {
  for (let attempt = 0; ; attempt += 1) {
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
    if (
      !started &&
      !options.signal?.aborted &&
      message.stopReason === 'error' &&
      /^OpenAI API error \((401|502|520)\)/.test(message.errorMessage ?? '') &&
      attempt < 2 &&
      options.rotate
    ) {
      try {
        options.rotate();
        continue;
      } catch {
        // A failed session write must not replace the original proxy error.
      }
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
