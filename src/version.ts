import type { StorageDomain } from '@opencode/plugin/promise/storage'
import { FALLBACK_CLAUDE_CODE_VERSION } from './constants.ts'

const NPM_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code/dist-tags'
const CACHE_KEY = 'claude-code-version'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type VersionResolutionOptions = {
  version?: string
  disableVersionCheck?: boolean
}

type VersionCache = { version: string; fetchedAt: number }
type VersionStorage = Pick<StorageDomain, 'get' | 'set'>

function isValidSemver(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)
}

function clampToFallback(version: string): string {
  const candidate = version.split('.').map(Number)
  const fallback = FALLBACK_CLAUDE_CODE_VERSION.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const difference = (candidate[i] ?? 0) - (fallback[i] ?? 0)
    if (difference > 0) return version
    if (difference < 0) return FALLBACK_CLAUDE_CODE_VERSION
  }
  return version
}

async function readCache(
  storage?: VersionStorage,
): Promise<VersionCache | undefined> {
  try {
    const value = await storage?.get(CACHE_KEY)
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'version' in value &&
      'fetchedAt' in value &&
      isValidSemver(value.version) &&
      typeof value.fetchedAt === 'number' &&
      Number.isFinite(value.fetchedAt)
    )
      return { version: value.version, fetchedAt: value.fetchedAt }
  } catch {
    // The cache is best-effort; storage failure must not prevent a request.
  }
}

async function refreshCache(storage?: VersionStorage, signal?: AbortSignal) {
  try {
    const response = await fetch(NPM_DIST_TAGS_URL, {
      signal: AbortSignal.any([
        AbortSignal.timeout(2000),
        ...(signal ? [signal] : []),
      ]),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      await response.body?.cancel()
      return
    }
    const data = (await response.json()) as Record<string, unknown>
    if (!isValidSemver(data.latest)) return
    const version = clampToFallback(data.latest)
    if (!signal?.aborted) {
      await storage
        ?.set(CACHE_KEY, { version, fetchedAt: Date.now() })
        .catch(() => {})
    }
    return version
  } catch {
    // Offline, aborted, malformed response, or timeout: use the fallback.
  }
}

/** Resolve once per plugin instance. Stale cache refreshes apply next time. */
export async function resolveClaudeCodeVersion(
  options: VersionResolutionOptions = {},
  storage?: VersionStorage,
  signal?: AbortSignal,
): Promise<string> {
  const explicit = options.version?.trim()
  if (isValidSemver(explicit)) return explicit
  const env = process.env.CLAUDE_CODE_VERSION?.trim()
  if (isValidSemver(env)) return env
  const disabled =
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK?.trim()
  if (options.disableVersionCheck || disabled === '1' || disabled === 'true') {
    return FALLBACK_CLAUDE_CODE_VERSION
  }

  const cached = await readCache(storage)
  if (cached) {
    if (Date.now() - cached.fetchedAt >= CACHE_TTL_MS)
      void refreshCache(storage, signal)
    return clampToFallback(cached.version)
  }
  return (await refreshCache(storage, signal)) ?? FALLBACK_CLAUDE_CODE_VERSION
}

export function parseVersionOptions(raw: unknown): VersionResolutionOptions {
  if (!raw || typeof raw !== 'object') return {}
  const options = raw as Record<string, unknown>
  return {
    version:
      typeof options.claudeCodeVersion === 'string'
        ? options.claudeCodeVersion
        : undefined,
    disableVersionCheck:
      typeof options.disableVersionCheck === 'boolean'
        ? options.disableVersionCheck
        : undefined,
  }
}
