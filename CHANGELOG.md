# @henadev/opencode-anthropic-auth

## 0.2.0

### Minor Changes

- Migrate to the OpenCode v2 `@opencode/plugin` API with the stable plugin ID `henadev.anthropic-auth`. This release requires OpenCode v2; configuration now uses `plugins` and object-form options.
- Register Claude Pro/Max through integrations, with host-managed credential persistence and token refresh. Use the built-in integration for API keys; remove the unsupported OAuth-to-API-key creation flow and per-request TLS bypass.
- Move request rewriting to native HTTP hooks and subscription pricing to a replayable catalog transform that follows credential switches.
- Preserve dynamic Claude Code version resolution and migrate its cache to durable plugin storage.
- Restore exact tool names using request-scoped aliases, including collisions, forced tool choices, and history. Handle fragmented UTF-8/SSE responses, JSON responses, and cancellation correctly.

## 0.1.0

### Minor Changes

- [#15](https://github.com/hena-dev/opencode-anthropic-auth/pull/15) [`9e2bbfb`](https://github.com/hena-dev/opencode-anthropic-auth/commit/9e2bbfbf853a8c736f535c34112f3118f8030187) Thanks [@hena-dev](https://github.com/hena-dev)! - Resolve the reported Claude Code version dynamically instead of a static constant.

  The `user-agent` header and the billing header's `cc_version` field now resolve from (in order): an explicit `CLAUDE_CODE_VERSION` env var or `claudeCodeVersion` plugin option, a local disk cache (`~/.cache/opencode-anthropic-auth/claude-code-version.json`, 24h TTL), or a lookup of the `latest` dist-tag from the npm registry. Resolution is memoized per session and falls back to a known-good pinned version if the lookup fails or is disabled (`OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK=1`), so this never blocks or breaks a request.

  This is the only outbound request the plugin makes to a host other than Anthropic's API — see the README's "Dynamic version resolution" section for the full resolution order and how to opt out.

## 0.0.2

### Patch Changes

- [#13](https://github.com/hena-dev/opencode-anthropic-auth/pull/13) [`2ad281d`](https://github.com/hena-dev/opencode-anthropic-auth/commit/2ad281d376a25166bae042c1c240deaa686bd380) Thanks [@hena-dev](https://github.com/hena-dev)! - Document that publishing uses npm trusted publishing (OIDC) from GitHub Actions.

This package is a fork of [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth), forked at upstream version `1.8.1`. History prior to the fork lives in the upstream repository.

## 0.0.1

Initial release under the `@henadev` npm scope.
