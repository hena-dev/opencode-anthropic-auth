---
"@henadev/opencode-anthropic-auth": minor
---

Support OpenCode v2.0.4 and pin the `@opencode/plugin` dependency to `2.0.4`.

OpenCode 2.0.4 removed the plugin `catalog` domain and split it into separate `provider` and `model` domains. Subscription pricing now applies through `ctx.model.transform` and replays with `ctx.model.reload()` when the active credential switches.

This release requires an OpenCode 2.0.4 or newer host. Stay on `0.2.0` for OpenCode 2.0.0 through 2.0.3.
