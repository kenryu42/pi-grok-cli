import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export async function resolveImagineToken(ctx: ExtensionContext) {
  if (process.env.GROK_CLI_OAUTH_TOKEN) return process.env.GROK_CLI_OAUTH_TOKEN;
  try {
    return await ctx.modelRegistry.getApiKeyForProvider('grok-cli');
  } catch {
    return undefined;
  }
}

export const IMAGINE_AUTH_ERROR =
  'Imagine requires Grok CLI authentication. Run /login grok-cli or set GROK_CLI_OAUTH_TOKEN.';
