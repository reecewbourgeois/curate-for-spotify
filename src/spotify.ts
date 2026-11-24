/**
 * Spotify Web API toolkit for Effect v4.
 *
 * Built against the OpenAPI spec at
 * https://developer.spotify.com/reference/web-api/open-api-schema.yaml
 * (Web API reference, retrieved 2025-11).
 *
 * Every endpoint in the spec is exposed as a callable function. Each function
 * is an `Effect` that requires the `SpotifyClient` service and fails with a
 * `SpotifyError`:
 *
 *   - `SpotifyTransportError` — the request could not be sent
 *   - `SpotifyHttpError` — Spotify returned a 4xx/5xx status
 *   - `SpotifyDecodeError` — the response body did not match the expected schema
 *
 * Usage:
 *
 *   const program = Effect.gen(function* () {
 *     const artist = yield* getArtist("0TnOYIS61jLjp3ghjGm6Tz")
 *     const albums = yield* getArtistAlbums(artist.id ?? "")
 *     return albums
 *   })
 *
 *   await Effect.runPromise(
 *     program.pipe(Effect.provide(SpotifyLive({ accessToken: "..." }))),
 *   )
 *
 * Tokens may be static strings or an Effect (for OAuth refresh):
 *
 *   SpotifyLive({ accessToken: refreshAccessToken })
 *
 * Responses are decoded at runtime with Effect Schema into readonly types, so
 * the functions return exactly what Spotify sends — optional fields stay
 * optional. Consult the Spotify docs for field-by-field semantics.
 */

import { Context, Data, Effect, Layer, Schema } from 'effect'
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
} from 'effect/http'
import type { HttpClientResponse, UrlParams } from 'effect/http'

// ============================================================================
// Configuration
// ============================================================================

/**
 * Either a static access token, or an `Effect` that produces one. Pass an
 * Effect to support OAuth token refresh without rebuilding the layer — it is
 * re-evaluated on every request, so it can fetch (and cache) fresh tokens.
 */
export type SpotifyAccessToken = string | Effect.Effect<string, SpotifyError>

export interface SpotifyConfigOptions {
  readonly accessToken: SpotifyAccessToken
  readonly baseUrl?: string
}

export interface SpotifyConfigShape {
  readonly baseUrl: string
  readonly accessToken: SpotifyAccessToken
}

/** Service holding the base URL and access token used for every request. */
export class SpotifyConfig extends Context.Service<
  SpotifyConfig,
  SpotifyConfigShape
>()('SpotifyConfig') {}

export const SpotifyConfigLive = (
  options: SpotifyConfigOptions,
): Layer.Layer<SpotifyConfig> =>
  Layer.succeed(SpotifyConfig, {
    baseUrl: options.baseUrl ?? 'https://api.spotify.com/v1',
    accessToken: options.accessToken,
  })

// ============================================================================
// Errors
// ============================================================================

/** The request could not be sent (network failure, DNS, abort, …). */
export class SpotifyTransportError extends Data.TaggedError(
  'SpotifyTransportError',
)<{
  readonly cause: unknown
}> {}

/**
 * Spotify responded with a 4xx/5xx status.
 *
 * For rate limits (429), `retryAfter` holds the value of the `Retry-After`
 * response header in seconds — use it with an Effect `Schedule` to back off.
 */
export class SpotifyHttpError extends Data.TaggedError('SpotifyHttpError')<{
  readonly status: number
  readonly message: string
  readonly body: unknown
  readonly retryAfter?: number | undefined
}> {}

/** The response body could not be parsed or did not match the expected schema. */
export class SpotifyDecodeError extends Data.TaggedError('SpotifyDecodeError')<{
  readonly message: string
  readonly body: unknown
  readonly cause: unknown
}> {}

export type SpotifyError =
  | SpotifyTransportError
  | SpotifyHttpError
  | SpotifyDecodeError

// ============================================================================
// HTTP plumbing
// ============================================================================

export interface RequestOptions {
  readonly urlParams?: UrlParams.Input | undefined
  readonly body?: HttpBody.HttpBody | undefined
}

export interface SpotifyClientShape {
  readonly request: (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options?: RequestOptions | undefined,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, SpotifyError>
}

/** Service that performs authenticated requests against the Spotify Web API. */
export class SpotifyClient extends Context.Service<
  SpotifyClient,
  SpotifyClientShape
>()('SpotifyClient') {}

export const SpotifyClientLive: Layer.Layer<
  SpotifyClient,
  never,
  SpotifyConfig | HttpClient.HttpClient
> = Layer.effect(
  SpotifyClient,
  Effect.gen(function* () {
    const config = yield* SpotifyConfig
    const client = yield* HttpClient.HttpClient
    const token =
      typeof config.accessToken === 'string'
        ? Effect.succeed(config.accessToken)
        : config.accessToken
    const request = (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      options?: RequestOptions,
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, SpotifyError> =>
      Effect.flatMap(token, (accessToken) =>
        client
          .execute(
            HttpClientRequest.make(method)(`${config.baseUrl}${path}`, {
              urlParams: options?.urlParams,
              headers: { authorization: `Bearer ${accessToken}` },
              body: options?.body,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause): SpotifyError => new SpotifyTransportError({ cause }),
            ),
          ),
      )
    return { request }
  }),
)

/** Ready-to-use layer wired to the Web API. Provide it with `Effect.provide`. */
export const SpotifyLive = (
  options: SpotifyConfigOptions,
): Layer.Layer<SpotifyClient> =>
  Layer.provide(
    Layer.provide(SpotifyClientLive, SpotifyConfigLive(options)),
    FetchHttpClient.layer,
  )

const request = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options?: RequestOptions,
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  SpotifyError,
  SpotifyClient
> =>
  Effect.flatMap(SpotifyClient, (client) =>
    client.request(method, path, options),
  )

const errorMessage = (body: unknown): string => {
  const error = (body as { error?: { message?: unknown } } | undefined)?.error
  return typeof error?.message === 'string'
    ? error.message
    : 'Spotify API error'
}

const ensureOk = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<HttpClientResponse.HttpClientResponse, SpotifyError> => {
  if (response.status < 400) return Effect.succeed(response)
  // Absent keys are `undefined` at runtime even though Headers' index type
  // says `string`, so widen the type to allow the check.
  const retryAfterHeader = response.headers['retry-after'] as string | undefined
  const retryAfter =
    retryAfterHeader === undefined
      ? undefined
      : Number.isNaN(Number(retryAfterHeader))
        ? undefined
        : Number(retryAfterHeader)
  return response.json.pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.flatMap((body) =>
      Effect.fail(
        new SpotifyHttpError({
          status: response.status,
          message: errorMessage(body),
          body,
          retryAfter,
        }),
      ),
    ),
  )
}

const decodeJson = <T>(
  schema: Schema.Codec<T, unknown, never>,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<T, SpotifyError> =>
  response.json.pipe(
    Effect.mapError(
      (cause): SpotifyError =>
        new SpotifyDecodeError({
          message: 'Failed to read response body',
          body: null,
          cause,
        }),
    ),
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          (cause): SpotifyError =>
            new SpotifyDecodeError({
              message: 'Response failed schema validation',
              body: json,
              cause,
            }),
        ),
      ),
    ),
  )

const getJson = <T>(
  path: string,
  schema: Schema.Codec<T, unknown, never>,
  urlParams?: UrlParams.Input,
): Effect.Effect<T, SpotifyError, SpotifyClient> =>
  request('GET', path, { urlParams }).pipe(
    Effect.flatMap(ensureOk),
    Effect.flatMap((response) => decodeJson(schema, response)),
  )

/** For endpoints that return 204 (no content) when there is nothing to report. */
const getJsonOrNull = <T>(
  path: string,
  schema: Schema.Codec<T, unknown, never>,
  urlParams?: UrlParams.Input,
): Effect.Effect<T | null, SpotifyError, SpotifyClient> =>
  request('GET', path, { urlParams }).pipe(
    Effect.flatMap(ensureOk),
    Effect.flatMap((response) =>
      response.status === 204
        ? Effect.succeed(null)
        : decodeJson(schema, response),
    ),
  )

const send = (
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  options?: RequestOptions,
): Effect.Effect<void, SpotifyError, SpotifyClient> =>
  request(method, path, options).pipe(Effect.flatMap(ensureOk), Effect.asVoid)

