import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  streamSimpleOpenAIResponses,
} from '@earendil-works/pi-ai';
import { captureRateLimit } from './quota.js';

const GROK_CLI_VERSION = '0.2.16';

/**
 * Stream function that adds Grok CLI-specific headers to requests.
 *
 * The real Grok CLI sends these headers:
 *   - x-grok-client-identifier: grok-shell
 *   - x-grok-client-version: 0.2.16
 *   - x-grok-conv-id: <session/conversation ID>
 *   - x-grok-model-override: <model ID>
 *   - x-xai-token-auth: xai-grok-cli
 */
export function streamGrokCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const sessionId = options?.sessionId;
  const headers: Record<string, string> = {
    ...options?.headers,
    'x-grok-client-identifier': 'pi-grok-cli',
    'x-grok-client-version': GROK_CLI_VERSION,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-model-override': model.id,
  };

  if (sessionId) {
    headers['x-grok-conv-id'] = sessionId;
  }

  return streamSimpleOpenAIResponses(model as Model<'openai-responses'>, context, {
    ...options,
    headers,
    onResponse(response) {
      captureRateLimit(model.id, response.headers);
      options?.onResponse?.(response, model);
    },
  });
}
