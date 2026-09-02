import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FALLBACK_CLAUDE_CODE_VERSION } from '../constants'
import { parseVersionOptions, resolveClaudeCodeVersion } from '../version'

const CACHE_SUBDIR = 'opencode-anthropic-auth'
const CACHE_FILE_NAME = 'claude-code-version.json'
const NPM_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code/dist-tags'

function cachePathIn(xdgCacheHome: string): string {
  return join(xdgCacheHome, CACHE_SUBDIR, CACHE_FILE_NAME)
}

async function writeCacheFile(
  xdgCacheHome: string,
  data: { version: string; fetchedAt: number },
) {
  await mkdir(join(xdgCacheHome, CACHE_SUBDIR), { recursive: true })
  await writeFile(cachePathIn(xdgCacheHome), JSON.stringify(data), 'utf8')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('resolveClaudeCodeVersion', () => {
  const originalFetch = globalThis.fetch
  const originalEnvVersion = process.env.CLAUDE_CODE_VERSION
  const originalEnvDisable =
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK
  const originalXdgCacheHome = process.env.XDG_CACHE_HOME

  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ocaa-version-test-'))
    process.env.XDG_CACHE_HOME = tempDir
    delete process.env.CLAUDE_CODE_VERSION
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK

    // Default: fail loudly if a test reaches the network without opting
    // in via its own mock. Keeps "no fetch expected" assertions honest.
    globalThis.fetch = mock(() => {
      throw new Error('unexpected fetch call in test')
    }) as unknown as typeof fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch

    if (originalEnvVersion === undefined) {
      delete process.env.CLAUDE_CODE_VERSION
    } else {
      process.env.CLAUDE_CODE_VERSION = originalEnvVersion
    }

    if (originalEnvDisable === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK
    } else {
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK =
        originalEnvDisable
    }

    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome
    }

    await rm(tempDir, { recursive: true, force: true })
  })

  describe('explicit overrides', () => {
    test('plugin option version wins over the env var, no network call', async () => {
      process.env.CLAUDE_CODE_VERSION = '5.5.5'
      const version = await resolveClaudeCodeVersion({ version: '9.9.9' })
      expect(version).toBe('9.9.9')
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    test('env var override is used when no option is given', async () => {
      process.env.CLAUDE_CODE_VERSION = '3.4.5'
      const version = await resolveClaudeCodeVersion()
      expect(version).toBe('3.4.5')
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    test('invalid option version falls through to the env override', async () => {
      process.env.CLAUDE_CODE_VERSION = '3.4.5'
      const version = await resolveClaudeCodeVersion({
        version: 'not-semver',
      })
      expect(version).toBe('3.4.5')
    })

    test('invalid env override falls through to the disable/cache/network path', async () => {
      process.env.CLAUDE_CODE_VERSION = 'not-semver'
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK = '1'
      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
    })
  })

  describe('disableVersionCheck', () => {
    test('option disables cache and network, returns the fallback', async () => {
      const version = await resolveClaudeCodeVersion({
        disableVersionCheck: true,
      })
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    test('env var ("1") disables cache and network, returns the fallback', async () => {
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK = '1'
      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    test('env var ("true") disables cache and network, returns the fallback', async () => {
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK = 'true'
      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
  })

  describe('disk cache', () => {
    test('fresh cache hit returns the cached version without a network call', async () => {
      await writeCacheFile(tempDir, {
        version: '2.5.0',
        fetchedAt: Date.now(),
      })
      const version = await resolveClaudeCodeVersion()
      expect(version).toBe('2.5.0')
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    test('stale cache returns the cached version immediately, then refreshes in the background', async () => {
      const staleAgeMs = 25 * 60 * 60 * 1000 // 25h > the 24h TTL
      await writeCacheFile(tempDir, {
        version: '2.5.0',
        fetchedAt: Date.now() - staleAgeMs,
      })

      const fetchMock = mock(() =>
        Promise.resolve(jsonResponse({ latest: '2.9.9' })),
      )
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      // The stale value is returned immediately — never the in-flight fetch.
      expect(version).toBe('2.5.0')

      // Let the fire-and-forget background refresh complete.
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // Next resolution now sees the refreshed cache.
      const second = await resolveClaudeCodeVersion()
      expect(second).toBe('2.9.9')
    })

    test('clamps a cached version below the fallback back up to the fallback', async () => {
      await writeCacheFile(tempDir, {
        version: '1.0.0',
        fetchedAt: Date.now(),
      })
      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
    })

    test('ignores a corrupt cache file and falls through to the network', async () => {
      await mkdir(join(tempDir, CACHE_SUBDIR), { recursive: true })
      await writeFile(cachePathIn(tempDir), 'not valid json', 'utf8')

      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ latest: '2.9.9' })),
      ) as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      expect(version).toBe('2.9.9')
    })
  })

  describe('network fetch (cold cache)', () => {
    test('fetches from the npm dist-tags endpoint and caches the result', async () => {
      const fetchMock = mock((url: string) => {
        expect(url).toBe(NPM_DIST_TAGS_URL)
        return Promise.resolve(
          jsonResponse({
            stable: '2.1.236',
            latest: '2.1.258',
            next: '2.1.258',
          }),
        )
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      expect(version).toBe('2.1.258')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // Second resolution should hit the now-fresh cache, not the network.
      const second = await resolveClaudeCodeVersion()
      expect(second).toBe('2.1.258')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('falls back to the constant on an HTTP error status', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({}, 500)),
      ) as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
    })

    test('falls back to the constant on a malformed JSON body', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('not json', { status: 200 })),
      ) as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
    })

    test('falls back to the constant when the dist-tag is not a valid semver string', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ latest: 'not-a-version' })),
      ) as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
    })

    test('falls back to the constant when the dist-tag is missing', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ stable: '2.1.236' })),
      ) as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
    })

    test('falls back to the constant when fetch rejects (offline/timeout/abort)', async () => {
      globalThis.fetch = mock(() =>
        Promise.reject(
          new DOMException('The operation was aborted', 'AbortError'),
        ),
      ) as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
    })

    test('falls back to the constant when fetch throws synchronously', async () => {
      globalThis.fetch = mock(() => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
    })

    test('clamps a fetched version below the fallback back up to the fallback', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ latest: '1.0.0' })),
      ) as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      expect(version).toBe(FALLBACK_CLAUDE_CODE_VERSION)
    })

    test('does not persist a cache entry when the fetch fails', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({}, 500)),
      ) as unknown as typeof fetch
      await resolveClaudeCodeVersion()

      // If the failed attempt had been cached, this second resolution
      // would return a stale/failed value without calling fetch again.
      const fetchMock = mock(() =>
        Promise.resolve(jsonResponse({ latest: '2.1.258' })),
      )
      globalThis.fetch = fetchMock as unknown as typeof fetch
      const version = await resolveClaudeCodeVersion()
      expect(version).toBe('2.1.258')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('resilience', () => {
    test('never throws and still resolves when the cache directory cannot be created', async () => {
      // Point XDG_CACHE_HOME at a *file*, so mkdir(recursive) for the
      // cache dir underneath it fails with ENOTDIR.
      const blockerFile = join(tempDir, 'not-a-directory')
      await writeFile(blockerFile, 'x', 'utf8')
      process.env.XDG_CACHE_HOME = blockerFile

      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ latest: '2.1.258' })),
      ) as unknown as typeof fetch

      const version = await resolveClaudeCodeVersion()
      expect(version).toBe('2.1.258')
    })
  })
})

describe('parseVersionOptions', () => {
  test('returns an empty object for undefined', () => {
    expect(parseVersionOptions(undefined)).toEqual({})
  })

  test('returns an empty object for null', () => {
    expect(parseVersionOptions(null)).toEqual({})
  })

  test('returns an empty object for non-object input', () => {
    expect(parseVersionOptions('nope')).toEqual({})
  })

  test('extracts a valid claudeCodeVersion string', () => {
    expect(parseVersionOptions({ claudeCodeVersion: '9.9.9' })).toEqual({
      version: '9.9.9',
      disableVersionCheck: undefined,
    })
  })

  test('extracts a valid disableVersionCheck boolean', () => {
    expect(parseVersionOptions({ disableVersionCheck: true })).toEqual({
      version: undefined,
      disableVersionCheck: true,
    })
  })

  test('ignores wrong-typed fields', () => {
    expect(
      parseVersionOptions({
        claudeCodeVersion: 123,
        disableVersionCheck: 'yes',
      }),
    ).toEqual({ version: undefined, disableVersionCheck: undefined })
  })
})
