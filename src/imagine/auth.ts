import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveGrokToken } from '../provider/accounts.js';

export async function resolveImagineToken(ctx: ExtensionContext) {
  return resolveGrokToken(ctx);
}

export const IMAGINE_AUTH_ERROR =
  'Imagine requires Grok CLI authentication. Run /login grok-cli or set GROK_CLI_OAUTH_TOKEN.';
