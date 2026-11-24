import { Clock, Effect } from 'effect'
import {
  SpotifyHttpError,
  SpotifyLive,
  SpotifyTransportError,
  addPlaylistItems,
  createPlaylist,
  getAvailableDevices,
  getCurrentPlayback,
  getCurrentUserPlaylists,
  getCurrentUserProfile,
  getCurrentlyPlaying,
  getPlaylistItems,
  getSavedTracks,
  pausePlayback,
  removePlaylistItems,
  seekToPosition,
  skipToNext,
  startPlayback,
  transferPlayback,
} from '../spotify'
import {
  AuthorizationRequired,
  clearStoredToken,
  hasPlaylistWriteScopes,
  loadStoredToken,
  refreshSpotifyTokenEffect,
  saveStoredToken,
} from './auth'
import type {
  CreatePlaylistBody,
  CurrentUserProfile,
  Device,
  PlaybackState,
  SimplifiedPlaylist,
  SpotifyClient,
  SpotifyError,
  StartPlaybackBody,
  Track,
} from '../spotify'
import type { AuthToken } from './auth'

export interface NormalizedTrack {
  readonly id: string
  readonly uri: string
  readonly name: string
  readonly artists: ReadonlyArray<{ readonly name: string }>
  readonly album: {
    readonly name: string
    readonly images: ReadonlyArray<{ readonly url: string }>
  }
  readonly duration_ms: number
  readonly isrc?: string
  readonly is_local?: boolean
  readonly is_playable?: boolean
  readonly linked_from?: {
    readonly id?: string
    readonly uri?: string
  }
  readonly external_urls?: {
    readonly spotify?: string
  }
}

export interface NormalizedPlaylist {
  readonly id: string
  readonly name: string
  readonly public: boolean | null
  readonly collaborative: boolean
  readonly ownerId: string
  readonly totalItems: number | null
  readonly imageUrl: string | null
  readonly externalUrl: string | null
}

type RateLimitListener = (seconds: number) => void
type ExpiredListener = (reason: string) => void

class SpotifySessionManager {
  private token: AuthToken | null = loadStoredToken()
  private refreshInFlight: Promise<AuthToken> | null = null
  private cooldownUntil = 0
  private generation = 0
  private rateLimitListeners = new Set<RateLimitListener>()
  private expiredListeners = new Set<ExpiredListener>()

  get currentToken(): AuthToken | null {
    if (!this.token) {
      this.token = loadStoredToken()
    }
    return this.token
  }

  get isAuthenticated(): boolean {
    return this.currentToken !== null
  }

  get canModifyPlaylists(): boolean {
    return hasPlaylistWriteScopes(this.currentToken)
  }

  setToken(token: AuthToken): void {
    this.token = token
    saveStoredToken(token)
  }

  disconnect(): void {
    this.generation++
    this.token = null
    this.refreshInFlight = null
    this.cooldownUntil = 0
    clearStoredToken()
  }

  onRateLimit(listener: RateLimitListener): () => void {
    this.rateLimitListeners.add(listener)
    return () => this.rateLimitListeners.delete(listener)
  }

  onExpired(listener: ExpiredListener): () => void {
    this.expiredListeners.add(listener)
    return () => this.expiredListeners.delete(listener)
  }

  private notifyRateLimit(seconds: number): void {
    for (const listener of this.rateLimitListeners) {
      listener(seconds)
    }
  }

  private expireSession(message: string): AuthorizationRequired {
    this.disconnect()
    for (const listener of this.expiredListeners) {
      listener(message)
    }
    return new AuthorizationRequired(message)
  }

