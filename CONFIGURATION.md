# Advanced configuration

Most users do not need these overrides. Only point base URL overrides at endpoints you trust because they receive OAuth bearer tokens, prompts, model context, and tool results.

| Variable | Default | Description |
| --- | --- | --- |
| `PI_GROK_CLI_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Override the API base URL. |
| `GROK_CLI_BASE_URL` | — | Fallback when `PI_GROK_CLI_BASE_URL` is unset. |
| `PI_GROK_CLI_OAUTH_CLIENT_ID` | bundled client ID | Override the OAuth client ID. |
| `PI_GROK_CLI_OAUTH_SCOPE` | `openid profile email offline_access grok-cli:access api:access conversations:read conversations:write` | Override OAuth scopes. Must include `conversations:read` and `conversations:write` for cli-chat-proxy access. |
| `PI_GROK_CLI_CALLBACK_HOST` | `127.0.0.1` | Browser callback host. |
| `PI_GROK_CLI_CALLBACK_PORT` | `56122` | Preferred callback port; falls back to an ephemeral port. |
| `PI_GROK_CLI_TOKEN_TIMEOUT_MS` | `30000` | Timeout for OAuth token requests. |
| `PI_GROK_CLI_IMAGINE_BASE_URL` | `https://api.x.ai/v1` | Override the Imagine API base URL. |
| `PI_GROK_CLI_IMAGINE_MODEL` | `grok-imagine-image-quality` | Override the Imagine image model. |
