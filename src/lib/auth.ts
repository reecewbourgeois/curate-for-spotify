import { Clock, Effect, Schema } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'

const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize'

const CLIENT_ID_KEY = 'curate:clientId'
const TOKEN_KEY = 'curate:session:v1'
const PKCE_KEY = 'curate:pkce:v1'

export const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
] as const

export const PLAYLIST_WRITE_SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
] as const

export interface AuthToken {
  readonly clientId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly scope: string
}

interface PendingPkce {
  readonly clientId: string
  readonly verifier: string
  readonly state: string
  readonly redirect: string
  readonly at: number
  readonly scopes: string
}

export class AuthorizationRequired extends Error {
  constructor(
    message = 'Your Spotify session has expired. Please sign in again.',
  ) {
    super(message)
    this.name = 'AuthorizationRequired'
  }
}

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optionalKey(Schema.NonEmptyString),
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  scope: Schema.optionalKey(Schema.String),
})

const TokenErrorSchema = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
})

function randomHex(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('')
}

function baseUrlPath(): string {
  const base = import.meta.env.BASE_URL || '/'
  return base.endsWith('/') ? base : `${base}/`
}

export function getSetupRedirectUri(): string {
  const configured = (
    import.meta.env.VITE_SPOTIFY_REDIRECT_URI as string | undefined
  )?.trim()
  if (configured) return configured
  const host =
    location.hostname === 'localhost'
      ? `127.0.0.1${location.port ? `:${location.port}` : ''}`
      : location.host
  return `${location.protocol}//${host}${baseUrlPath()}`
}

export function getValidatedRedirectUri(): string {
  const raw = getSetupRedirectUri()
  let uri: URL
  try {
    uri = new URL(raw)
  } catch {
    throw new Error(
      'Invalid redirect URI. Configure an HTTPS URL or http://127.0.0.1:3000/.',
    )
  }
  const isAllowedProtocol =
    uri.protocol === 'https:' ||
    (uri.protocol === 'http:' && uri.hostname === '127.0.0.1')
  if (
    uri.username ||
    uri.password ||
    uri.hash ||
    uri.search ||
    !isAllowedProtocol ||
    uri.href.includes('*')
  ) {
    throw new Error(
      'Use an HTTPS redirect URI, or http://127.0.0.1:3000/ for local development. Wildcards, query strings, and fragments are not supported.',
    )
  }
  if (uri.origin !== location.origin) {
    throw new Error(
      `Open the app at ${uri.href} before connecting to Spotify. The redirect URI origin must match this page.`,
    )
  }
  return uri.href
}

export function getSavedClientId(): string {
  try {
    const saved = localStorage.getItem(CLIENT_ID_KEY)
    if (saved) return saved
  } catch {
    // Fall back to sessionStorage or env.
  }
  try {
    const saved = sessionStorage.getItem(CLIENT_ID_KEY)
    if (saved) return saved
  } catch {
    // Fall back to env.
  }
  return (
    (import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined)?.trim() || ''
  )
}

export function saveClientId(clientId: string): void {
  try {
    sessionStorage.setItem(CLIENT_ID_KEY, clientId)
  } catch {
    // Ignore storage restriction.
  }
  try {
    localStorage.setItem(CLIENT_ID_KEY, clientId)
  } catch {
    // Ignore storage restriction.
  }
}

export function loadStoredToken(): AuthToken | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as Partial<AuthToken>
    if (
      typeof candidate.clientId !== 'string' ||
      typeof candidate.accessToken !== 'string' ||
      typeof candidate.refreshToken !== 'string' ||
      typeof candidate.expiresAt !== 'number' ||
      typeof candidate.scope !== 'string'
    ) {
      return null
    }
    return candidate as AuthToken
  } catch {
    return null
  }
}

export function saveStoredToken(token: AuthToken): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  } catch {
    // If sessionStorage is unavailable, token still lives in runtime memory.
  }
}

export function clearStoredToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(PKCE_KEY)
  } catch {
    // Ignore.
  }
}

export function hasPlaylistWriteScopes(token: AuthToken | null): boolean {
  if (!token) return false
  const granted = new Set(token.scope.split(/\s+/).filter(Boolean))
  return PLAYLIST_WRITE_SCOPES.every((scope) => granted.has(scope))
}

export function hasPendingCallback(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has('code') || params.has('error')
}

