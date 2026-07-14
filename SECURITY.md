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

- pi-grok-cli and its tools run with the user's operating-system permissions. File and shell tools can read or modify the workspace and execute commands when the model invokes them.
- OAuth credentials returned by this extension are stored and refreshed by pi. pi-grok-cli may read the verified official Grok CLI entry in `~/.grok/auth.json`, but never writes to that file.
- Prompts, conversation context, tool definitions, and tool results are sent to the configured Grok CLI proxy.
- Images handled by vision routing are sent to the configured describer model. The local vision cache stores descriptions and hashes, not raw images.
- Optional web search is delegated to `pi-web-access` and the providers configured there.
- A configured base URL override is trusted with bearer tokens, prompts, conversation data, and tool results.

Expected provider behavior, account-specific model availability, subscription quotas, model-generated content, a model choosing an enabled local tool, and changes made after a user deliberately configures an untrusted endpoint are generally out of scope unless pi-grok-cli violates a documented boundary or exposes data beyond that configuration.
