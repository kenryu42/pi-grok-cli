# Security policy

## Supported versions

Only the latest published `pi-grok-cli` release receives security fixes; earlier releases are unsupported. Upgrade with:

```bash
pi update npm:pi-grok-cli
```

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/kenryu42/pi-grok-cli/security/advisories/new). If that route is unavailable, contact the maintainer through the email address in the npm package metadata and ask for a private reporting channel without including vulnerability details in the first message.

Include the affected version, operating system, pi version, reproduction steps, impact, and any suggested mitigation. Use synthetic data wherever possible. Do not include OAuth access or refresh tokens, authorization codes, complete callback URLs, private prompts, proprietary source code, or unrelated personal data.

The maintainer aims to acknowledge a complete report within 7 calendar days and provide a status update at least every 14 calendar days until resolution. Please allow a reasonable remediation window before public disclosure and coordinate the publication date with the maintainer. Credit and advisory wording will be agreed with the reporter when practical.

## Security boundaries

- pi-grok-cli and its tools run with the user's operating-system permissions. File and shell tools can access any path those permissions allow, including paths outside the workspace, and can execute commands when the model invokes them.
- OAuth credentials returned by this extension are stored and refreshed by pi. pi-grok-cli does not read or modify Grok Build credentials.
- Browser OAuth starts a temporary callback server on `127.0.0.1:56122` by default and falls back to an ephemeral port. `PI_GROK_CLI_CALLBACK_HOST` can bind it to another interface. The server validates the callback path and OAuth state and closes after login. Treat complete callback URLs and authorization codes as sensitive.
- `/grok-cli-accounts gui` starts a temporary account-management server bound only to an OS-assigned `127.0.0.1` port. A random capability URL bootstraps a session cookie; subsequent mutations require same-origin and CSRF validation. The page receives account labels, status, and quota data. It never receives stored OAuth credentials, callback URLs, or environment-token values; a manually entered one-time authorization code is handled transiently during login and is never returned by `/api/state`. Treat the private dashboard URL as sensitive and do not share it while the server is running.
- Prompts, conversation context, tool definitions, tool results, and native image inputs are sent to the configured Grok CLI proxy.
- Images handled by vision routing are sent to the configured describer model. The local vision cache stores descriptions and hashes, not raw images.
- Grok Imagine sends the selected account's bearer token, generation prompt, and options to `https://api.x.ai/v1` or `PI_GROK_CLI_IMAGINE_BASE_URL`. Generated JPEGs and PNG previews are saved under session storage, a requested output path, or temporary storage.
- Monthly and weekly quota totals and reset timestamps are cached per account in `~/.pi/grok-cli/quota-cache.json` with file mode `0600`. The cache does not contain OAuth tokens.
- Optional web search is delegated to `pi-web-access` and the providers configured there.
- A configured main API base URL override is trusted with bearer tokens, prompts, conversation data, tool results, images, and billing queries. An Imagine base URL override is trusted with the bearer token and generation request described above.

Expected provider behavior, account-specific model availability, subscription quotas, model-generated content, a model choosing an enabled local tool, and changes made after a user deliberately configures an untrusted endpoint are generally out of scope unless pi-grok-cli violates a documented boundary or exposes data beyond that configuration.