export async function startSpotifyAuth(
  clientId: string,
  options?: { readonly showDialog?: boolean },
): Promise<void> {
  const trimmed = clientId.trim()
  if (!/^[a-zA-Z0-9]{32}$/.test(trimmed)) {
    throw new Error(
      'Enter the 32-character Client ID from your Spotify developer app. Do not enter a Client Secret.',
    )
  }
  const redirect = getValidatedRedirectUri()
  const verifier = randomHex(32)
  const state = randomHex(24)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  const scopeString = SPOTIFY_SCOPES.join(' ')
  saveClientId(trimmed)

  const pending: PendingPkce = {
    clientId: trimmed,
    verifier,
    state,
    redirect,
    at: Date.now(),
    scopes: scopeString,
  }
  sessionStorage.setItem(PKCE_KEY, JSON.stringify(pending))

  const url = new URL(AUTHORIZE_URL)
  const params = new URLSearchParams({
    client_id: trimmed,
    response_type: 'code',
    redirect_uri: redirect,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: scopeString,
  })
  if (options?.showDialog) {
    params.set('show_dialog', 'true')
  }
  url.search = params.toString()
  location.assign(url.href)
}

function executeTokenExchange(
  body: URLSearchParams,
): Effect.Effect<typeof TokenResponseSchema.Type, Error> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const req = HttpClientRequest.post(TOKEN_URL).pipe(
      HttpClientRequest.bodyUrlParams(body),
    )
    const response = yield* client
      .execute(req)
      .pipe(
        Effect.mapError(
          () =>
            new Error(
              'Could not reach Spotify to complete sign-in. Check your connection and try again.',
            ),
        ),
      )

    if (response.status >= 200 && response.status < 300) {
      const json = yield* response.json.pipe(
        Effect.mapError(
          () => new Error('Spotify returned an unreadable token response.'),
        ),
      )
      return yield* Schema.decodeUnknownEffect(TokenResponseSchema)(json).pipe(
        Effect.mapError(
          () => new Error('Spotify returned an unexpected token format.'),
        ),
      )
    }

    const errJson = yield* response.json.pipe(Effect.orElseSucceed(() => null))
    const decodedErr = yield* Schema.decodeUnknownEffect(TokenErrorSchema)(
      errJson,
    ).pipe(Effect.orElseSucceed((): typeof TokenErrorSchema.Type => ({})))

    if (decodedErr.error === 'invalid_grant') {
      return yield* Effect.fail(
        new AuthorizationRequired(
          'Your Spotify session has expired or was revoked. Sign in again to continue; your local progress is safe.',
        ),
      )
    }
    return yield* Effect.fail(
      new Error(
        decodedErr.error_description ||
          decodedErr.error ||
          `Spotify authorization failed (${response.status}).`,
      ),
    )
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, {
      cache: 'no-store',
      redirect: 'error',
    }),
    Effect.withTracerEnabled(false),
  )
}

export async function completeSpotifyAuth(search: string): Promise<AuthToken> {
  const params = new URLSearchParams(search)
  const rawPending = sessionStorage.getItem(PKCE_KEY)
  sessionStorage.removeItem(PKCE_KEY)

  const code = params.get('code')
  const error = params.get('error')
  const returnedState = params.get('state')

  if (error) {
    throw new Error(
      `Spotify authorization was not completed (${error}). You can connect again whenever you’re ready.`,
    )
  }

  let pending: PendingPkce | null = null
  try {
    pending = rawPending ? (JSON.parse(rawPending) as PendingPkce) : null
  } catch {
    pending = null
  }

  if (
    !pending ||
    !code ||
    pending.state !== returnedState ||
    Date.now() - pending.at > 10 * 60_000
  ) {
    throw new Error(
      'Authorization could not be verified or has expired. Please sign in again.',
    )
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirect,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  })

  const token = await Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* executeTokenExchange(body)
      if (!response.refresh_token) {
        return yield* Effect.fail(
          new Error(
            'Spotify did not return a refresh token. Please sign in again.',
          ),
        )
      }
      const now = yield* Clock.currentTimeMillis
      const next: AuthToken = {
        clientId: pending.clientId,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        expiresAt: now + response.expires_in * 1000,
        scope: response.scope ?? pending.scopes,
      }
      return next
    }),
  )

  saveStoredToken(token)
  return token
}

export function refreshSpotifyTokenEffect(
  token: AuthToken,
): Effect.Effect<AuthToken, Error> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: token.clientId,
  })
  return Effect.gen(function* () {
    const response = yield* executeTokenExchange(body)
    const now = yield* Clock.currentTimeMillis
    const refreshed: AuthToken = {
      clientId: token.clientId,
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? token.refreshToken,
      expiresAt: now + response.expires_in * 1000,
      scope: response.scope ?? token.scope,
    }
    saveStoredToken(refreshed)
    return refreshed
  })
}