  private async ensureFreshToken(force = false): Promise<string> {
    const gen = this.generation
    const current = this.currentToken
    if (!current) {
      throw new AuthorizationRequired('Connect to Spotify to continue.')
    }
    if (!force && Date.now() < current.expiresAt - 30_000) {
      return current.accessToken
    }
    if (this.refreshInFlight) {
      const refreshed = await this.refreshInFlight
      if (gen !== this.generation) {
        throw new AuthorizationRequired('Spotify was disconnected.')
      }
      return refreshed.accessToken
    }

    const promise = Effect.runPromise(refreshSpotifyTokenEffect(current))
      .then((refreshed) => {
        if (gen !== this.generation) {
          throw new AuthorizationRequired('Spotify was disconnected.')
        }
        this.token = refreshed
        return refreshed
      })
      .catch((error: unknown) => {
        if (error instanceof AuthorizationRequired) {
          throw this.expireSession(error.message)
        }
        throw error
      })
      .finally(() => {
        if (this.refreshInFlight === promise) {
          this.refreshInFlight = null
        }
      })

    this.refreshInFlight = promise
    const refreshed = await promise
    return refreshed.accessToken
  }

  private get accessTokenEffect(): Effect.Effect<string, SpotifyError> {
    return Effect.tryPromise({
      try: () => this.ensureFreshToken(false),
      catch: (cause) =>
        cause instanceof AuthorizationRequired
          ? new SpotifyHttpError({
              status: 401,
              message: cause.message,
              body: null,
            })
          : new SpotifyTransportError({ cause }),
    })
  }

  private createLayer() {
    return SpotifyLive({ accessToken: this.accessTokenEffect })
  }

  private waitForCooldown(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      let remaining = this.cooldownUntil - (yield* Clock.currentTimeMillis)
      while (remaining > 0) {
        yield* Effect.sleep(Math.min(remaining, 30_000))
        remaining = this.cooldownUntil - (yield* Clock.currentTimeMillis)
      }
    })
  }

  /**
   * Executes a Spotify API Effect with:
   * - shared rate-limit cooldown + Retry-After backoff
   * - transient network / 5xx retries
   * - single 401 force-refresh retry before expiring the session
   */
  run<TResult>(
    program: Effect.Effect<TResult, SpotifyError, SpotifyClient>,
    options?: {
      readonly signal?: AbortSignal
      readonly maxRetries?: number
    },
  ): Promise<TResult> {
    const maxRetries = options?.maxRetries ?? 3
    const gen = this.generation

    const resilient = Effect.gen({ self: this }, function* () {
      let authRetried = false
      let attempt = 0

      for (;;) {
        if (gen !== this.generation) {
          return yield* Effect.fail(
            new AuthorizationRequired('Spotify was disconnected.'),
          )
        }

        yield* this.waitForCooldown()

        const outcome = yield* program.pipe(
          Effect.provide(this.createLayer()),
          Effect.result,
        )

        if (outcome._tag === 'Success') {
          return outcome.success
        }

        const error = outcome.failure

        if (error instanceof SpotifyHttpError && error.status === 401) {
          if (!authRetried && this.currentToken) {
            authRetried = true
            yield* Effect.tryPromise({
              try: () => this.ensureFreshToken(true),
              catch: (cause) =>
                cause instanceof AuthorizationRequired
                  ? cause
                  : this.expireSession(
                      'Your Spotify session is no longer authorized. Please sign in again.',
                    ),
            })
            continue
          }
          return yield* Effect.fail(
            this.expireSession(
              'Your Spotify session is no longer authorized. Please sign in again.',
            ),
          )
        }

        const isRateLimit =
          error instanceof SpotifyHttpError && error.status === 429
        const isTransientServer =
          error instanceof SpotifyHttpError &&
          (error.status === 502 ||
            error.status === 503 ||
            error.status === 504 ||
            error.status === 500)
        const isTransport = error instanceof SpotifyTransportError

        if (
          (isRateLimit || isTransientServer || isTransport) &&
          attempt < maxRetries
        ) {
          const now = yield* Clock.currentTimeMillis
          const baseDelay = isRateLimit
            ? Math.max((error.retryAfter ?? 2) * 1000, 1000 * 2 ** attempt)
            : 600 * 2 ** attempt
          const jitter = Math.floor(Math.random() * 350)
          const delayMs = baseDelay + jitter

          if (isRateLimit) {
            this.cooldownUntil = Math.max(this.cooldownUntil, now + delayMs)
            this.notifyRateLimit(Math.ceil((this.cooldownUntil - now) / 1000))
          }

          attempt++
          yield* Effect.sleep(delayMs)
          continue
        }

        return yield* Effect.fail(error)
      }
    })

    return Effect.runPromise(resilient.pipe(Effect.withTracerEnabled(false)), {
      signal: options?.signal,
    })
  }
}

