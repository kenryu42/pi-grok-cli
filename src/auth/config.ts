export const XAI_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_CLIENT_ID =
  process.env.PI_GROK_CLI_OAUTH_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_TOKEN_ENDPOINT = `${XAI_ISSUER}/oauth2/token`;

export function getBaseUrl() {
  return (
    process.env.PI_GROK_CLI_BASE_URL ||
    process.env.GROK_CLI_BASE_URL ||
    'https://cli-chat-proxy.grok.com/v1'
  ).replace(/\/+$/, '');
}
