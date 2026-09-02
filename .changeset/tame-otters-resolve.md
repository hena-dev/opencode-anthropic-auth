---
"@henadev/opencode-anthropic-auth": minor
---

Resolve the reported Claude Code version dynamically instead of a static constant.

The `user-agent` header and the billing header's `cc_version` field now resolve from (in order): an explicit `CLAUDE_CODE_VERSION` env var or `claudeCodeVersion` plugin option, a local disk cache (`~/.cache/opencode-anthropic-auth/claude-code-version.json`, 24h TTL), or a lookup of the `latest` dist-tag from the npm registry. Resolution is memoized per session and falls back to a known-good pinned version if the lookup fails or is disabled (`OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK=1`), so this never blocks or breaks a request.

This is the only outbound request the plugin makes to a host other than Anthropic's API — see the README's "Dynamic version resolution" section for the full resolution order and how to opt out.