/** POST/PUT/DELETE with a JSON body, returning the decoded JSON response. */
const sendJson = <T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  schema: Schema.Codec<T, unknown, never>,
  json: unknown,
  urlParams?: UrlParams.Input,
): Effect.Effect<T, SpotifyError, SpotifyClient> =>
  request(method, path, { urlParams, body: HttpBody.jsonUnsafe(json) }).pipe(
    Effect.flatMap(ensureOk),
    Effect.flatMap((response) => decodeJson(schema, response)),
  )

const csv = (ids: ReadonlyArray<string>): string => ids.join(',')

/** Encodes a path segment so ids with special characters can't break the URL. */
const enc = encodeURIComponent

const Snapshot = Schema.Struct({
  snapshot_id: Schema.optional(Schema.String),
})

// ============================================================================
// Shared schemas
// ============================================================================

const ExternalUrls = Schema.Struct({
  spotify: Schema.optional(Schema.String),
})

const Image = Schema.Struct({
  url: Schema.optional(Schema.String),
  height: Schema.optional(Schema.NullOr(Schema.Number)),
  width: Schema.optional(Schema.NullOr(Schema.Number)),
})

const Followers = Schema.Struct({
  href: Schema.optional(Schema.NullOr(Schema.String)),
  total: Schema.optional(Schema.NullOr(Schema.Number)),
})

const ResumePoint = Schema.Struct({
  fully_played: Schema.optional(Schema.Boolean),
  resume_position_ms: Schema.optional(Schema.NullOr(Schema.Number)),
})

const Copyright = Schema.Struct({
  text: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
})

const AlbumRestriction = Schema.Struct({
  reason: Schema.optional(Schema.String),
})

const TrackLink = Schema.Struct({
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})

const ExternalIds = Schema.Struct({
  isrc: Schema.optional(Schema.String),
  ean: Schema.optional(Schema.String),
  upc: Schema.optional(Schema.String),
})

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export interface Paging<TItem> {
  readonly href?: string | undefined
  readonly items?: ReadonlyArray<TItem> | undefined
  readonly limit?: number | undefined
  readonly next?: string | null | undefined
  readonly offset?: number | undefined
  readonly previous?: string | null | undefined
  readonly total?: number | undefined
}

export interface CursorPaging<TItem> {
  readonly cursors?:
    | { readonly after?: string | null; readonly before?: string | null }
    | undefined
  readonly href?: string | undefined
  readonly items?: ReadonlyArray<TItem> | undefined
  readonly limit?: number | undefined
  readonly next?: string | null | undefined
  readonly total?: number | undefined
}

const paging = <TItem>(
  item: Schema.Codec<TItem, unknown, never>,
): Schema.Codec<Paging<TItem>> =>
  Schema.Struct({
    href: Schema.optional(Schema.String),
    items: Schema.optional(Schema.Array(item)),
    limit: Schema.optional(Schema.Number),
    next: Schema.optional(Schema.NullOr(Schema.String)),
    offset: Schema.optional(Schema.Number),
    previous: Schema.optional(Schema.NullOr(Schema.String)),
    total: Schema.optional(Schema.Number),
  }) as unknown as Schema.Codec<Paging<TItem>>

