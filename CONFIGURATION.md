# Advanced configuration

Most users do not need these overrides. Only point base URL overrides at endpoints you trust because they receive OAuth bearer tokens, prompts, model context, and tool results.

| Variable | Default | Description |
| --- | --- | --- |
| `PI_GROK_CLI_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Override the API base URL. |
| `GROK_CLI_BASE_URL` | — | Fallback when `PI_GROK_CLI_BASE_URL` is unset. |
| `PI_GROK_CLI_OAUTH_CLIENT_ID` | bundled client ID | Override the OAuth client ID. |
| `PI_GROK_CLI_OAUTH_SCOPE` | `openid profile email offline_access grok-cli:access api:access` | Override OAuth scopes. |
| `PI_GROK_CLI_CALLBACK_HOST` | `127.0.0.1` | Browser callback host. |
| `PI_GROK_CLI_CALLBACK_PORT` | `56122` | Preferred callback port; falls back to an ephemeral port. |
| `PI_GROK_CLI_TOKEN_TIMEOUT_MS` | `30000` | Timeout for OAuth token requests. |
| `PI_GROK_CLI_IMAGINE_BASE_URL` | `https://api.x.ai/v1` | Override the Imagine API base URL. |
| `PI_GROK_CLI_IMAGINE_MODEL` | `grok-imagine-image-quality` | Override the Imagine image model. |

OAuth logins store the effective main API base URL in each account's credentials. Changing or removing `PI_GROK_CLI_BASE_URL` or `GROK_CLI_BASE_URL` does not immediately redirect an already authenticated account; its stored URL remains active until token refresh or re-login. Log in again to apply the change immediately.

Real account credentials are in `~/.pi/grok-cli/accounts.json`. The file uses mode `0600`, and updates use an interprocess lock and an atomic replacement. Pi's own credential store contains only the fixed non-secret marker that connects the `grok-cli` provider.

When `GROK_CLI_OAUTH_TOKEN` is set, it overrides the saved account for requests. Account login is not available until you remove the variable and restart pi. If you use native `/logout` while this variable is set, restart pi so the extension can register the correct login method.
