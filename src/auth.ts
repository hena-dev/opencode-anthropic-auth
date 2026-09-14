import {
  AUTHORIZE_URLS,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_SCOPES,
  TOKEN_URL,
} from './constants.ts'
import { generatePKCE } from './pkce.ts'

type CallbackParams = {
  code: string
  state: string
}

export type AuthorizationResult = {
  url: string
  redirectUri: string
  state: string
  verifier: string
}

function generateState() {
  return crypto.randomUUID().replace(/-/g, '')
}

function parseCallbackInput(input: string) {
  const trimmed = input.trim()

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) {
      return { code, state }
    }
  } catch {
    // Fall through to legacy/manual formats.
  }

  const hashSplits = trimmed.split('#')
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
    return { code: hashSplits[0], state: hashSplits[1] }
  }

  const params = new URLSearchParams(trimmed)
  const code = params.get('code')
  const state = params.get('state')
  if (code && state) {
    return { code, state }
  }

  return null
}

async function exchangeCode(
  callback: CallbackParams,
  verifier: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  const result = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify({
      code: callback.code,
      state: callback.state,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })

  if (!result.ok) {
    return {
      type: 'failed',
    }
  }

  return {
    type: 'success',
    ...parseTokens(await result.json()),
  }
}

export async function authorize(
  mode: 'max' | 'console',
): Promise<AuthorizationResult> {
  const pkce = await generatePKCE()
  const state = generateState()

  const url = new URL(AUTHORIZE_URLS[mode], import.meta.url)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', CODE_CALLBACK_URL)
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  return {
    url: url.toString(),
    redirectUri: CODE_CALLBACK_URL,
    state,
    verifier: pkce.verifier,
  }
}

export type ExchangeResult =
  | { type: 'success'; refresh: string; access: string; expires: number }
  | { type: 'failed' }

export async function exchange(
  input: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<ExchangeResult> {
  const callback = parseCallbackInput(input)
  if (!callback) {
    return {
      type: 'failed',
    }
  }

  if (expectedState && callback.state !== expectedState) {
    return {
      type: 'failed',
    }
  }

  return exchangeCode(callback, verifier, redirectUri)
}

/** The v2 integration host persists the returned token rotation. */
export async function refreshToken(refresh: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted()
        const abort = () => {
          clearTimeout(timer)
          reject(signal?.reason)
        }
        const timer = setTimeout(
          () => {
            signal?.removeEventListener('abort', abort)
            resolve()
          },
          500 * 2 ** (attempt - 1),
        )
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.any([
        AbortSignal.timeout(15_000),
        ...(signal ? [signal] : []),
      ]),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'axios/1.13.6',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: CLIENT_ID,
      }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status >= 500 && attempt < 2) continue
      throw new Error(`Anthropic token refresh failed: ${response.status}`)
    }
    return parseTokens(await response.json())
  }
  throw new Error('Anthropic token refresh exhausted retries')
}

function parseTokens(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    !('access_token' in value) ||
    typeof value.access_token !== 'string' ||
    !value.access_token ||
    !('refresh_token' in value) ||
    typeof value.refresh_token !== 'string' ||
    !value.refresh_token ||
    !('expires_in' in value) ||
    typeof value.expires_in !== 'number' ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  )
    throw new Error('Invalid Anthropic OAuth token response')
  return {
    access: value.access_token,
    refresh: value.refresh_token,
    expires: Date.now() + Math.floor(value.expires_in * 1000),
  }
}