const cursorPaging = <TItem>(
  item: Schema.Codec<TItem, unknown, never>,
): Schema.Codec<CursorPaging<TItem>> =>
  Schema.Struct({
    cursors: Schema.optional(
      Schema.Struct({
        after: Schema.optional(Schema.NullOr(Schema.String)),
        before: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
    href: Schema.optional(Schema.String),
    items: Schema.optional(Schema.Array(item)),
    limit: Schema.optional(Schema.Number),
    next: Schema.optional(Schema.NullOr(Schema.String)),
    total: Schema.optional(Schema.Number),
  }) as unknown as Schema.Codec<CursorPaging<TItem>>

// ---------------------------------------------------------------------------
// Catalog objects
// ---------------------------------------------------------------------------

export const Artist = Schema.Struct({
  external_urls: Schema.optional(ExternalUrls),
  followers: Schema.optional(Followers),
  genres: Schema.optional(Schema.Array(Schema.String)),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  name: Schema.optional(Schema.String),
  popularity: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type Artist = typeof Artist.Type

export const SimplifiedTrack = Schema.Struct({
  artists: Schema.optional(Schema.Array(Artist)),
  available_markets: Schema.optional(Schema.Array(Schema.String)),
  disc_number: Schema.optional(Schema.Number),
  duration_ms: Schema.optional(Schema.Number),
  explicit: Schema.optional(Schema.Boolean),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  is_local: Schema.optional(Schema.Boolean),
  is_playable: Schema.optional(Schema.Boolean),
  linked_from: Schema.optional(TrackLink),
  restrictions: Schema.optional(AlbumRestriction),
  name: Schema.optional(Schema.String),
  preview_url: Schema.optional(Schema.NullOr(Schema.String)),
  track_number: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type SimplifiedTrack = typeof SimplifiedTrack.Type

export const SimplifiedAlbum = Schema.Struct({
  album_group: Schema.optional(Schema.String),
  album_type: Schema.optional(Schema.String),
  artists: Schema.optional(Schema.Array(Artist)),
  available_markets: Schema.optional(Schema.Array(Schema.String)),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  name: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  release_date_precision: Schema.optional(Schema.String),
  restrictions: Schema.optional(AlbumRestriction),
  total_tracks: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type SimplifiedAlbum = typeof SimplifiedAlbum.Type

export const Track = Schema.Struct({
  album: Schema.optional(SimplifiedAlbum),
  artists: Schema.optional(Schema.Array(Artist)),
  available_markets: Schema.optional(Schema.Array(Schema.String)),
  disc_number: Schema.optional(Schema.Number),
  duration_ms: Schema.optional(Schema.Number),
  explicit: Schema.optional(Schema.Boolean),
  external_ids: Schema.optional(ExternalIds),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  is_local: Schema.optional(Schema.Boolean),
  is_playable: Schema.optional(Schema.Boolean),
  linked_from: Schema.optional(TrackLink),
  restrictions: Schema.optional(AlbumRestriction),
  name: Schema.optional(Schema.String),
  popularity: Schema.optional(Schema.Number),
  preview_url: Schema.optional(Schema.NullOr(Schema.String)),
  track_number: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type Track = typeof Track.Type

export const Album = Schema.Struct({
  album_type: Schema.optional(Schema.String),
  artists: Schema.optional(Schema.Array(Artist)),
  available_markets: Schema.optional(Schema.Array(Schema.String)),
  copyrights: Schema.optional(Schema.Array(Copyright)),
  external_ids: Schema.optional(
    Schema.Struct({ upc: Schema.optional(Schema.String) }),
  ),
  external_urls: Schema.optional(ExternalUrls),
  genres: Schema.optional(Schema.Array(Schema.String)),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  label: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  popularity: Schema.optional(Schema.Number),
  release_date: Schema.optional(Schema.String),
  release_date_precision: Schema.optional(Schema.String),
  restrictions: Schema.optional(AlbumRestriction),
  total_tracks: Schema.optional(Schema.Number),
  tracks: Schema.optional(paging(SimplifiedTrack)),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type Album = typeof Album.Type

export const SimplifiedShow = Schema.Struct({
  available_markets: Schema.optional(Schema.Array(Schema.String)),
  copyrights: Schema.optional(Schema.Array(Copyright)),
  description: Schema.optional(Schema.String),
  html_description: Schema.optional(Schema.String),
  explicit: Schema.optional(Schema.Boolean),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  is_externally_hosted: Schema.optional(Schema.Boolean),
  media_type: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  publisher: Schema.optional(Schema.String),
  total_episodes: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type SimplifiedShow = typeof SimplifiedShow.Type

export const SimplifiedEpisode = Schema.Struct({
  audio_preview_url: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.String),
  html_description: Schema.optional(Schema.String),
  duration_ms: Schema.optional(Schema.Number),
  explicit: Schema.optional(Schema.Boolean),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  is_externally_hosted: Schema.optional(Schema.Boolean),
  is_playable: Schema.optional(Schema.Boolean),
  language: Schema.optional(Schema.String),
  languages: Schema.optional(Schema.Array(Schema.String)),
  name: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  release_date_precision: Schema.optional(Schema.String),
  resume_point: Schema.optional(ResumePoint),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type SimplifiedEpisode = typeof SimplifiedEpisode.Type

export const Show = Schema.Struct({
  available_markets: Schema.optional(Schema.Array(Schema.String)),
  copyrights: Schema.optional(Schema.Array(Copyright)),
  description: Schema.optional(Schema.String),
  html_description: Schema.optional(Schema.String),
  episodes: Schema.optional(paging(SimplifiedEpisode)),
  explicit: Schema.optional(Schema.Boolean),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  is_externally_hosted: Schema.optional(Schema.Boolean),
  media_type: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  publisher: Schema.optional(Schema.String),
  total_episodes: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type Show = typeof Show.Type

export const Episode = Schema.Struct({
  audio_preview_url: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.String),
  html_description: Schema.optional(Schema.String),
  duration_ms: Schema.optional(Schema.Number),
  explicit: Schema.optional(Schema.Boolean),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  is_externally_hosted: Schema.optional(Schema.Boolean),
  is_playable: Schema.optional(Schema.Boolean),
  language: Schema.optional(Schema.String),
  languages: Schema.optional(Schema.Array(Schema.String)),
  name: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  release_date_precision: Schema.optional(Schema.String),
  resume_point: Schema.optional(ResumePoint),
  show: Schema.optional(SimplifiedShow),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type Episode = typeof Episode.Type

export const SimplifiedAudiobook = Schema.Struct({
  authors: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) })),
  ),
  available_markets: Schema.optional(Schema.Array(Schema.String)),
  copyrights: Schema.optional(Schema.Array(Copyright)),
  description: Schema.optional(Schema.String),
  html_description: Schema.optional(Schema.String),
  edition: Schema.optional(Schema.String),
  explicit: Schema.optional(Schema.Boolean),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  media_type: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  narrators: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) })),
  ),
  publisher: Schema.optional(Schema.String),
  total_chapters: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type SimplifiedAudiobook = typeof SimplifiedAudiobook.Type

export const SimplifiedChapter = Schema.Struct({
  audiobook: Schema.optional(SimplifiedAudiobook),
  available_markets: Schema.optional(Schema.Array(Schema.String)),
  book_number: Schema.optional(Schema.Number),
  chapter_number: Schema.optional(Schema.Number),
  description: Schema.optional(Schema.String),
  html_description: Schema.optional(Schema.String),
  duration_ms: Schema.optional(Schema.Number),
  explicit: Schema.optional(Schema.Boolean),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  is_playable: Schema.optional(Schema.Boolean),
  language: Schema.optional(Schema.String),
  languages: Schema.optional(Schema.Array(Schema.String)),
  name: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  release_date_precision: Schema.optional(Schema.String),
  resume_point: Schema.optional(ResumePoint),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type SimplifiedChapter = typeof SimplifiedChapter.Type

export const Audiobook = Schema.Struct({
  authors: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) })),
  ),
  available_markets: Schema.optional(Schema.Array(Schema.String)),
  copyrights: Schema.optional(Schema.Array(Copyright)),
  description: Schema.optional(Schema.String),
  html_description: Schema.optional(Schema.String),
  chapters: Schema.optional(paging(SimplifiedChapter)),
  edition: Schema.optional(Schema.String),
  explicit: Schema.optional(Schema.Boolean),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  media_type: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  narrators: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) })),
  ),
  publisher: Schema.optional(Schema.String),
  total_chapters: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type Audiobook = typeof Audiobook.Type

export const Chapter = Schema.Struct({
  audiobook: Schema.optional(SimplifiedAudiobook),
  available_markets: Schema.optional(Schema.Array(Schema.String)),
  book_number: Schema.optional(Schema.Number),
  chapter_number: Schema.optional(Schema.Number),
  description: Schema.optional(Schema.String),
  html_description: Schema.optional(Schema.String),
  duration_ms: Schema.optional(Schema.Number),
  explicit: Schema.optional(Schema.Boolean),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  is_playable: Schema.optional(Schema.Boolean),
  language: Schema.optional(Schema.String),
  languages: Schema.optional(Schema.Array(Schema.String)),
  name: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  release_date_precision: Schema.optional(Schema.String),
  resume_point: Schema.optional(ResumePoint),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type Chapter = typeof Chapter.Type

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

const PlaylistUser = Schema.Struct({
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})

/**
 * An entry in a playlist. The playlist item fields were renamed in February
 * 2026 (`track` → `item`); both are decoded so either shape surfaces.
 */
export const PlaylistTrack = Schema.Struct({
  added_at: Schema.optional(Schema.NullOr(Schema.String)),
  added_by: Schema.optional(Schema.NullOr(PlaylistUser)),
  is_local: Schema.optional(Schema.Boolean),
  item: Schema.optional(Schema.Union([Track, Episode, Schema.Null])),
  track: Schema.optional(Schema.Union([Track, Episode, Schema.Null])),
})
export type PlaylistTrack = typeof PlaylistTrack.Type

const PlaylistItemsRef = Schema.Struct({
  href: Schema.optional(Schema.String),
  total: Schema.optional(Schema.Number),
})

export const SimplifiedPlaylist = Schema.Struct({
  collaborative: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  external_urls: Schema.optional(ExternalUrls),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.NullOr(Schema.Array(Image))),
  name: Schema.optional(Schema.String),
  owner: Schema.optional(PlaylistUser),
  public: Schema.optional(Schema.NullOr(Schema.Boolean)),
  snapshot_id: Schema.optional(Schema.String),
  // `items` is the current field; `tracks` is its deprecated pre-2026 name.
  items: Schema.optional(PlaylistItemsRef),
  tracks: Schema.optional(PlaylistItemsRef),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type SimplifiedPlaylist = typeof SimplifiedPlaylist.Type

export const Playlist = Schema.Struct({
  collaborative: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  external_urls: Schema.optional(ExternalUrls),
  followers: Schema.optional(Followers),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.NullOr(Schema.Array(Image))),
  name: Schema.optional(Schema.String),
  owner: Schema.optional(PlaylistUser),
  public: Schema.optional(Schema.NullOr(Schema.Boolean)),
  snapshot_id: Schema.optional(Schema.String),
  // `items` is the current field; `tracks` is its deprecated pre-2026 name.
  items: Schema.optional(paging(PlaylistTrack)),
  tracks: Schema.optional(paging(PlaylistTrack)),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type Playlist = typeof Playlist.Type

// ---------------------------------------------------------------------------
// Users, library, follows
// ---------------------------------------------------------------------------

const ExplicitContent = Schema.Struct({
  filter_enabled: Schema.optional(Schema.Boolean),
  filter_locked: Schema.optional(Schema.Boolean),
})

export const CurrentUserProfile = Schema.Struct({
  // Public, immutable, pseudoanonymous identifier — preferred over `id` for
  // account linking (added May 2026).
  account_id: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.String),
  explicit_content: Schema.optional(ExplicitContent),
  external_urls: Schema.optional(ExternalUrls),
  followers: Schema.optional(Followers),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  product: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type CurrentUserProfile = typeof CurrentUserProfile.Type

export const PublicUser = Schema.Struct({
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  external_urls: Schema.optional(ExternalUrls),
  followers: Schema.optional(Followers),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(Image)),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
})
export type PublicUser = typeof PublicUser.Type

export const SavedAlbum = Schema.Struct({
  added_at: Schema.optional(Schema.String),
  album: Schema.optional(Album),
})
export type SavedAlbum = typeof SavedAlbum.Type

export const SavedTrack = Schema.Struct({
  added_at: Schema.optional(Schema.String),
  track: Schema.optional(Track),
})
export type SavedTrack = typeof SavedTrack.Type

export const SavedEpisode = Schema.Struct({
  added_at: Schema.optional(Schema.String),
  episode: Schema.optional(Episode),
})
export type SavedEpisode = typeof SavedEpisode.Type

export const SavedShow = Schema.Struct({
  added_at: Schema.optional(Schema.String),
  show: Schema.optional(Show),
})
export type SavedShow = typeof SavedShow.Type

export const Category = Schema.Struct({
  href: Schema.optional(Schema.String),
  icons: Schema.optional(Schema.Array(Image)),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
})
export type Category = typeof Category.Type

// ---------------------------------------------------------------------------
// Audio features & analysis
// ---------------------------------------------------------------------------

export const AudioFeatures = Schema.Struct({
  acousticness: Schema.optional(Schema.Number),
  analysis_url: Schema.optional(Schema.String),
  danceability: Schema.optional(Schema.Number),
  duration_ms: Schema.optional(Schema.Number),
  energy: Schema.optional(Schema.Number),
  id: Schema.optional(Schema.String),
  instrumentalness: Schema.optional(Schema.Number),
  key: Schema.optional(Schema.Number),
  liveness: Schema.optional(Schema.Number),
  loudness: Schema.optional(Schema.Number),
  mode: Schema.optional(Schema.Number),
  speechiness: Schema.optional(Schema.Number),
  tempo: Schema.optional(Schema.Number),
  time_signature: Schema.optional(Schema.Number),
  track_href: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  valence: Schema.optional(Schema.Number),
})
export type AudioFeatures = typeof AudioFeatures.Type

const TimeInterval = Schema.Struct({
  start: Schema.optional(Schema.Number),
  duration: Schema.optional(Schema.Number),
  confidence: Schema.optional(Schema.Number),
})

const Section = Schema.Struct({
  ...TimeInterval.fields,
  loudness: Schema.optional(Schema.Number),
  tempo: Schema.optional(Schema.Number),
  tempo_confidence: Schema.optional(Schema.Number),
  key: Schema.optional(Schema.Number),
  key_confidence: Schema.optional(Schema.Number),
  mode: Schema.optional(Schema.Number),
  mode_confidence: Schema.optional(Schema.Number),
  time_signature: Schema.optional(Schema.Number),
  time_signature_confidence: Schema.optional(Schema.Number),
})

const Segment = Schema.Struct({
  ...TimeInterval.fields,
  loudness_start: Schema.optional(Schema.Number),
  loudness_max: Schema.optional(Schema.Number),
  loudness_max_time: Schema.optional(Schema.Number),
  loudness_end: Schema.optional(Schema.Number),
  pitches: Schema.optional(Schema.Array(Schema.Number)),
  timbre: Schema.optional(Schema.Array(Schema.Number)),
})

export const AudioAnalysis = Schema.Struct({
  meta: Schema.optional(
    Schema.Struct({
      analyzer_version: Schema.optional(Schema.String),
      platform: Schema.optional(Schema.String),
      detailed_status: Schema.optional(Schema.String),
      status_code: Schema.optional(Schema.Number),
      timestamp: Schema.optional(Schema.Number),
      analysis_time: Schema.optional(Schema.Number),
      input_processing_seconds: Schema.optional(Schema.Number),
      output_process_seconds: Schema.optional(Schema.Number),
    }),
  ),
  track: Schema.optional(
    Schema.Struct({
      num_samples: Schema.optional(Schema.Number),
      duration: Schema.optional(Schema.Number),
      sample_md5: Schema.optional(Schema.String),
      offset_seconds: Schema.optional(Schema.Number),
      window_seconds: Schema.optional(Schema.Number),
      analysis_sample_rate: Schema.optional(Schema.Number),
      analysis_channels: Schema.optional(Schema.Number),
      end_of_fade_in: Schema.optional(Schema.Number),
      start_of_fade_out: Schema.optional(Schema.Number),
      loudness: Schema.optional(Schema.Number),
      tempo: Schema.optional(Schema.Number),
      tempo_confidence: Schema.optional(Schema.Number),
      time_signature: Schema.optional(Schema.Number),
      time_signature_confidence: Schema.optional(Schema.Number),
      key: Schema.optional(Schema.Number),
      key_confidence: Schema.optional(Schema.Number),
      mode: Schema.optional(Schema.Number),
      mode_confidence: Schema.optional(Schema.Number),
      codestring: Schema.optional(Schema.String),
      code_version: Schema.optional(Schema.Number),
      echoprintstring: Schema.optional(Schema.String),
      echoprint_version: Schema.optional(Schema.Number),
      synthstring: Schema.optional(Schema.String),
      synth_version: Schema.optional(Schema.Number),
      rhythmstring: Schema.optional(Schema.String),
      rhythm_version: Schema.optional(Schema.Number),
    }),
  ),
  bars: Schema.optional(Schema.Array(TimeInterval)),
  beats: Schema.optional(Schema.Array(TimeInterval)),
  sections: Schema.optional(Schema.Array(Section)),
  segments: Schema.optional(Schema.Array(Segment)),
  tatums: Schema.optional(Schema.Array(TimeInterval)),
})
export type AudioAnalysis = typeof AudioAnalysis.Type

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

const PlaybackContext = Schema.Struct({
  uri: Schema.optional(Schema.String),
  href: Schema.optional(Schema.String),
  external_urls: Schema.optional(ExternalUrls),
  type: Schema.optional(Schema.String),
})

export const Device = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  is_active: Schema.optional(Schema.Boolean),
  is_restricted: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  volume_percent: Schema.optional(Schema.NullOr(Schema.Number)),
  supports_volume: Schema.optional(Schema.Boolean),
})
export type Device = typeof Device.Type

const playerState = Schema.Struct({
  device: Schema.optional(Device),
  repeat_state: Schema.optional(Schema.String),
  shuffle_state: Schema.optional(Schema.Boolean),
  context: Schema.optional(Schema.NullOr(PlaybackContext)),
  timestamp: Schema.optional(Schema.Number),
  progress_ms: Schema.optional(Schema.NullOr(Schema.Number)),
  is_playing: Schema.optional(Schema.Boolean),
  item: Schema.optional(Schema.Union([Track, Episode, Schema.Null])),
  currently_playing_type: Schema.optional(Schema.String),
  actions: Schema.optional(
    Schema.Struct({
      disallows: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
    }),
  ),
})

export const PlaybackState = playerState
export type PlaybackState = typeof PlaybackState.Type

export const CurrentlyPlaying = Schema.Struct({
  ...playerState.fields,
})
export type CurrentlyPlaying = typeof CurrentlyPlaying.Type

export const PlayHistory = Schema.Struct({
  track: Schema.optional(Track),
  played_at: Schema.optional(Schema.String),
  context: Schema.optional(Schema.NullOr(PlaybackContext)),
})
export type PlayHistory = typeof PlayHistory.Type

export const PlaybackQueue = Schema.Struct({
  currently_playing: Schema.optional(
    Schema.Union([Track, Episode, Schema.Null]),
  ),
  queue: Schema.optional(Schema.Array(Schema.Union([Track, Episode]))),
})
export type PlaybackQueue = typeof PlaybackQueue.Type

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export const RecommendationSeed = Schema.Struct({
  afterFilteringSize: Schema.optional(Schema.Number),
  afterRelinkingSize: Schema.optional(Schema.Number),
  href: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  initialPoolSize: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
})
export type RecommendationSeed = typeof RecommendationSeed.Type

export const Recommendations = Schema.Struct({
  seeds: Schema.optional(Schema.Array(RecommendationSeed)),
  tracks: Schema.optional(Schema.Array(Track)),
})
export type Recommendations = typeof Recommendations.Type

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const SearchResponse = Schema.Struct({
  tracks: Schema.optional(paging(Track)),
  artists: Schema.optional(paging(Artist)),
  albums: Schema.optional(paging(SimplifiedAlbum)),
  // Spotify search frequently returns `null` entries in `playlists.items`.
  playlists: Schema.optional(paging(Schema.NullOr(SimplifiedPlaylist))),
  shows: Schema.optional(paging(SimplifiedShow)),
  episodes: Schema.optional(paging(SimplifiedEpisode)),
  audiobooks: Schema.optional(paging(SimplifiedAudiobook)),
})
export type SearchResponse = typeof SearchResponse.Type

// ============================================================================
// Request body types
// ============================================================================

export interface ChangePlaylistDetailsBody {
  readonly name?: string
  readonly description?: string
  readonly public?: boolean
  readonly collaborative?: boolean
}

export interface CreatePlaylistBody {
  readonly name: string
  readonly description?: string
  readonly public?: boolean
  readonly collaborative?: boolean
}

export interface AddItemsBody {
  readonly uris: ReadonlyArray<string>
  readonly position?: number
}

/**
 * Replacing (`uris`) and reordering (`range_start` + `insert_before`) are
 * mutually exclusive on `PUT /playlists/{id}/items`.
 */
export type ReorderOrReplaceItemsBody =
  | { readonly uris: ReadonlyArray<string> }
  | {
      readonly range_start: number
      readonly insert_before: number
      readonly range_length?: number
      readonly snapshot_id?: string
    }

export interface PlaylistItemPositions {
  readonly uri: string
  readonly positions?: ReadonlyArray<number>
}

/** Body for `DELETE /playlists/{id}/tracks` (legacy endpoint). */
export interface RemoveTracksBody {
  readonly tracks: ReadonlyArray<PlaylistItemPositions>
  readonly snapshot_id?: string
}

/** Body for `DELETE /playlists/{id}/items` — the body key is `items`. */
export interface RemovePlaylistItemsBody {
  readonly items: ReadonlyArray<PlaylistItemPositions>
  readonly snapshot_id?: string
}

export interface SaveItemsBody {
  readonly ids: ReadonlyArray<string>
}

export interface FollowBody {
  readonly ids: ReadonlyArray<string>
}

export interface TransferPlaybackBody {
  readonly device_ids: ReadonlyArray<string>
  readonly play?: boolean
}

export interface StartPlaybackBody {
  readonly context_uri?: string
  readonly uris?: ReadonlyArray<string>
  readonly offset?: { readonly position?: number; readonly uri?: string }
  readonly position_ms?: number
}

// ============================================================================
// Endpoints — Albums
// ============================================================================

/** GET /albums/{id} */
export const getAlbum = (id: string, options?: { readonly market?: string }) =>
  getJson(`/albums/${enc(id)}`, Album, { market: options?.market })

/**
 * GET /albums
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Fetch albums individually with `getAlbum` instead.
 */
export const getSeveralAlbums = (
  ids: ReadonlyArray<string>,
  options?: { readonly market?: string },
) =>
  getJson(
    '/albums',
    Schema.Struct({ albums: Schema.Array(Schema.NullOr(Album)) }),
    {
      ids: csv(ids),
      market: options?.market,
    },
  )

/** GET /albums/{id}/tracks */
export const getAlbumTracks = (
  id: string,
  options?: {
    readonly market?: string
    readonly limit?: number
    readonly offset?: number
  },
) =>
  getJson(`/albums/${enc(id)}/tracks`, paging(SimplifiedTrack), {
    market: options?.market,
    limit: options?.limit,
    offset: options?.offset,
  })

// ============================================================================
// Endpoints — Artists
// ============================================================================

/** GET /artists/{id} */
export const getArtist = (id: string) => getJson(`/artists/${enc(id)}`, Artist)

/**
 * GET /artists
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Fetch artists individually with `getArtist` instead.
 */
export const getSeveralArtists = (ids: ReadonlyArray<string>) =>
  getJson(
    '/artists',
    Schema.Struct({ artists: Schema.Array(Schema.NullOr(Artist)) }),
    { ids: csv(ids) },
  )

/** GET /artists/{id}/albums */
export const getArtistAlbums = (
  id: string,
  options?: {
    readonly includeGroups?: ReadonlyArray<
      'album' | 'single' | 'appears_on' | 'compilation'
    >
    readonly market?: string
    readonly limit?: number
    readonly offset?: number
  },
) =>
  getJson(`/artists/${enc(id)}/albums`, paging(SimplifiedAlbum), {
    include_groups: options?.includeGroups?.join(','),
    market: options?.market,
    limit: options?.limit,
    offset: options?.offset,
  })

/**
 * GET /artists/{id}/top-tracks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Removed for Development Mode apps in February 2026.
 */
export const getArtistTopTracks = (
  id: string,
  options?: { readonly market?: string },
) =>
  getJson(
    `/artists/${enc(id)}/top-tracks`,
    Schema.Struct({ tracks: Schema.Array(Track) }),
    {
      market: options?.market,
    },
  )

/**
 * GET /artists/{id}/related-artists
 * @deprecated Restricted to Extended Quota Mode apps since November 2024.
 */
export const getArtistRelatedArtists = (id: string) =>
  getJson(
    `/artists/${enc(id)}/related-artists`,
    Schema.Struct({ artists: Schema.Array(Artist) }),
  )

// ============================================================================
// Endpoints — Shows (podcasts)
// ============================================================================

/** GET /shows/{id} */
export const getShow = (id: string, options?: { readonly market?: string }) =>
  getJson(`/shows/${enc(id)}`, Show, { market: options?.market })

/**
 * GET /shows
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Fetch shows individually with `getShow` instead.
 */
export const getSeveralShows = (
  ids: ReadonlyArray<string>,
  options?: { readonly market?: string },
) =>
  getJson(
    '/shows',
    Schema.Struct({ shows: Schema.Array(Schema.NullOr(Show)) }),
    {
      ids: csv(ids),
      market: options?.market,
    },
  )

/** GET /shows/{id}/episodes */
export const getShowEpisodes = (
  id: string,
  options?: {
    readonly market?: string
    readonly limit?: number
    readonly offset?: number
  },
) =>
  getJson(`/shows/${enc(id)}/episodes`, paging(SimplifiedEpisode), {
    market: options?.market,
    limit: options?.limit,
    offset: options?.offset,
  })

// ============================================================================
// Endpoints — Episodes
// ============================================================================

/** GET /episodes/{id} */
export const getEpisode = (
  id: string,
  options?: { readonly market?: string },
) => getJson(`/episodes/${enc(id)}`, Episode, { market: options?.market })

/**
 * GET /episodes
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Fetch episodes individually with `getEpisode` instead.
 */
export const getSeveralEpisodes = (
  ids: ReadonlyArray<string>,
  options?: { readonly market?: string },
) =>
  getJson(
    '/episodes',
    Schema.Struct({ episodes: Schema.Array(Schema.NullOr(Episode)) }),
    {
      ids: csv(ids),
      market: options?.market,
    },
  )

// ============================================================================
// Endpoints — Audiobooks
// ============================================================================

/** GET /audiobooks/{id} */
export const getAudiobook = (
  id: string,
  options?: { readonly market?: string },
) => getJson(`/audiobooks/${enc(id)}`, Audiobook, { market: options?.market })

/**
 * GET /audiobooks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Fetch audiobooks individually with `getAudiobook` instead.
 */
export const getSeveralAudiobooks = (
  ids: ReadonlyArray<string>,
  options?: { readonly market?: string },
) =>
  getJson(
    '/audiobooks',
    Schema.Struct({ audiobooks: Schema.Array(Schema.NullOr(Audiobook)) }),
    {
      ids: csv(ids),
      market: options?.market,
    },
  )

/** GET /audiobooks/{id}/chapters */
export const getAudiobookChapters = (
  id: string,
  options?: {
    readonly market?: string
    readonly limit?: number
    readonly offset?: number
  },
) =>
  getJson(`/audiobooks/${enc(id)}/chapters`, paging(SimplifiedChapter), {
    market: options?.market,
    limit: options?.limit,
    offset: options?.offset,
  })

/** GET /me/audiobooks */
export const getSavedAudiobooks = (options?: {
  readonly limit?: number
  readonly offset?: number
}) =>
  getJson('/me/audiobooks', paging(SimplifiedAudiobook), {
    limit: options?.limit,
    offset: options?.offset,
  })

/**
 * PUT /me/audiobooks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `saveToLibrary` (`PUT /me/library`) instead.
 */
export const saveAudiobooks = (ids: ReadonlyArray<string>) =>
  send('PUT', '/me/audiobooks', { urlParams: { ids: csv(ids) } })

/**
 * DELETE /me/audiobooks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `removeFromLibrary` (`DELETE /me/library`) instead.
 */
export const removeSavedAudiobooks = (ids: ReadonlyArray<string>) =>
  send('DELETE', '/me/audiobooks', { urlParams: { ids: csv(ids) } })

/**
 * GET /me/audiobooks/contains
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `checkLibraryItems` (`GET /me/library/contains`) instead.
 */
export const checkSavedAudiobooks = (ids: ReadonlyArray<string>) =>
  getJson('/me/audiobooks/contains', Schema.Array(Schema.Boolean), {
    ids: csv(ids),
  })

// ============================================================================
// Endpoints — Chapters
// ============================================================================

/** GET /chapters/{id} */
export const getChapter = (
  id: string,
  options?: { readonly market?: string },
) => getJson(`/chapters/${enc(id)}`, Chapter, { market: options?.market })

/**
 * GET /chapters
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Fetch chapters individually with `getChapter` instead.
 */
export const getSeveralChapters = (
  ids: ReadonlyArray<string>,
  options?: { readonly market?: string },
) =>
  getJson(
    '/chapters',
    Schema.Struct({ chapters: Schema.Array(Schema.NullOr(Chapter)) }),
    {
      ids: csv(ids),
      market: options?.market,
    },
  )

// ============================================================================
// Endpoints — Tracks
// ============================================================================

/** GET /tracks/{id} */
export const getTrack = (id: string, options?: { readonly market?: string }) =>
  getJson(`/tracks/${enc(id)}`, Track, { market: options?.market })

/**
 * GET /tracks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Fetch tracks individually with `getTrack` instead.
 */
export const getSeveralTracks = (
  ids: ReadonlyArray<string>,
  options?: { readonly market?: string },
) =>
  getJson(
    '/tracks',
    Schema.Struct({ tracks: Schema.Array(Schema.NullOr(Track)) }),
    {
      market: options?.market,
      ids: csv(ids),
    },
  )

// ============================================================================
// Endpoints — Search
// ============================================================================

export type SearchType =
  | 'album'
  | 'artist'
  | 'playlist'
  | 'track'
  | 'show'
  | 'episode'
  | 'audiobook'

/**
 * GET /search
 *
 * Note: since February 2026 the `limit` parameter maxes out at 10
 * (default 5) for Development Mode apps.
 */
export const search = (
  query: string,
  types: ReadonlyArray<SearchType>,
  options?: {
    readonly market?: string
    readonly limit?: number
    readonly offset?: number
    readonly includeExternal?: 'audio'
  },
) =>
  getJson('/search', SearchResponse, {
    q: query,
    type: types.join(','),
    market: options?.market,
    limit: options?.limit,
    offset: options?.offset,
    include_external: options?.includeExternal,
  })

// ============================================================================
// Endpoints — Current user
// ============================================================================

/** GET /me */
export const getCurrentUserProfile = () => getJson('/me', CurrentUserProfile)

// ============================================================================
// Endpoints — Playlists
// ============================================================================

/** GET /playlists/{playlist_id} */
export const getPlaylist = (
  playlistId: string,
  options?: {
    readonly market?: string
    readonly fields?: string
    readonly additionalTypes?: ReadonlyArray<'track' | 'episode'>
  },
) =>
  getJson(`/playlists/${enc(playlistId)}`, Playlist, {
    market: options?.market,
    fields: options?.fields,
    additional_types: options?.additionalTypes?.join(','),
  })

/** PUT /playlists/{playlist_id} */
export const changePlaylistDetails = (
  playlistId: string,
  body: ChangePlaylistDetailsBody,
) =>
  send('PUT', `/playlists/${enc(playlistId)}`, {
    body: HttpBody.jsonUnsafe(body),
  })

/**
 * GET /playlists/{playlist_id}/tracks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `getPlaylistItems` (`GET /playlists/{id}/items`) instead.
 */
export const getPlaylistTracks = (
  playlistId: string,
  options?: {
    readonly market?: string
    readonly fields?: string
    readonly limit?: number
    readonly offset?: number
    readonly additionalTypes?: ReadonlyArray<'track' | 'episode'>
  },
) =>
  getJson(`/playlists/${enc(playlistId)}/tracks`, paging(PlaylistTrack), {
    market: options?.market,
    fields: options?.fields,
    limit: options?.limit,
    offset: options?.offset,
    additional_types: options?.additionalTypes?.join(','),
  })

/**
 * POST /playlists/{playlist_id}/tracks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `addPlaylistItems` (`POST /playlists/{id}/items`) instead.
 */
export const addTracksToPlaylist = (playlistId: string, body: AddItemsBody) =>
  sendJson('POST', `/playlists/${enc(playlistId)}/tracks`, Snapshot, body)

/**
 * PUT /playlists/{playlist_id}/tracks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `reorderOrReplacePlaylistItems` (`PUT /playlists/{id}/items`) instead.
 */
export const reorderOrReplacePlaylistTracks = (
  playlistId: string,
  body: ReorderOrReplaceItemsBody,
) => sendJson('PUT', `/playlists/${enc(playlistId)}/tracks`, Snapshot, body)

/**
 * DELETE /playlists/{playlist_id}/tracks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `removePlaylistItems` (`DELETE /playlists/{id}/items`) instead.
 */
export const removeTracksFromPlaylist = (
  playlistId: string,
  body: RemoveTracksBody,
) => sendJson('DELETE', `/playlists/${enc(playlistId)}/tracks`, Snapshot, body)

/** GET /playlists/{playlist_id}/items */
export const getPlaylistItems = (
  playlistId: string,
  options?: {
    readonly market?: string
    readonly fields?: string
    readonly limit?: number
    readonly offset?: number
    readonly additionalTypes?: ReadonlyArray<'track' | 'episode'>
  },
) =>
  getJson(`/playlists/${enc(playlistId)}/items`, paging(PlaylistTrack), {
    market: options?.market,
    fields: options?.fields,
    limit: options?.limit,
    offset: options?.offset,
    additional_types: options?.additionalTypes?.join(','),
  })

/** POST /playlists/{playlist_id}/items */
export const addPlaylistItems = (playlistId: string, body: AddItemsBody) =>
  sendJson('POST', `/playlists/${enc(playlistId)}/items`, Snapshot, body)

/** PUT /playlists/{playlist_id}/items */
export const reorderOrReplacePlaylistItems = (
  playlistId: string,
  body: ReorderOrReplaceItemsBody,
) => sendJson('PUT', `/playlists/${enc(playlistId)}/items`, Snapshot, body)

/** DELETE /playlists/{playlist_id}/items */
export const removePlaylistItems = (
  playlistId: string,
  body: RemovePlaylistItemsBody,
) => sendJson('DELETE', `/playlists/${enc(playlistId)}/items`, Snapshot, body)

/** GET /me/playlists */
export const getCurrentUserPlaylists = (options?: {
  readonly limit?: number
  readonly offset?: number
}) =>
  getJson('/me/playlists', paging(SimplifiedPlaylist), {
    limit: options?.limit,
    offset: options?.offset,
  })

/** POST /me/playlists */
export const createPlaylist = (body: CreatePlaylistBody) =>
  sendJson('POST', '/me/playlists', Playlist, body)

// ============================================================================
// Endpoints — Library
// ============================================================================

/** PUT /me/library */
export const saveToLibrary = (uris: ReadonlyArray<string>) =>
  send('PUT', '/me/library', { urlParams: { uris: csv(uris) } })

/** DELETE /me/library */
export const removeFromLibrary = (uris: ReadonlyArray<string>) =>
  send('DELETE', '/me/library', { urlParams: { uris: csv(uris) } })

/** GET /me/library/contains */
export const checkLibraryItems = (uris: ReadonlyArray<string>) =>
  getJson('/me/library/contains', Schema.Array(Schema.Boolean), {
    uris: csv(uris),
  })

// ============================================================================
// Endpoints — Saved albums
// ============================================================================

/** GET /me/albums */
export const getSavedAlbums = (options?: {
  readonly limit?: number
  readonly offset?: number
  readonly market?: string
}) =>
  getJson('/me/albums', paging(SavedAlbum), {
    limit: options?.limit,
    offset: options?.offset,
    market: options?.market,
  })

/**
 * PUT /me/albums
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `saveToLibrary` (`PUT /me/library`) instead.
 */
export const saveAlbums = (ids: ReadonlyArray<string>) =>
  send('PUT', '/me/albums', { urlParams: { ids: csv(ids) } })

/**
 * DELETE /me/albums
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `removeFromLibrary` (`DELETE /me/library`) instead.
 */
export const removeSavedAlbums = (ids: ReadonlyArray<string>) =>
  send('DELETE', '/me/albums', { urlParams: { ids: csv(ids) } })

/**
 * GET /me/albums/contains
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `checkLibraryItems` (`GET /me/library/contains`) instead.
 */
export const checkSavedAlbums = (ids: ReadonlyArray<string>) =>
  getJson('/me/albums/contains', Schema.Array(Schema.Boolean), {
    ids: csv(ids),
  })

// ============================================================================
// Endpoints — Saved tracks
// ============================================================================

/** GET /me/tracks */
export const getSavedTracks = (options?: {
  readonly limit?: number
  readonly offset?: number
  readonly market?: string
}) =>
  getJson('/me/tracks', paging(SavedTrack), {
    limit: options?.limit,
    offset: options?.offset,
    market: options?.market,
  })

/**
 * PUT /me/tracks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `saveToLibrary` (`PUT /me/library`) instead.
 */
export const saveTracks = (ids: ReadonlyArray<string>) =>
  send('PUT', '/me/tracks', {
    body: HttpBody.jsonUnsafe({ ids } satisfies SaveItemsBody),
  })

/**
 * DELETE /me/tracks
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `removeFromLibrary` (`DELETE /me/library`) instead.
 */
export const removeSavedTracks = (ids: ReadonlyArray<string>) =>
  send('DELETE', '/me/tracks', { urlParams: { ids: csv(ids) } })

/**
 * GET /me/tracks/contains
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `checkLibraryItems` (`GET /me/library/contains`) instead.
 */
export const checkSavedTracks = (ids: ReadonlyArray<string>) =>
  getJson('/me/tracks/contains', Schema.Array(Schema.Boolean), {
    ids: csv(ids),
  })

// ============================================================================
// Endpoints — Saved episodes
// ============================================================================

/** GET /me/episodes */
export const getSavedEpisodes = (options?: {
  readonly limit?: number
  readonly offset?: number
  readonly market?: string
}) =>
  getJson('/me/episodes', paging(SavedEpisode), {
    limit: options?.limit,
    offset: options?.offset,
    market: options?.market,
  })

/**
 * PUT /me/episodes
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `saveToLibrary` (`PUT /me/library`) instead.
 */
export const saveEpisodes = (ids: ReadonlyArray<string>) =>
  send('PUT', '/me/episodes', { urlParams: { ids: csv(ids) } })

/**
 * DELETE /me/episodes
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `removeFromLibrary` (`DELETE /me/library`) instead.
 */
export const removeSavedEpisodes = (ids: ReadonlyArray<string>) =>
  send('DELETE', '/me/episodes', { urlParams: { ids: csv(ids) } })

/**
 * GET /me/episodes/contains
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `checkLibraryItems` (`GET /me/library/contains`) instead.
 */
export const checkSavedEpisodes = (ids: ReadonlyArray<string>) =>
  getJson('/me/episodes/contains', Schema.Array(Schema.Boolean), {
    ids: csv(ids),
  })

// ============================================================================
// Endpoints — Saved shows
// ============================================================================

/** GET /me/shows */
export const getSavedShows = (options?: {
  readonly limit?: number
  readonly offset?: number
}) =>
  getJson('/me/shows', paging(SavedShow), {
    limit: options?.limit,
    offset: options?.offset,
  })

/**
 * PUT /me/shows
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `saveToLibrary` (`PUT /me/library`) instead.
 */
export const saveShows = (ids: ReadonlyArray<string>) =>
  send('PUT', '/me/shows', { urlParams: { ids: csv(ids) } })

/**
 * DELETE /me/shows
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `removeFromLibrary` (`DELETE /me/library`) instead.
 */
export const removeSavedShows = (
  ids: ReadonlyArray<string>,
  options?: { readonly market?: string },
) =>
  send('DELETE', '/me/shows', {
    urlParams: { ids: csv(ids), market: options?.market },
  })

/**
 * GET /me/shows/contains
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `checkLibraryItems` (`GET /me/library/contains`) instead.
 */
export const checkSavedShows = (ids: ReadonlyArray<string>) =>
  getJson('/me/shows/contains', Schema.Array(Schema.Boolean), { ids: csv(ids) })

// ============================================================================
// Endpoints — Top items
// ============================================================================

interface TopItemsOptions {
  readonly timeRange?: 'long_term' | 'medium_term' | 'short_term'
  readonly limit?: number
  readonly offset?: number
}

const topItemsParams = (options?: TopItemsOptions) => ({
  time_range: options?.timeRange,
  limit: options?.limit,
  offset: options?.offset,
})

/** GET /me/top/artists */
export const getTopArtists = (options?: TopItemsOptions) =>
  getJson('/me/top/artists', paging(Artist), topItemsParams(options))

/** GET /me/top/tracks */
export const getTopTracks = (options?: TopItemsOptions) =>
  getJson('/me/top/tracks', paging(Track), topItemsParams(options))

// ============================================================================
// Endpoints — Users
// ============================================================================

/**
 * GET /users/{user_id}
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Removed for Development Mode apps in February 2026.
 */
export const getUserProfile = (userId: string) =>
  getJson(`/users/${enc(userId)}`, PublicUser)

/**
 * GET /users/{user_id}/playlists
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Removed for Development Mode apps in February 2026.
 */
export const getUserPlaylists = (
  userId: string,
  options?: { readonly limit?: number; readonly offset?: number },
) =>
  getJson(`/users/${enc(userId)}/playlists`, paging(SimplifiedPlaylist), {
    limit: options?.limit,
    offset: options?.offset,
  })

/**
 * POST /users/{user_id}/playlists
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `createPlaylist` (`POST /me/playlists`) instead.
 */
export const createPlaylistForUser = (
  userId: string,
  body: CreatePlaylistBody,
) => sendJson('POST', `/users/${enc(userId)}/playlists`, Playlist, body)

// ============================================================================
// Endpoints — Follows
// ============================================================================

/**
 * PUT /playlists/{playlist_id}/followers
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `saveToLibrary` with the playlist URI instead.
 */
export const followPlaylist = (
  playlistId: string,
  options?: { readonly public?: boolean },
) =>
  send('PUT', `/playlists/${enc(playlistId)}/followers`, {
    body: HttpBody.jsonUnsafe(
      options?.public === undefined ? {} : { public: options.public },
    ),
  })

/**
 * DELETE /playlists/{playlist_id}/followers
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `removeFromLibrary` with the playlist URI instead.
 */
export const unfollowPlaylist = (playlistId: string) =>
  send('DELETE', `/playlists/${enc(playlistId)}/followers`)

/**
 * GET /playlists/{playlist_id}/followers/contains
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `checkLibraryItems` with the playlist URI instead.
 */
export const checkPlaylistFollowers = (
  playlistId: string,
  ids: ReadonlyArray<string>,
) =>
  getJson(
    `/playlists/${enc(playlistId)}/followers/contains`,
    Schema.Array(Schema.Boolean),
    {
      ids: csv(ids),
    },
  )

/** GET /me/following */
const FollowedArtists = Schema.Struct({
  artists: Schema.optional(cursorPaging(Artist)),
})

export const getUserFollowedArtists = (options?: {
  readonly after?: string
  readonly limit?: number
}) =>
  getJson('/me/following', FollowedArtists, {
    type: 'artist',
    after: options?.after,
    limit: options?.limit,
  })

/**
 * PUT /me/following
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `saveToLibrary` with artist URIs instead.
 */
export const followArtistsOrUsers = (
  type: 'artist' | 'user',
  ids: ReadonlyArray<string>,
) =>
  send('PUT', '/me/following', {
    urlParams: { type, ids: csv(ids) },
    body: HttpBody.jsonUnsafe({ ids } satisfies FollowBody),
  })

/**
 * DELETE /me/following
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `removeFromLibrary` with artist URIs instead.
 */
export const unfollowArtistsOrUsers = (
  type: 'artist' | 'user',
  ids: ReadonlyArray<string>,
) =>
  send('DELETE', '/me/following', {
    urlParams: { type, ids: csv(ids) },
    body: HttpBody.jsonUnsafe({ ids } satisfies FollowBody),
  })

/**
 * GET /me/following/contains
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Use `checkLibraryItems` with artist URIs instead.
 */
export const checkFollowing = (
  type: 'artist' | 'user',
  ids: ReadonlyArray<string>,
) =>
  getJson('/me/following/contains', Schema.Array(Schema.Boolean), {
    type,
    ids: csv(ids),
  })

// ============================================================================
// Endpoints — Browse
// ============================================================================

const FeaturedPlaylists = Schema.Struct({
  message: Schema.optional(Schema.String),
  playlists: Schema.optional(paging(SimplifiedPlaylist)),
})

/**
 * GET /browse/featured-playlists
 * @deprecated Restricted to Extended Quota Mode apps since November 2024.
 */
export const getFeaturedPlaylists = (options?: {
  readonly locale?: string
  readonly limit?: number
  readonly offset?: number
}) =>
  getJson('/browse/featured-playlists', FeaturedPlaylists, {
    locale: options?.locale,
    limit: options?.limit,
    offset: options?.offset,
  })

/**
 * GET /browse/categories
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Removed for Development Mode apps in February 2026.
 */
export const getCategories = (options?: {
  readonly locale?: string
  readonly limit?: number
  readonly offset?: number
}) =>
  getJson(
    '/browse/categories',
    Schema.Struct({ categories: paging(Category) }),
    {
      locale: options?.locale,
      limit: options?.limit,
      offset: options?.offset,
    },
  )

/**
 * GET /browse/categories/{category_id}
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Removed for Development Mode apps in February 2026.
 */
export const getCategory = (
  categoryId: string,
  options?: { readonly locale?: string },
) =>
  getJson(`/browse/categories/${enc(categoryId)}`, Category, {
    locale: options?.locale,
  })

/**
 * GET /browse/categories/{category_id}/playlists
 * @deprecated Restricted to Extended Quota Mode apps since November 2024.
 */
export const getCategoryPlaylists = (
  categoryId: string,
  options?: { readonly limit?: number; readonly offset?: number },
) =>
  getJson(
    `/browse/categories/${enc(categoryId)}/playlists`,
    FeaturedPlaylists,
    {
      limit: options?.limit,
      offset: options?.offset,
    },
  )

/** GET /playlists/{playlist_id}/images */
export const getPlaylistCoverImage = (playlistId: string) =>
  getJson(`/playlists/${enc(playlistId)}/images`, Schema.Array(Image))

/** PUT /playlists/{playlist_id}/images — `imageData` is a base64-encoded JPEG. */
export const updatePlaylistCoverImage = (
  playlistId: string,
  imageData: string,
) =>
  send('PUT', `/playlists/${enc(playlistId)}/images`, {
    body: HttpBody.text(imageData, 'image/jpeg'),
  })

const NewReleases = Schema.Struct({
  albums: Schema.optional(paging(SimplifiedAlbum)),
})

/**
 * GET /browse/new-releases
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Removed for Development Mode apps in February 2026.
 */
export const getNewReleases = (options?: {
  readonly limit?: number
  readonly offset?: number
}) =>
  getJson('/browse/new-releases', NewReleases, {
    limit: options?.limit,
    offset: options?.offset,
  })

// ============================================================================
// Endpoints — Audio features, analysis, recommendations
// ============================================================================

/**
 * GET /audio-features
 * @deprecated Restricted to Extended Quota Mode apps since November 2024.
 */
export const getSeveralAudioFeatures = (ids: ReadonlyArray<string>) =>
  getJson(
    '/audio-features',
    Schema.Struct({
      audio_features: Schema.Array(Schema.NullOr(AudioFeatures)),
    }),
    {
      ids: csv(ids),
    },
  )

/**
 * GET /audio-features/{id}
 * @deprecated Restricted to Extended Quota Mode apps since November 2024.
 */
export const getAudioFeatures = (id: string) =>
  getJson(`/audio-features/${enc(id)}`, AudioFeatures)

/**
 * GET /audio-analysis/{id}
 * @deprecated Restricted to Extended Quota Mode apps since November 2024.
 */
export const getAudioAnalysis = (id: string) =>
  getJson(`/audio-analysis/${enc(id)}`, AudioAnalysis)

export interface TunableTrackAttributes {
  readonly min_acousticness?: number
  readonly max_acousticness?: number
  readonly target_acousticness?: number
  readonly min_danceability?: number
  readonly max_danceability?: number
  readonly target_danceability?: number
  readonly min_duration_ms?: number
  readonly max_duration_ms?: number
  readonly target_duration_ms?: number
  readonly min_energy?: number
  readonly max_energy?: number
  readonly target_energy?: number
  readonly min_instrumentalness?: number
  readonly max_instrumentalness?: number
  readonly target_instrumentalness?: number
  readonly min_key?: number
  readonly max_key?: number
  readonly target_key?: number
  readonly min_liveness?: number
  readonly max_liveness?: number
  readonly target_liveness?: number
  readonly min_loudness?: number
  readonly max_loudness?: number
  readonly target_loudness?: number
  readonly min_mode?: number
  readonly max_mode?: number
  readonly target_mode?: number
  readonly min_popularity?: number
  readonly max_popularity?: number
  readonly target_popularity?: number
  readonly min_speechiness?: number
  readonly max_speechiness?: number
  readonly target_speechiness?: number
  readonly min_tempo?: number
  readonly max_tempo?: number
  readonly target_tempo?: number
  readonly min_time_signature?: number
  readonly max_time_signature?: number
  readonly target_time_signature?: number
  readonly min_valence?: number
  readonly max_valence?: number
  readonly target_valence?: number
}

export interface RecommendationsOptions extends TunableTrackAttributes {
  readonly limit?: number
  readonly market?: string
  readonly seed_artists?: ReadonlyArray<string>
  readonly seed_genres?: ReadonlyArray<string>
  readonly seed_tracks?: ReadonlyArray<string>
}

/**
 * GET /recommendations — at least one seed is required.
 * @deprecated Restricted to Extended Quota Mode apps since November 2024.
 */
export const getRecommendations = (options: RecommendationsOptions) => {
  const { seed_artists, seed_genres, seed_tracks, ...rest } = options
  return getJson('/recommendations', Recommendations, {
    ...rest,
    seed_artists: seed_artists === undefined ? undefined : csv(seed_artists),
    seed_genres: seed_genres === undefined ? undefined : csv(seed_genres),
    seed_tracks: seed_tracks === undefined ? undefined : csv(seed_tracks),
  })
}

/**
 * GET /recommendations/available-genre-seeds
 * @deprecated Restricted to Extended Quota Mode apps since November 2024.
 */
export const getAvailableGenreSeeds = () =>
  getJson(
    '/recommendations/available-genre-seeds',
    Schema.Struct({ genres: Schema.Array(Schema.String) }),
  )

// ============================================================================
// Endpoints — Player
// ============================================================================

/** GET /me/player — 204 when playback is not available on any device. */
export const getCurrentPlayback = (options?: {
  readonly market?: string
  readonly additionalTypes?: ReadonlyArray<'track' | 'episode'>
}) =>
  getJsonOrNull('/me/player', PlaybackState, {
    market: options?.market,
    additional_types: options?.additionalTypes?.join(','),
  })

/** PUT /me/player */
export const transferPlayback = (body: TransferPlaybackBody) =>
  send('PUT', '/me/player', { body: HttpBody.jsonUnsafe(body) })

/** GET /me/player/devices */
export const getAvailableDevices = () =>
  getJson(
    '/me/player/devices',
    Schema.Struct({ devices: Schema.Array(Device) }),
  )

/** GET /me/player/currently-playing — 204 when nothing is playing. */
export const getCurrentlyPlaying = (options?: {
  readonly market?: string
  readonly additionalTypes?: ReadonlyArray<'track' | 'episode'>
}) =>
  getJsonOrNull('/me/player/currently-playing', CurrentlyPlaying, {
    market: options?.market,
    additional_types: options?.additionalTypes?.join(','),
  })

/** PUT /me/player/play */
export const startPlayback = (options?: {
  readonly deviceId?: string
  readonly body?: StartPlaybackBody
}) =>
  send('PUT', '/me/player/play', {
    urlParams: { device_id: options?.deviceId },
    body:
      options?.body === undefined
        ? undefined
        : HttpBody.jsonUnsafe(options.body),
  })

/** PUT /me/player/pause */
export const pausePlayback = (options?: { readonly deviceId?: string }) =>
  send('PUT', '/me/player/pause', {
    urlParams: { device_id: options?.deviceId },
  })

/** POST /me/player/next */
export const skipToNext = (options?: { readonly deviceId?: string }) =>
  send('POST', '/me/player/next', {
    urlParams: { device_id: options?.deviceId },
  })

/** POST /me/player/previous */
export const skipToPrevious = (options?: { readonly deviceId?: string }) =>
  send('POST', '/me/player/previous', {
    urlParams: { device_id: options?.deviceId },
  })

/** PUT /me/player/seek */
export const seekToPosition = (
  positionMs: number,
  options?: { readonly deviceId?: string },
) =>
  send('PUT', '/me/player/seek', {
    urlParams: { position_ms: positionMs, device_id: options?.deviceId },
  })

/** PUT /me/player/repeat */
export const setRepeatMode = (
  state: 'track' | 'context' | 'off',
  options?: { readonly deviceId?: string },
) =>
  send('PUT', '/me/player/repeat', {
    urlParams: { state, device_id: options?.deviceId },
  })

/** PUT /me/player/volume */
export const setPlaybackVolume = (
  volumePercent: number,
  options?: { readonly deviceId?: string },
) =>
  send('PUT', '/me/player/volume', {
    urlParams: { volume_percent: volumePercent, device_id: options?.deviceId },
  })

/** PUT /me/player/shuffle */
export const toggleShuffle = (
  state: boolean,
  options?: { readonly deviceId?: string },
) =>
  send('PUT', '/me/player/shuffle', {
    urlParams: { state, device_id: options?.deviceId },
  })

/** GET /me/player/recently-played */
export const getRecentlyPlayed = (options?: {
  readonly limit?: number
  readonly after?: number
  readonly before?: number
}) =>
  getJson('/me/player/recently-played', cursorPaging(PlayHistory), {
    limit: options?.limit,
    after: options?.after,
    before: options?.before,
  })

/** GET /me/player/queue */
export const getPlaybackQueue = () => getJson('/me/player/queue', PlaybackQueue)

/** POST /me/player/queue */
export const addToQueue = (
  uri: string,
  options?: { readonly deviceId?: string },
) =>
  send('POST', '/me/player/queue', {
    urlParams: { uri, device_id: options?.deviceId },
  })

// ============================================================================
// Endpoints — Markets
// ============================================================================

/**
 * GET /markets
 * @deprecated Removed for Development Mode apps in February 2026. Use the
 * current replacement endpoint instead (see Spotify changelog).
 * Removed for Development Mode apps in February 2026.
 */
export const getMarkets = () =>
  getJson('/markets', Schema.Struct({ markets: Schema.Array(Schema.String) }))
