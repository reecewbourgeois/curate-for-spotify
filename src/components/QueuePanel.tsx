import { formatTime } from '../lib/queue'
import { Icon } from './Icons'
import type { Filter } from '../lib/queue'
import type { NormalizedTrack } from '../lib/spotify-runtime'

interface QueuePanelProps {
  readonly loading: boolean
  readonly busy: boolean
  readonly isPlaying: boolean
  readonly pairReady: boolean
  readonly hasTarget: boolean
  readonly canModifyPlaylists: boolean
  readonly filter: Filter
  readonly query: string
  readonly shuffled: boolean
  readonly canUndo: boolean
  readonly counts: {
    readonly remaining: number
    readonly added: number
    readonly skipped: number
    readonly listened: number
  }
  readonly shownTracks: ReadonlyArray<NormalizedTrack>
  readonly currentTrackId: string | null
  readonly onFilterChange: (filter: Filter) => void
  readonly onQueryChange: (query: string) => void
  readonly onToggleShuffle: () => void
  readonly onRefresh: () => void
  readonly onResetProgress: () => void
  readonly onUndo: () => void
  readonly onPlayFrom: (trackId: string) => void
  readonly onAddTrack: (track: NormalizedTrack) => void
  readonly onRequeueTrack: (trackId: string) => void
}

const TABS: ReadonlyArray<readonly [Filter, string]> = [
  ['remaining', 'Remaining'],
  ['added', 'Added'],
  ['skipped', 'Skipped'],
  ['listened', 'Listened'],
]

export function QueuePanel({
  loading,
  busy,
  isPlaying,
  pairReady,
  hasTarget,
  canModifyPlaylists,
  filter,
  query,
  shuffled,
  canUndo,
  counts,
  shownTracks,
  currentTrackId,
  onFilterChange,
  onQueryChange,
  onToggleShuffle,
  onRefresh,
  onResetProgress,
  onUndo,
  onPlayFrom,
  onAddTrack,
  onRequeueTrack,
}: QueuePanelProps) {
  const disabled = busy || loading
  const playbackDisabled = disabled || !pairReady || !hasTarget

  return (
    <section className="queue-panel panel">
      <div className="queue-header">
        <div>
          <h2>
            Your listening queue <span>{counts.remaining}</span>
          </h2>
          <p>
            Add songs directly to your target playlist, or skip them for later.
          </p>
        </div>
        <div className="queue-actions">
          <button
            type="button"
            className={`icon-button ${shuffled ? 'is-active' : ''}`}
            onClick={onToggleShuffle}
            disabled={disabled || !pairReady}
            aria-label={
              shuffled ? 'Disable shuffle order' : 'Shuffle remaining queue'
            }
            aria-pressed={shuffled}
            title={
              shuffled
                ? 'Shuffle is on (progress is still tracked)'
                : 'Shuffle remaining songs'
            }
          >
            <Icon name="shuffle" />
          </button>
          <button
            type="button"
            className="button reset-button"
            onClick={onResetProgress}
            disabled={disabled || isPlaying || !hasTarget || !pairReady}
            title="Reset skipped and listened decisions for this pair"
          >
            <Icon name="undo" />
            <span>Reset local progress</span>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onRefresh}
            disabled={disabled}
            aria-label="Refresh playlists"
            title="Refresh from Spotify"
          >
            <Icon
              name="refresh"
              className={loading ? 'spin' : ''}
            />
          </button>
        </div>
      </div>

      <div
        className="queue-tabs"
        role="tablist"
        aria-label="Filter songs"
      >
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            className={filter === id ? 'active' : ''}
            onClick={() => onFilterChange(id)}
          >
            {label}
            <span>{counts[id]}</span>
          </button>
        ))}
      </div>

      <div className="queue-search">
        <Icon name="search" />
        <input
          id="queue-search"
          type="search"
          placeholder="Find a song, artist, or album"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label="Search songs"
        />
        <span>
          <Icon name="music" />
        </span>
      </div>

      <div className="table-heading">
        <span>#</span>
        <span>SONG / ARTIST</span>
        <span>
          <Icon name="clock" />
        </span>
      </div>

      <div
        className="queue-list"
        role="tabpanel"
        aria-label={`${filter} songs`}
      >
        {loading ? (
          <div className="queue-empty">Loading your queue…</div>
        ) : shownTracks.length > 0 ? (
          shownTracks.map((track, idx) => {
            const isCurrent =
              filter === 'remaining' && track.id === currentTrackId
            const artUrl = track.album.images[0]?.url

            return (
              <div
                key={track.id}
                className={`song-row ${isCurrent ? 'current' : ''}`}
              >
                <span className="song-number">
                  {isCurrent ? (
                    <span
                      className={`equalizer ${isPlaying ? 'animated' : ''}`}
                    >
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    String(idx + 1).padStart(2, '0')
                  )}
                </span>

                {artUrl ? (
                  <img
                    className="cover"
                    src={artUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="cover no-art"
                    aria-hidden="true"
                  >
                    <Icon name="music" />
                  </div>
                )}

                <div className="song-details">
                  <strong>{track.name}</strong>
                  <span>{track.artists.map((a) => a.name).join(', ')}</span>
                </div>

                <span className="song-duration">
                  {formatTime(track.duration_ms)}
                </span>

                <div className="row-actions">
                  {filter === 'remaining' ? (
                    <>
                      <button
                        type="button"
                        className="row-action-btn"
                        onClick={() => onPlayFrom(track.id)}
                        disabled={playbackDisabled}
                        aria-label={`Play ${track.name}`}
                        title="Play from here"
                      >
                        <Icon name="play" />
                      </button>
                      {canModifyPlaylists ? (
                        <button
                          type="button"
                          className="row-action-btn"
                          onClick={() => onAddTrack(track)}
                          disabled={playbackDisabled}
                          aria-label={`Add ${track.name} to target playlist`}
                          title="Add to target playlist"
                        >
                          <Icon name="plus" />
                        </button>
                      ) : null}
                    </>
                  ) : filter === 'added' ? (
                    <span
                      className="status-icon added"
                      title="In target playlist"
                    >
                      <Icon name="check" />
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="row-action-btn"
                        onClick={() => onRequeueTrack(track.id)}
                        disabled={disabled}
                        aria-label={`Move ${track.name} back to remaining`}
                        title="Move back to Remaining"
                      >
                        <Icon name="undo" />
                      </button>
                      {canModifyPlaylists ? (
                        <button
                          type="button"
                          className="row-action-btn"
                          onClick={() => onAddTrack(track)}
                          disabled={playbackDisabled}
                          aria-label={`Add ${track.name} to target playlist`}
                          title="Add to target playlist"
                        >
                          <Icon name="plus" />
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            )
          })
        ) : (
          <div className="queue-empty">
            <Icon
              name={
                query ? 'search' : filter === 'remaining' ? 'check' : 'music'
              }
            />
            <strong>
              {query
                ? 'No songs found'
                : filter === 'remaining'
                  ? 'You’re all caught up'
                  : `No ${filter} songs yet`}
            </strong>
            <p>
              {query
                ? 'Try a different song, artist, or album.'
                : 'Your listening journey starts one song at a time.'}
            </p>
          </div>
        )}
      </div>

      <div className="queue-footer">
        <span>
          <Icon name="shield" /> Your source playlist stays untouched.
        </span>
        <button
          type="button"
          className="text-button"
          onClick={onUndo}
          disabled={!canUndo || disabled}
          title="Undo last decision (Z)"
        >
          <Icon name="undo" /> Undo
        </button>
      </div>
    </section>
  )
}