export const spotifySession = new SpotifySessionManager()

export function normalizeTrack(
  track: Track | null | undefined,
): NormalizedTrack | null {
  if (!track || track.type !== 'track' || !track.id || !track.uri) return null
  if (track.is_local || track.is_playable === false) return null
  return {
    id: track.id,
    uri: track.uri,
    name: track.name ?? 'Untitled track',
    artists: (track.artists ?? []).map((a) => ({
      name: a.name ?? 'Unknown artist',
    })),
    album: {
      name: track.album?.name ?? '',
      images: (track.album?.images ?? [])
        .filter(
          (img): img is { readonly url: string } => typeof img.url === 'string',
        )
        .map((img) => ({ url: img.url })),
    },
    duration_ms: track.duration_ms ?? 0,
    isrc: track.external_ids?.isrc,
    is_local: track.is_local,
    is_playable: track.is_playable,
    linked_from: track.linked_from
      ? { id: track.linked_from.id, uri: track.linked_from.uri }
      : undefined,
    external_urls: track.external_urls?.spotify
      ? { spotify: track.external_urls.spotify }
      : undefined,
  }
}

export function normalizePlaylist(
  playlist: SimplifiedPlaylist | null | undefined,
): NormalizedPlaylist | null {
  if (!playlist || !playlist.id) return null
  return {
    id: playlist.id,
    name: playlist.name ?? 'Untitled playlist',
    public: playlist.public ?? null,
    collaborative: playlist.collaborative ?? false,
    ownerId: playlist.owner?.id ?? '',
    totalItems: playlist.items?.total ?? playlist.tracks?.total ?? null,
    imageUrl: playlist.images?.[0]?.url ?? null,
    externalUrl: playlist.external_urls?.spotify ?? null,
  }
}

