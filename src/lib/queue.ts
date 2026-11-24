import type { Episode, Track } from '../spotify'
import type { NormalizedTrack } from './spotify-runtime'

export type Decision = 'skipped' | 'listened'
export interface ProgressEntry {
  readonly status: Decision
  readonly at: number
}
export type Progress = Record<string, ProgressEntry | undefined>
export type Filter = 'remaining' | 'added' | 'skipped' | 'listened'

export interface PlaybackSample {
  readonly id: string | null
  readonly position: number
  readonly playing: boolean
  readonly at: number
}

export function trackStatus(
  id: string,
  progress: Progress,
  targetIds: ReadonlySet<string>,
): Filter {
  if (targetIds.has(id)) return 'added'
  return progress[id]?.status ?? 'remaining'
}

export function filterTracks(
  tracks: ReadonlyArray<NormalizedTrack>,
  progress: Progress,
  targetIds: ReadonlySet<string>,
  filter: Filter,
): Array<NormalizedTrack> {
  return tracks.filter(
    (track) => trackStatus(track.id, progress, targetIds) === filter,
  )
}

/** Deterministic PRNG (Mulberry32) for stable Curate-side shuffle order. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function orderTracks<T extends { readonly id: string }>(
  tracks: ReadonlyArray<T>,
  shuffleSeed: number | null,
): Array<T> {
  const copy = [...tracks]
  if (shuffleSeed === null) return copy
  const rand = mulberry32(shuffleSeed)
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function matchPlaybackTrack(
  queue: ReadonlyArray<NormalizedTrack>,
  item: Track | Episode | null | undefined,
  preferredTrack?: NormalizedTrack,
): NormalizedTrack | undefined {
  if (!item || item.type !== 'track') return undefined
  const trackItem = item
  const candidates = preferredTrack
    ? [preferredTrack, ...queue.filter((t) => t.id !== preferredTrack.id)]
    : queue

  // 1. Direct ID or URI match
  const direct = candidates.find(
    (track) =>
      (trackItem.id && track.id === trackItem.id) ||
      (trackItem.uri && track.uri === trackItem.uri),
  )
  if (direct) return direct

  // 2. Relinked track match via linked_from
  const identities = new Set(
    [
      trackItem.id,
      trackItem.uri,
      trackItem.linked_from?.id,
      trackItem.linked_from?.uri,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0),
  )
  if (identities.size > 0) {
    const relinked = candidates.find((track) =>
      [track.id, track.uri, track.linked_from?.id, track.linked_from?.uri].some(
        (id) => typeof id === 'string' && identities.has(id),
      ),
    )
    if (relinked) return relinked
  }

  // 3. Same recording via ISRC (handles regional / album re-release substitutions)
  const itemIsrc = trackItem.external_ids?.isrc
  if (itemIsrc) {
    const byIsrc = candidates.find(
      (track) => track.isrc && track.isrc === itemIsrc,
    )
    if (byIsrc) return byIsrc
  }

  // 4. Fallback: same title + primary artist + similar duration (±5s)
  const itemName = normalizeText(trackItem.name)
  const itemArtist = normalizeText(trackItem.artists?.[0]?.name)
  const itemDuration = trackItem.duration_ms ?? 0
  if (itemName && itemArtist) {
    return candidates.find((track) => {
      if (normalizeText(track.name) !== itemName) return false
      const trackArtist = normalizeText(track.artists[0]?.name)
      if (trackArtist !== itemArtist) return false
      if (itemDuration > 0 && track.duration_ms > 0) {
        return Math.abs(track.duration_ms - itemDuration) <= 5_000
      }
      return true
    })
  }

  return undefined
}

/**
 * Observation heuristic to infer whether the previous track finished or was skipped
 * directly in Spotify. Tolerates brief reconnect gaps (up to 25s) without misclassifying
 * a transient disconnect as a skip.
 */
export function observedDecision(
  track: NormalizedTrack,
  previous: PlaybackSample | null,
  next: PlaybackSample,
): Decision | null {
  if (
    !previous ||
    previous.id !== track.id ||
    !previous.playing ||
    next.at - previous.at > 25_000 ||
    next.at < previous.at
  ) {
    return null
  }
  const nearEnd = previous.position >= track.duration_ms - 8_000
  const elapsed = next.at - previous.at

  if (!next.id) {
    return nearEnd && previous.position + elapsed >= track.duration_ms - 500
      ? 'listened'
      : null
  }
  if (next.id !== track.id) {
    return nearEnd ? 'listened' : 'skipped'
  }
  if (!next.playing && next.position >= track.duration_ms - 1_500) {
    return 'listened'
  }
  if (
    nearEnd &&
    next.position < 1_500 &&
    previous.position + elapsed >= track.duration_ms - 500
  ) {
    return 'listened'
  }
  return null
}

export function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
