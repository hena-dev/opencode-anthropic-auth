import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  Agent,
  type Credential,
  Model,
  type Plugin,
  Provider,
} from '@opencode/plugin'
import type { CatalogEditor } from '@opencode/plugin/promise/catalog'
import type {
  IntegrationEditor,
  IntegrationOAuthMethodRegistration,
} from '@opencode/plugin/promise/integration'
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRequestKind,
} from '@opencode/plugin/promise/session'
import { CLAUDE_CODE_IDENTITY, TOKEN_URL } from '../constants'
import plugin from '../index'

const originalFetch = globalThis.fetch
const originalBase = process.env.ANTHROPIC_BASE_URL
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalBase === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalBase
})

async function fixture(oauth = true) {
  let method: IntegrationOAuthMethodRegistration
  let before: (event: SessionHttpRequest) => Promise<void>
  let after: (event: SessionHttpResponse) => void
  let transform: (editor: CatalogEditor) => void
  let nextEvent:
    | ((event: { type: 'credential.switched' } | undefined) => void)
    | undefined
  let credential: Credential.Value | undefined
  const prices = [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }]
  let costs = structuredClone(prices)
  const storage = new Map()
  const filters: unknown[] = []
  const reload = mock(async () => {
    // Real transforms replay on the base catalog, rather than the last output.
    const model = { cost: structuredClone(prices) }
    transform({
      provider: { get: () => ({ models: new Map([['claude', model]]) }) },
      model: {
        update: (
          _provider: string,
          _id: string,
          update: (draft: typeof model) => void,
        ) => update(model),
      },
    } as unknown as CatalogEditor)
    costs = model.cost
  })
  const ctx = {
    options: { claudeCodeVersion: '9.8.7' },
    integration: {
      transform: async (callback: (editor: IntegrationEditor) => void) => {
        callback({
          method: {
            update: (registration: IntegrationOAuthMethodRegistration) => {
              method = registration
              credential = oauth
                ? {
                    type: 'oauth',
                    methodID: registration.method
                      .id as Credential.OAuth['methodID'],
                    access: 'access',
                    refresh: 'refresh',
                    expires: Date.now() + 3_600_000,
                  }
                : { type: 'key', key: 'api-key' }
            },
          },
        } as unknown as IntegrationEditor)
      },
      connection: {
        active: async () =>
          credential ? { type: 'credential', id: 'fixture' } : undefined,
        resolve: async () => credential,
      },
    },
    catalog: {
      transform: async (callback: typeof transform) => {
        transform = callback
      },
      reload,
    },
    session: {
      hook: async (
        name: string,
        callback: typeof before | typeof after,
        filter: unknown,
      ) => {
        filters.push(filter)
        if (name === 'http.request') before = callback as typeof before
        if (name === 'http.response') after = callback as typeof after
      },
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          const event = await new Promise<
            { type: 'credential.switched' } | undefined
          >((resolve) => {
            nextEvent = resolve
            signal.addEventListener('abort', () => resolve(undefined), {
              once: true,
            })
          })
          if (!event) return
          yield event
        }
      },
    },
  }
  const cleanup = await plugin.setup(ctx as unknown as Plugin.Context)
  const scope = {
    sessionID: 'ses_fixture' as SessionHttpRequest['sessionID'],
    agent: Agent.ID.make('build'),
    model: {
      providerID: Provider.ID.make('anthropic'),
      id: Model.ID.make('claude'),
    },
    kind: 'primary' as const,
  }
  return {
    get method() {
      return method
    },
    get credential() {
      return credential as Credential.OAuth
    },
    get costs() {
      return costs
    },
    filters,
    reload,
    async request(
      body: unknown,
      kind: SessionRequestKind = 'primary',
      headers: Record<string, string> = { authorization: 'Bearer access' },
    ) {
      const event = {
        ...scope,
        kind,
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
      } as SessionHttpRequest
      await before(event)
      return event.request
    },
    response(request: Request, response: Response) {
      const event = { ...scope, request, response } as SessionHttpResponse
      after(event)
      return event.response
    },
    async switch(value?: Credential.Value) {
      credential = value
      const count = reload.mock.calls.length
      nextEvent?.({ type: 'credential.switched' })
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reload.mock.calls.length).toBeGreaterThan(count)
    },
    async dispose() {
      if (cleanup) await cleanup()
    },
  }
}

