import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FALLBACK_CLAUDE_CODE_VERSION } from './constants.ts'

/**
 * Resolves the Claude Code version string reported in the `user-agent`
 * header and the `cc_version` billing-header field.
 *
 * Staying close to the real, currently-shipping Claude Code version keeps
 * the fingerprint plausible as the real CLI ships new releases, instead of
 * drifting further from reality with every day that passes.
 *
 * Resolution order (first match wins):
 *
 *   1. `options.version` — explicit override, e.g. from plugin config
 *   2. `CLAUDE_CODE_VERSION` env var — explicit override from the shell
 *      (this is the same env var name the real Claude Code CLI reads for
 *      itself, so it doubles as a natural drop-in override)
 *   3. `options.disableVersionCheck` / `OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK`
 *      — skip the disk cache and network entirely, always use the
 *      fallback constant
 *   4. Disk cache (`~/.cache/opencode-anthropic-auth/claude-code-version.json`)
 *      — fresh (< 24h old) is returned as-is with no network call; stale
 *      is returned immediately while a background refresh updates the
 *      cache file for the *next* resolution (never the current one, so a
 *      single process/session always reports one consistent version)
 *   5. npm registry `dist-tags` lookup (2s timeout) — a ~60 byte request
 *      for `{ stable, latest, next }`. On success the result is cached to
 *      disk and returned; on any failure (offline, timeout, malformed
 *      response) resolution falls back to the constant
 *
 * Every externally-sourced value is validated as a plain `X.Y.Z` version
 * string and clamped to never regress below the fallback constant, since
 * this value flows directly into outbound request headers. This function
 * never throws and never returns an invalid version string.
 */

const NPM_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code/dist-tags'
const NPM_DIST_TAG = 'latest'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 2000

const ENV_VERSION_OVERRIDE = 'CLAUDE_CODE_VERSION'
const ENV_DISABLE_CHECK = 'OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK'

const SEMVER_RE = /^\d+\.\d+\.\d+$/

export type VersionResolutionOptions = {
  /** Explicit version override, e.g. from plugin config. Skips cache/network. */
  version?: string
  /** Skip the disk cache and npm lookup; always use the fallback constant. */
  disableVersionCheck?: boolean
}

type VersionCache = {
  version: string
  fetchedAt: number
}

function isValidSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_RE.test(value)
}

/** True if `a` (X.Y.Z) is numerically >= `b` (X.Y.Z). */
function isSemverGte(a: string, b: string): boolean {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const da = partsA[i] ?? 0
    const db = partsB[i] ?? 0
    if (da !== db) return da > db
  }
  return true
}

/** Never let a fetched/cached version regress below the known-good fallback. */
function clampToFallback(version: string): string {
  return isSemverGte(version, FALLBACK_CLAUDE_CODE_VERSION)
    ? version
    : FALLBACK_CLAUDE_CODE_VERSION
}

function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache')
  return join(base, 'opencode-anthropic-auth')
}

function cacheFile(): string {
  return join(cacheDir(), 'claude-code-version.json')
}

async function readCache(): Promise<VersionCache | null> {
  try {
    const raw = await readFile(cacheFile(), 'utf8')
    const data = JSON.parse(raw) as Partial<VersionCache>
    if (!isValidSemver(data.version) || typeof data.fetchedAt !== 'number') {
      return null
    }
    return { version: data.version, fetchedAt: data.fetchedAt }
  } catch {
    return null
  }
}

async function writeCache(version: string): Promise<void> {
  try {
    const dir = cacheDir()
    await mkdir(dir, { recursive: true })
    const file = cacheFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    const payload: VersionCache = { version, fetchedAt: Date.now() }
    await writeFile(tmp, JSON.stringify(payload), 'utf8')
    await rename(tmp, file)
  } catch {
    // Best-effort cache. A read-only or missing cache dir must never
    // break the request path — resolution just falls through to the
    // network (or the fallback constant) on every subsequent call
    // instead of persisting anything.
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(NPM_DIST_TAGS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const data = (await response.json()) as Record<string, unknown>
    const tag = data[NPM_DIST_TAG]
    return isValidSemver(tag) ? tag : null
  } catch {
    // Offline, DNS failure, timeout, non-JSON body, etc. — all treated
    // the same: no version, caller falls back to the constant.
    return null
  }
}

function isDisabled(options: VersionResolutionOptions): boolean {
  if (options.disableVersionCheck) return true
  const raw = process.env[ENV_DISABLE_CHECK]?.trim()
  return raw === '1' || raw === 'true'
}

function envOverride(): string | null {
  const raw = process.env[ENV_VERSION_OVERRIDE]?.trim()
  return isValidSemver(raw) ? raw : null
}

/**
 * Fire-and-forget: refreshes the on-disk cache only. Deliberately does not
 * return a promise the caller awaits — the version already resolved for
 * the current call/process is never changed mid-flight by this.
 */
function refreshCacheInBackground(): void {
  void fetchLatestVersion().then((fetched) => {
    if (fetched) return writeCache(fetched)
  })
}

/**
 * Resolve the Claude Code version to report for this request/session.
 * See the module docstring above for the full resolution order.
 */
export async function resolveClaudeCodeVersion(
  options: VersionResolutionOptions = {},
): Promise<string> {
  try {
    const explicit = options.version?.trim()
    if (isValidSemver(explicit)) return explicit

    const fromEnv = envOverride()
    if (fromEnv) return fromEnv

    if (isDisabled(options)) return FALLBACK_CLAUDE_CODE_VERSION

    const cached = await readCache()
    if (cached) {
      const isFresh = Date.now() - cached.fetchedAt < CACHE_TTL_MS
      if (!isFresh) refreshCacheInBackground()
      return clampToFallback(cached.version)
    }

    const fetched = await fetchLatestVersion()
    if (!fetched) return FALLBACK_CLAUDE_CODE_VERSION

    await writeCache(fetched)
    return clampToFallback(fetched)
  } catch {
    return FALLBACK_CLAUDE_CODE_VERSION
  }
}

/**
 * Parse plugin-config options (`PluginOptions` from `@opencode-ai/plugin`,
 * i.e. an untyped `Record<string, unknown>`) into VersionResolutionOptions.
 */
export function parseVersionOptions(raw: unknown): VersionResolutionOptions {
  if (!raw || typeof raw !== 'object') return {}
  const options = raw as Record<string, unknown>

  const version =
    typeof options.claudeCodeVersion === 'string'
      ? options.claudeCodeVersion
      : undefined
  const disableVersionCheck =
    typeof options.disableVersionCheck === 'boolean'
      ? options.disableVersionCheck
      : undefined

  return { version, disableVersionCheck }
}
