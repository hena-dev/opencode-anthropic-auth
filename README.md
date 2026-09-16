# OpenCode Anthropic Auth Plugin

> [!NOTE]
> This is a fork of [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth) (forked at v1.8.1), published under the `@henadev` npm scope.

> [!WARNING]
> This plugin comes with no guarantees. You might be banned for breaking the TOS, you might not be. I don't work at Anthropic, nor am I an attorney.
>
> Use your best judgment and don't try to abuse the subscriptions. Plugins like oh-my-openagent are _known_ to trigger bans. Please be careful when using Ralph loops or insanely heavy usage patterns.

> [!IMPORTANT]
> If you are seeing issues, please try to `rm -rf ~/.cache/opencode/packages/@henadev` and check your `opencode.json` config to make sure you're on the latest version.
>
> Try this FIRST before making an Issue. Thanks!
>
> Note: if you previously used `@ex-machina/opencode-anthropic-auth`, remove it from your plugin list — having both installed will load both.

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

## Version support

**Version 0.3.0 requires OpenCode v2.0.4 or newer and Bun 1.4.2 or newer**, using the `@opencode/plugin` API (SDK dependency pinned to `2.0.4`). OpenCode 2.0.4 split the plugin `catalog` domain into separate `provider` and `model` domains, so this release does not run on earlier v2 hosts — stay on `0.2.0` for OpenCode 2.0.0 through 2.0.3. Versions through `0.1.0` use the OpenCode v1 plugin API.

