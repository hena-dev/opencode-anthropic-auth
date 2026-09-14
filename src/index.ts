import { type Credential, Integration, Plugin } from '@opencode/plugin'
import { authorize, exchange, refreshToken } from './auth.ts'
import {
  createStrippedStream,
  isInsecure,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'
import { parseVersionOptions, resolveClaudeCodeVersion } from './version.ts'

const METHOD_ID = Integration.MethodID.make('claude-max')

function toCredential(tokens: {
  access: string
  refresh: string
  expires: number
}): Credential.OAuth {
  return { type: 'oauth', methodID: METHOD_ID, ...tokens }
}

async function activeOAuth(ctx: Plugin.Context) {
  const connection = await ctx.integration.connection.active('anthropic')
  if (!connection) return
  const credential = await ctx.integration.connection.resolve(connection)
  if (credential?.type === 'oauth' && credential.methodID === METHOD_ID) {
    return credential
  }
}

export default Plugin.define({
  id: 'henadev.anthropic-auth',
  async setup(ctx) {
    if (isInsecure()) {
      console.warn(
        '[henadev.anthropic-auth] ANTHROPIC_INSECURE is unsupported in OpenCode v2. ' +
          'TLS verification remains enabled; configure a trusted certificate for your endpoint.',
      )
    }

    const controller = new AbortController()
    const options = parseVersionOptions(ctx.options)
    let version: Promise<string> | undefined
    let subscription = false
    // Keep the successful rotation briefly: the host may still be persisting it
    // when another request resolves a snapshot containing the previous token.
    const refreshes = new Map<
      string,
      { promise: Promise<Credential.OAuth>; expires: number }
    >()
    const requests = new WeakMap<Request, Map<string, string>>()

    try {
      await ctx.integration.transform((editor) => {
        editor.method.update({
          integrationID: 'anthropic',
          method: { id: METHOD_ID, type: 'oauth', label: 'Claude Pro/Max' },
          async authorize() {
            const result = await authorize('max')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              mode: 'code',
              async callback(code) {
                const tokens = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                if (tokens.type === 'failed') {
                  throw new Error(
                    'Failed to exchange the Claude Pro/Max authorization code. Paste the full code and try again.',
                  )
                }
                return toCredential({
                  access: tokens.access,
                  refresh: tokens.refresh,
                  expires: tokens.expires,
                })
              },
            }
          },
          async refresh(credential) {
            for (const [key, entry] of refreshes) {
              if (entry.expires <= Date.now()) refreshes.delete(key)
            }
            const existing = refreshes.get(credential.refresh)
            if (existing) return existing.promise
            const entry = {
              promise: refreshToken(credential.refresh, controller.signal).then(
                toCredential,
              ),
              expires: Number.POSITIVE_INFINITY,
            }
            refreshes.set(credential.refresh, entry)
            try {
              const refreshed = await entry.promise
              entry.expires = Date.now() + 30_000
              return refreshed
            } catch (error) {
              refreshes.delete(credential.refresh)
              throw error
            }
          },
        })
      })

      await ctx.catalog.transform((editor) => {
        if (!subscription) return
        const provider = editor.provider.get('anthropic')
        if (!provider) return
        for (const id of provider.models.keys()) {
          editor.model.update('anthropic', id, (model) => {
            model.cost = []
          })
        }
      })

      const updateCosts = async () => {
        const next = !!(await activeOAuth(ctx))
        if (next === subscription || controller.signal.aborted) return
        subscription = next
        await ctx.catalog.reload()
      }
      // A failed/expired login must not prevent registering the login method.
      await updateCosts().catch(() => {})

      await ctx.session.hook(
        'http.request',
        async (event) => {
          const request = event.request
          const url = new URL(request.url)
          if (
            !url.pathname.endsWith('/messages') &&
            !url.pathname.endsWith('/messages/count_tokens')
          )
            return
          if (request.method !== 'POST') return
          const credential = await activeOAuth(ctx)
          if (!credential) return
          // Native v2 auth is already applied. Do not replace a different account
          // or an explicit API-key override selected by the model resolver.
          if (
            request.headers.get('authorization') !==
            `Bearer ${credential.access}`
          )
            return

          version ??= resolveClaudeCodeVersion(
            options,
            ctx.storage,
            controller.signal,
          )
          const resolvedVersion = await version
          const names = new Map<string, string>()
          const body = rewriteRequestBody(
            await request.clone().text(),
            resolvedVersion,
            names,
          )
          const headers = new Headers(request.headers)
          setOAuthHeaders(headers, credential.access, resolvedVersion)
          headers.delete('content-length')
          const rewritten = rewriteUrl(request.url)
          event.request = new Request(rewritten.url?.href ?? request.url, {
            method: request.method,
            headers,
            body,
            signal: request.signal,
          })
          requests.set(event.request, names)
        },
        { providerID: 'anthropic' },
      )

      await ctx.session.hook(
        'http.response',
        (event) => {
          const names = requests.get(event.request)
          if (!names) return
          requests.delete(event.request)
          event.response = createStrippedStream(event.response, names)
        },
        { providerID: 'anthropic' },
      )

      const events = (async () => {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          if (event.type === 'credential.switched') {
            await updateCosts().catch(() => {})
          }
        }
      })().catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error(
            '[henadev.anthropic-auth] Unable to watch credential changes:',
            error,
          )
        }
      })

      return async () => {
        controller.abort()
        refreshes.clear()
        await events
      }
    } catch (error) {
      controller.abort()
      throw error
    }
  },
})