export function formatSpotifyError(error: unknown): string {
  if (error instanceof AuthorizationRequired) {
    return error.message
  }
  if (error instanceof SpotifyHttpError) {
    const detail = error.message || 'Spotify request failed'
    switch (error.status) {
      case 400:
        return `${detail} (400). Spotify could not accept this request.`
      case 401:
        return 'Your Spotify session is no longer authorized. Please sign in again.'
      case 403:
        return `${detail} (403). Check playlist permissions, granted scopes, and Spotify Premium for playback.`
      case 404:
        return `${detail} (404). Open Spotify on a device or check that the playlist still exists.`
      case 429:
        return 'Spotify rate limit reached. Requests are paused briefly—please try again in a moment.'
      default:
        return `${detail} (${error.status}). Please try again.`
    }
  }
  if (error instanceof SpotifyTransportError) {
    return 'Could not reach Spotify. Check your internet connection and try again.'
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Something went wrong. Please try again.'
}

// ============================================================================
// High-level API helpers
// ============================================================================

export function fetchCurrentUserProfile(
  signal?: AbortSignal,
): Promise<CurrentUserProfile> {
  return spotifySession.run(getCurrentUserProfile(), { signal })
}

export async function fetchAllUserPlaylists(
  signal?: AbortSignal,
): Promise<ReadonlyArray<NormalizedPlaylist>> {
  const results: Array<NormalizedPlaylist> = []
  let offset = 0
  const limit = 50

  for (;;) {
    const page = await spotifySession.run(
      getCurrentUserPlaylists({ limit, offset }),
      { signal },
    )
    const items = page.items ?? []
    for (const raw of items) {
      const normalized = normalizePlaylist(raw)
      if (normalized) results.push(normalized)
    }
    if (!page.next || items.length < limit) break
    offset += items.length
  }

  return results
}

export async function fetchSourceTracks(
  sourceId: string,
  options?: {
    readonly signal?: AbortSignal
    readonly onProgress?: (loaded: number, total: number | null) => void
  },
): Promise<ReadonlyArray<NormalizedTrack>> {
  const seen = new Set<string>()
  const tracks: Array<NormalizedTrack> = []
  let offset = 0
  const limit = 50

  for (;;) {
    if (sourceId === 'liked') {
      const page = await spotifySession.run(getSavedTracks({ limit, offset }), {
        signal: options?.signal,
      })
      const items = page.items ?? []
      for (const entry of items) {
        const track = normalizeTrack(entry.track)
        if (track && !seen.has(track.id)) {
          seen.add(track.id)
          tracks.push(track)
        }
      }
      options?.onProgress?.(tracks.length, page.total ?? null)
      if (!page.next || items.length < limit) break
      offset += items.length
    } else {
      const page = await spotifySession.run(
        getPlaylistItems(sourceId, {
          limit,
          offset,
          additionalTypes: ['track'],
        }),
        { signal: options?.signal },
      )
      const items = page.items ?? []
      for (const entry of items) {
        const candidate = entry.item ?? entry.track
        if (candidate && candidate.type === 'track') {
          const track = normalizeTrack(candidate)
          if (track && !seen.has(track.id)) {
            seen.add(track.id)
            tracks.push(track)
          }
        }
      }
      options?.onProgress?.(tracks.length, page.total ?? null)
      if (!page.next || items.length < limit) break
      offset += items.length
    }
  }

  return tracks
}

export function addTrackToTargetPlaylist(
  playlistId: string,
  trackUri: string,
): Promise<{ readonly snapshot_id?: string }> {
  return spotifySession.run(addPlaylistItems(playlistId, { uris: [trackUri] }))
}

export function removeTrackFromTargetPlaylist(
  playlistId: string,
  trackUri: string,
): Promise<{ readonly snapshot_id?: string }> {
  return spotifySession.run(
    removePlaylistItems(playlistId, { items: [{ uri: trackUri }] }),
  )
}

export async function createTargetPlaylist(
  body: CreatePlaylistBody,
): Promise<NormalizedPlaylist> {
  const created = await spotifySession.run(createPlaylist(body))
  return {
    id: created.id ?? '',
    name: created.name ?? body.name,
    public: created.public ?? body.public ?? false,
    collaborative: created.collaborative ?? false,
    ownerId: created.owner?.id ?? '',
    totalItems: created.items?.total ?? created.tracks?.total ?? 0,
    imageUrl: created.images?.[0]?.url ?? null,
    externalUrl: created.external_urls?.spotify ?? null,
  }
}

export function fetchPlaybackState(
  signal?: AbortSignal,
): Promise<PlaybackState | null> {
  return spotifySession.run(
    getCurrentPlayback({ additionalTypes: ['track'] }),
    { signal, maxRetries: 1 },
  )
}

export function fetchCurrentlyPlayingFallback(
  signal?: AbortSignal,
): Promise<PlaybackState | null> {
  return spotifySession.run(
    getCurrentlyPlaying({ additionalTypes: ['track'] }),
    { signal, maxRetries: 1 },
  )
}

export async function fetchDevices(
  signal?: AbortSignal,
): Promise<ReadonlyArray<Device>> {
  const res = await spotifySession.run(getAvailableDevices(), {
    signal,
    maxRetries: 1,
  })
  return res.devices
}

export function transferToDevice(
  deviceId: string,
  play = false,
): Promise<void> {
  return spotifySession.run(transferPlayback({ device_ids: [deviceId], play }))
}

export function playTracksOnSpotify(options?: {
  readonly deviceId?: string
  readonly body?: StartPlaybackBody
}): Promise<void> {
  return spotifySession.run(startPlayback(options), { maxRetries: 1 })
}

export function pauseSpotifyPlayback(deviceId?: string): Promise<void> {
  return spotifySession.run(pausePlayback({ deviceId }), { maxRetries: 1 })
}

export function skipSpotifyNext(deviceId?: string): Promise<void> {
  return spotifySession.run(skipToNext({ deviceId }), { maxRetries: 1 })
}

export function seekSpotifyPlayback(
  positionMs: number,
  deviceId?: string,
): Promise<void> {
  return spotifySession.run(
    seekToPosition(Math.max(0, Math.round(positionMs)), { deviceId }),
    {
      maxRetries: 1,
    },
  )
}