describe('v2 plugin', () => {
  test('registers a stable definition and only the subscription OAuth method', async () => {
    const f = await fixture()
    try {
      expect(plugin.id).toBe('henadev.anthropic-auth')
      expect(f.method.method).toMatchObject({
        id: 'claude-max',
        type: 'oauth',
        label: 'Claude Pro/Max',
      })
      expect(f.filters).toEqual([
        { providerID: 'anthropic' },
        { providerID: 'anthropic' },
      ])
      const authorization = await f.method.authorize({})
      expect(authorization.mode).toBe('code')
      expect(new URL(authorization.url).hostname).toBe('claude.ai')
      if (authorization.mode !== 'code') throw new Error('Expected code mode')
      await expect(authorization.callback('invalid')).rejects.toThrow(
        'Failed to exchange',
      )
      globalThis.fetch = mock(async (input, init) => {
        expect(input).toBe(TOKEN_URL)
        expect(JSON.parse(init?.body as string).grant_type).toBe(
          'authorization_code',
        )
        return Response.json({
          access_token: 'new',
          refresh_token: 'rotated',
          expires_in: 3600,
        })
      }) as unknown as typeof fetch
      const state = new URL(authorization.url).searchParams.get('state')
      expect(await authorization.callback(`code#${state}`)).toMatchObject({
        type: 'oauth',
        methodID: 'claude-max',
        access: 'new',
        refresh: 'rotated',
      })
    } finally {
      await f.dispose()
    }
  })

  test('deduplicates refreshes and returns credentials for host persistence', async () => {
    const f = await fixture()
    try {
      const request = mock(async () =>
        Response.json({
          access_token: 'new',
          refresh_token: 'rotated',
          expires_in: 3600,
        }),
      )
      globalThis.fetch = request as unknown as typeof fetch
      const refresh = f.method.refresh!
      const results = await Promise.all(
        Array.from({ length: 5 }, () => refresh(f.credential)),
      )
      expect(request).toHaveBeenCalledTimes(1)
      expect(
        results.every(
          (value) => value.access === 'new' && value.refresh === 'rotated',
        ),
      ).toBe(true)
      await refresh(f.credential)
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      await f.dispose()
    }
  })

  test('does not retry rejected refresh tokens and allows subsequent fresh attempts', async () => {
    const f = await fixture()
    try {
      const request = mock(
        async () => new Response('private provider error', { status: 400 }),
      )
      globalThis.fetch = request as unknown as typeof fetch
      await expect(f.method.refresh!(f.credential)).rejects.toThrow(
        'Anthropic token refresh failed: 400',
      )
      expect(request).toHaveBeenCalledTimes(1)
      globalThis.fetch = mock(async () =>
        Response.json({
          access_token: 'new',
          refresh_token: 'rotated',
          expires_in: 3600,
        }),
      ) as unknown as typeof fetch
      expect((await f.method.refresh!(f.credential)).access).toBe('new')
    } finally {
      await f.dispose()
    }
  })

  test('restores API pricing on key login and disconnect, then zeroes on OAuth login', async () => {
    const f = await fixture()
    const oauth = f.credential
    try {
      expect(f.costs).toEqual([])
      await f.switch({ type: 'key', key: 'api-key' })
      expect(f.costs[0]?.input).toBe(3)
      await f.switch(oauth)
      expect(f.costs).toEqual([])
      await f.switch()
      expect(f.costs[0]?.input).toBe(3)
    } finally {
      await f.dispose()
    }
  })

  for (const kind of ['primary', 'compaction', 'title', 'generate'] as const) {
    test(`rewrites ${kind} HTTP requests and reverses exact tool names`, async () => {
      const f = await fixture()
      try {
        process.env.ANTHROPIC_BASE_URL = 'http://localhost:1234'
        const request = await f.request(
          {
            system: 'Project instructions',
            messages: [{ role: 'user', content: 'hello' }],
            tools: [{ name: 'ReadFile', input_schema: { type: 'object' } }],
            tool_choice: { type: 'tool', name: 'ReadFile' },
          },
          kind,
        )
        expect(request.url).toBe('http://localhost:1234/v1/messages?beta=true')
        expect(request.headers.get('user-agent')).toContain('9.8.7')
        const body = (await request.json()) as {
          system: { text: string }[]
          tool_choice: { name: string }
          tools: { name: string }[]
        }
        expect(body.system[0]!.text).toContain('cc_version=9.8.7')
        expect(body.system[1]!.text).toBe(CLAUDE_CODE_IDENTITY)
        expect(body.tool_choice.name).toBe(body.tools[0]!.name)
        const result = f.response(
          request,
          Response.json({
            type: 'message',
            content: [
              {
                type: 'tool_use',
                name: body.tools[0]!.name,
                id: 'tool_1',
                input: {},
              },
            ],
          }),
        )
        expect(await result.json()).toMatchObject({
          content: [{ name: 'ReadFile' }],
        })
      } finally {
        await f.dispose()
      }
    })
  }

  test('leaves API-key requests and unassociated responses intact', async () => {
    const f = await fixture(false)
    try {
      const body = { messages: [], tools: [{ name: 'read' }] }
      const request = await f.request(body, 'primary', { 'x-api-key': 'key' })
      expect(await request.json()).toEqual(body)
      expect(request.url).not.toContain('beta=true')
      const response = Response.json({ type: 'message', content: [] })
      expect(f.response(request, response)).toBe(response)
    } finally {
      await f.dispose()
    }
  })

  test('does not overwrite a model-specific key or a different bearer token', async () => {
    const f = await fixture()
    try {
      const overrides: Record<string, string>[] = [
        { 'x-api-key': 'override' },
        { authorization: 'Bearer other-account' },
      ]
      for (const headers of overrides) {
        const request = await f.request({ messages: [] }, 'primary', headers)
        expect(request.headers.get('user-agent')).toBeNull()
        expect(request.url).not.toContain('beta=true')
      }
    } finally {
      await f.dispose()
    }
  })
})
