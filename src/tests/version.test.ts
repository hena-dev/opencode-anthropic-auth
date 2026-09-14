import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { StorageDomain } from '@opencode/plugin/promise/storage'
import { FALLBACK_CLAUDE_CODE_VERSION } from '../constants'
import { parseVersionOptions, resolveClaudeCodeVersion } from '../version'

const originalFetch = globalThis.fetch
const envVersion = process.env.CLAUDE_CODE_VERSION
const envDisable = process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK
let storage: Pick<StorageDomain, 'get' | 'set'>
let cache: Awaited<ReturnType<StorageDomain['get']>>

beforeEach(() => {
  delete process.env.CLAUDE_CODE_VERSION
  delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK
  cache = undefined
  storage = {
    get: mock(async () => cache),
    set: mock(async (_key, value) => {
      cache = value
    }),
  }
  globalThis.fetch = mock(() => {
    throw new Error('Unexpected network call')
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  if (envVersion === undefined) delete process.env.CLAUDE_CODE_VERSION
  else process.env.CLAUDE_CODE_VERSION = envVersion
  if (envDisable === undefined)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK
  else process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK = envDisable
})

describe('v2 version storage', () => {
  test('option overrides environment and skips storage and network', async () => {
    process.env.CLAUDE_CODE_VERSION = '5.5.5'
    expect(await resolveClaudeCodeVersion({ version: '9.9.9' }, storage)).toBe(
      '9.9.9',
    )
    expect(storage.get).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test('invalid option falls through to environment', async () => {
    process.env.CLAUDE_CODE_VERSION = '5.5.5'
    expect(
      await resolveClaudeCodeVersion({ version: 'invalid' }, storage),
    ).toBe('5.5.5')
  })

  test('disable option skips storage and network', async () => {
    expect(
      await resolveClaudeCodeVersion({ disableVersionCheck: true }, storage),
    ).toBe(FALLBACK_CLAUDE_CODE_VERSION)
    expect(storage.get).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  for (const value of ['1', 'true']) {
    test(`disable environment value ${value} skips storage and network`, async () => {
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK = value
      expect(await resolveClaudeCodeVersion({}, storage)).toBe(
        FALLBACK_CLAUDE_CODE_VERSION,
      )
      expect(storage.get).not.toHaveBeenCalled()
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
  }

  test('fresh durable cache survives resolver instances without a fetch', async () => {
    cache = { version: '9.1.0', fetchedAt: Date.now() }
    expect(await resolveClaudeCodeVersion({}, storage)).toBe('9.1.0')
    expect(await resolveClaudeCodeVersion({}, storage)).toBe('9.1.0')
    expect(storage.get).toHaveBeenCalledWith('claude-code-version')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test('stale cache is returned immediately; background refresh applies next time', async () => {
    cache = { version: '9.1.0', fetchedAt: Date.now() - 25 * 60 * 60 * 1000 }
    let finish: (value: Response) => void = () => {}
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    ) as unknown as typeof fetch
    expect(await resolveClaudeCodeVersion({}, storage)).toBe('9.1.0')
    finish(Response.json({ latest: '9.2.0' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await resolveClaudeCodeVersion({}, storage)).toBe('9.2.0')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  test('cold lookup caches npm latest and clamps it to the fallback', async () => {
    globalThis.fetch = mock(async (url) => {
      expect(url).toBe(
        'https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code/dist-tags',
      )
      return Response.json({ latest: '1.0.0' })
    }) as unknown as typeof fetch
    expect(await resolveClaudeCodeVersion({}, storage)).toBe(
      FALLBACK_CLAUDE_CODE_VERSION,
    )
    expect(storage.set).toHaveBeenCalledTimes(1)
    expect(await resolveClaudeCodeVersion({}, storage)).toBe(
      FALLBACK_CLAUDE_CODE_VERSION,
    )
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  test('invalid cached values are ignored', async () => {
    cache = { version: 'invalid', fetchedAt: Date.now() }
    globalThis.fetch = mock(async () =>
      Response.json({ latest: '9.2.0' }),
    ) as unknown as typeof fetch
    expect(await resolveClaudeCodeVersion({}, storage)).toBe('9.2.0')
  })

  test('unavailable storage does not discard a successful lookup', async () => {
    storage = {
      get: async () => {
        throw new Error('storage unavailable')
      },
      set: async () => {
        throw new Error('storage unavailable')
      },
    }
    globalThis.fetch = mock(async () =>
      Response.json({ latest: '9.2.0' }),
    ) as unknown as typeof fetch
    expect(await resolveClaudeCodeVersion({}, storage)).toBe('9.2.0')
  })

  for (const response of [
    () => new Response('', { status: 500 }),
    () => new Response('invalid json'),
    () => Response.json({ latest: 'invalid' }),
    () => Response.json({}),
  ]) {
    test('failed lookup falls back without persisting a cache entry', async () => {
      globalThis.fetch = mock(async () => response()) as unknown as typeof fetch
      expect(await resolveClaudeCodeVersion({}, storage)).toBe(
        FALLBACK_CLAUDE_CODE_VERSION,
      )
      expect(storage.set).not.toHaveBeenCalled()
    })
  }

  test('abort reaches the lookup and does not write storage', async () => {
    const controller = new AbortController()
    globalThis.fetch = mock(async (_url, init) => {
      controller.abort()
      init?.signal?.throwIfAborted()
      throw new Error('Expected aborted signal')
    }) as unknown as typeof fetch
    expect(await resolveClaudeCodeVersion({}, storage, controller.signal)).toBe(
      FALLBACK_CLAUDE_CODE_VERSION,
    )
    expect(storage.set).not.toHaveBeenCalled()
  })
})

test('parses v2 options and ignores incorrectly typed values', () => {
  expect(parseVersionOptions(undefined)).toEqual({})
  expect(parseVersionOptions(null)).toEqual({})
  expect(parseVersionOptions('nope')).toEqual({})
  expect(
    parseVersionOptions({
      claudeCodeVersion: '9.9.9',
      disableVersionCheck: true,
    }),
  ).toEqual({ version: '9.9.9', disableVersionCheck: true })
  expect(
    parseVersionOptions({
      claudeCodeVersion: 123,
      disableVersionCheck: 'true',
    }),
  ).toEqual({ version: undefined, disableVersionCheck: undefined })
})