Upstream also maintains a [v2 branch](https://github.com/ex-machina-co/opencode-anthropic-auth/tree/v2/main), published as `@ex-machina/opencode-anthropic-auth@next` (`2.0.0-next.1` as of September 14, 2026). That release targets the older `@opencode-ai/plugin@0.0.0-next-17444` beta API. This fork targets the current `@opencode/plugin` API and retains dynamic version resolution and subscription cost display.

## Usage

Add the plugin to your OpenCode configuration:

```json
{
  "plugins": ["@henadev/opencode-anthropic-auth@0.3.0"]
}
```

> [!TIP]
> It is STRONGLY advised that you pin the plugin to a version. This will keep you from getting automatic updates; however, this will protect you from nefarious updates.
>
> This holds true for ANY OpenCode plugin. If you do not pin them, OpenCode will automatically update them on startup. It's a massive vulnerability waiting to happen.

#### Example of pinned version

```json
{
  "plugins": ["@henadev/opencode-anthropic-auth@0.3.0"]
}
```

## Authentication Methods

Run `/connect`, select **Anthropic → Claude Pro/Max**, and complete the OAuth flow. OpenCode v2 stores the credentials and automatically persists refreshed tokens.

- **Claude Pro/Max** — The plugin's OAuth method, using your subscription.
- **Manual API key / `ANTHROPIC_API_KEY`** — Provided by OpenCode's built-in Anthropic integration. API-key requests retain normal API pricing and are not rewritten by this plugin.

The v1 **Create an API Key** OAuth option is removed: v2 OAuth callbacks must return OAuth credentials, not a generated API key. Create a key in the Anthropic Console and enter it through the built-in key method instead.

### Migrating from 0.1.0

1. Change `plugin` to `plugins` and replace package/options tuples with the object format below.
2. Upgrade the plugin to `0.3.0` and quit and restart OpenCode v2.
3. Connect through v2's `/connect` flow if no Claude Pro/Max credential is available. The plugin does not copy credentials from v1's auth file.
4. Replace `ANTHROPIC_INSECURE` with a trusted certificate setup for your custom HTTPS endpoint.

## Configuration

The plugin supports the following environment variables:

| Variable                                            | Description                                                                                                                                                                                 |
|------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ANTHROPIC_BASE_URL`                                | Override the API endpoint URL (e.g. for proxying). Must be a valid HTTP(S) URL.                                                                                                             |
| `ANTHROPIC_INSECURE`                                | Unsupported in v2. If enabled with a custom endpoint, logs a notice and leaves TLS verification enabled. Use a trusted certificate. |
| `CLAUDE_CODE_VERSION`                                | Pin the reported Claude Code version (e.g. `2.1.87`) instead of resolving it dynamically. Same variable name the real Claude Code CLI reads for itself.                                    |
| `OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK`     | Set to `1` or `true` to disable the npm version lookup entirely and always use the plugin's built-in fallback version, with no outbound request and no disk cache.                          |

The plugin config also accepts options for the same two settings, if you'd rather not use environment variables:

```json
{
  "plugins": [
    {
      "package": "@henadev/opencode-anthropic-auth@0.3.0",
      "options": {
        "claudeCodeVersion": "2.1.87",
        "disableVersionCheck": false
      }
    }
  ]
}
```

### Dynamic version resolution

The `user-agent` header and the billing header's `cc_version` field (see below) report a Claude Code version number. Rather than shipping a version that gets stale the moment a new Claude Code release ships, the plugin resolves it dynamically:

1. On the first subscription request of a plugin instance, it checks (in order): the `claudeCodeVersion` option, the `CLAUDE_CODE_VERSION` environment variable, then the `claude-code-version` entry in OpenCode's durable plugin storage, scoped to `henadev.anthropic-auth`.
2. If the cache is missing or older than 24 hours, it queries `registry.npmjs.org` for the `latest` dist-tag of `@anthropic-ai/claude-code` — a single ~60-byte request, with a 2 second timeout. A stale cache is still used immediately for that request; the refresh happens in the background for next time.
3. The result is persisted in plugin storage and reused for the lifetime of the plugin instance. The v1 cache file is no longer read or written. Quit and restart OpenCode to pick up changed options or a refreshed version.
4. If the lookup fails for any reason (offline, npm unreachable, malformed response), or if `OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK` is set, it falls back to a known-good pinned version baked into the plugin — no request ever blocks or fails because of this.

This is the only outbound request this plugin makes to a host other than Anthropic's own API. If you'd rather it never happen, set `OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK=1`.

## How It Works

For Claude Pro/Max authentication, the plugin:

1. Initiates a PKCE OAuth flow against Anthropic's authorization endpoint
2. Exchanges the authorization code for access and refresh tokens
3. Automatically refreshes expired tokens
4. Injects the required OAuth headers and beta flags into API requests
5. Sanitizes the system prompt for compatibility (see below)
6. Zeros out model costs while Claude Pro/Max is active, restoring API pricing when switching to an API key or disconnecting

Request transformations use v2's provider-filtered `http.request` and `http.response` hooks. They cover native Anthropic session requests, including primary requests, titles, compaction, and `ctx.session.generate`. Standalone `ctx.generate.text` and custom AI SDK fallback transports bypass these hooks in the target host and are not supported for subscription request rewriting.

Tool aliases are request-scoped and reversed before OpenCode parses JSON or SSE responses. Streaming transformations preserve UTF-8, chunk boundaries, cancellation, and exact original tool-name casing.

### System Prompt Sanitization

The Anthropic API for Max subscriptions has specific requirements for the system prompt to identify as Claude Code. The plugin rewrites the system prompt on each request using an **anchor-based** approach that minimizes what gets changed:

1. **Identity swap** — The OpenCode identity line is removed and replaced with the Claude Code identity.
2. **Paragraph removal by anchor** — Any paragraph containing a known URL anchor (e.g. `github.com/anomalyco/opencode`, `opencode.ai/docs`) is removed entirely. This is resilient to upstream rewording — as long as the anchor URL appears somewhere in the paragraph, the removal works regardless of surrounding text changes.
3. **Inline text replacements** — Short branded strings inside paragraphs we want to keep are replaced (e.g. "OpenCode" → "the assistant" in the professional objectivity section).

Everything else in the system prompt is preserved: tone/style guidance, task management instructions, tool usage policy, environment info, skills, user/project instructions, and file paths containing "opencode". The sanitized system prompt is structured as three blocks in `system[]`: the billing header, the Claude Code identity line, and the remaining system content.

## Development

### Local Testing

Use `bun run dev` to test plugin changes locally without publishing to npm:

```bash
bun run dev
```

This does three things:

1. Builds the plugin
2. Symlinks the build output into `.opencode/plugins/` so OpenCode loads it as a local plugin
3. Starts `tsc --watch` for automatic rebuilds on source changes

After starting the dev script, quit and restart OpenCode v2 in this project directory to pick up the local build. Any edits to `src/` will trigger a rebuild — restart OpenCode again to load the new version. The active plugin list should show `henadev.anthropic-auth`, and Anthropic should offer the `Claude Pro/Max` OAuth method.

Ctrl+C stops the watcher and cleans up the symlink. If the process was killed without cleanup (e.g. `kill -9`), you can manually remove the symlink:

```bash
bun run dev:clean
```

> [!NOTE]
> Remove the npm entry when testing the local build. V2 requires unique plugin IDs; loading both copies produces a duplicate-ID error.

### Checks

```bash
bun test
bun run types
bun run lint
bun run format:check
bun run build
```

### Publishing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing. See the [changeset README](.changeset/README.md) for more details.

```bash
bun change          # create a changeset describing your changes
```

When changesets are merged to `main`, CI will automatically open a release PR. Merging that PR publishes to npm.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) from GitHub Actions — there's no `NPM_TOKEN` secret to manage, and published versions carry [provenance attestations](https://docs.npmjs.com/generating-provenance-statements).

## License

MIT
