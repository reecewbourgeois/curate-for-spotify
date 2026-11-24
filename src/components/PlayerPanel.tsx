import { formatTime } from '../lib/queue'
import { Icon, SpotifyIcon } from './Icons'
import type { MouseEvent } from 'react'
import type { PlaybackSnapshot } from '../lib/playback'
import type { NormalizedTrack } from '../lib/spotify-runtime'

interface PlayerPanelProps {
  readonly loading: boolean
  readonly loadProgressText: string | null
  readonly pairReady: boolean
  readonly hasTarget: boolean
  readonly hasAnyTracks: boolean
  readonly currentTrack: NormalizedTrack | undefined
  readonly playback: PlaybackSnapshot
  readonly busy: boolean
  readonly canModifyPlaylists: boolean
  readonly targetName: string
  readonly onTogglePlay: () => void
  readonly onAddCurrent: () => void
  readonly onSkipCurrent: () => void
  readonly onSeek: (positionMs: number) => void
  readonly onSelectDevice: (deviceId: string) => void
  readonly onRefreshDevices: () => void
  readonly onOpenPicker: (kind: 'source' | 'target') => void
  readonly onRetryLoad: () => void
}

function safeSpotifyUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

export function PlayerPanel({
  loading,
  loadProgressText,
  pairReady,
  hasTarget,
  hasAnyTracks,
  currentTrack,
  playback,
  busy,
  canModifyPlaylists,
  targetName,
  onTogglePlay,
  onAddCurrent,
  onSkipCurrent,
  onSeek,
  onSelectDevice,
  onRefreshDevices,
  onOpenPicker,
  onRetryLoad,
}: PlayerPanelProps) {
  const isPlaying = playback.status === 'playing'
  const isReconnecting = playback.status === 'reconnecting'
  const isActive =
    playback.status === 'playing' ||
    playback.status === 'paused' ||
    playback.status === 'starting' ||
    playback.status === 'reconnecting'

  const controlsDisabled = busy || loading || !pairReady || !hasTarget
  const duration = currentTrack?.duration_ms ?? 0
  const percent =
    duration > 0 ? Math.min(100, (playback.positionMs / duration) * 100) : 0

  const handleScrub = (event: MouseEvent<HTMLButtonElement>) => {
    if (!currentTrack || duration <= 0 || !isActive) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / rect.width),
    )
    onSeek(ratio * duration)
  }

  const indicatorLabel = isPlaying
    ? 'LIVE ON SPOTIFY'
    : isReconnecting
      ? 'RECONNECTING…'
      : playback.status === 'paused'
        ? 'PAUSED'
        : playback.status === 'outside_queue'
          ? 'OUTSIDE QUEUE'
          : playback.status === 'no_device'
            ? 'NO ACTIVE DEVICE'
            : 'READY WHEN YOU ARE'

  const indicatorClass = isPlaying
    ? 'live-indicator is-playing'
    : isReconnecting || playback.status === 'no_device'
      ? 'live-indicator is-reconnecting'
      : 'live-indicator'

  const trackUrl = safeSpotifyUrl(currentTrack?.external_urls?.spotify)
  const coverUrl = safeSpotifyUrl(currentTrack?.album.images[0]?.url)

  return (
    <section className="listening-panel panel">
      <div className="panel-heading">
        <span className="eyebrow">
          {isActive ? 'NOW LISTENING' : 'ON THE DECK'}
        </span>
        <span className={indicatorClass}>
          <i />
          {indicatorLabel}
        </span>
      </div>

      {loading ? (
        <div className="player-empty">
          <span className="loading-spinner" />
          <h2>Finding your music…</h2>
          <p>
            {loadProgressText ?? 'Loading your source and target playlists.'}
          </p>
        </div>
      ) : !pairReady ? (
        <div className="player-empty">
          <span className="complete-icon">
            <Icon name="refresh" />
          </span>
          <h2>Let’s try that again.</h2>
          <p>We couldn’t load this queue. Retry to fetch your playlists.</p>
          <button
            type="button"
            className="button primary"
            onClick={onRetryLoad}
          >
            Retry <Icon name="refresh" />
          </button>
        </div>
      ) : currentTrack && hasTarget ? (
        <>
          <div className="album-stage">
            {coverUrl ? (
              <img
                className="cover cover-large"
                src={coverUrl}
                alt={`${currentTrack.album.name} album artwork`}
                referrerPolicy="no-referrer"
              />
            ) : (
              <div
                className="cover no-art cover-large"
                aria-label="No artwork available"
              >
                <Icon name="music" />
              </div>
            )}
            <span className="record-edge" />
          </div>

          <div className="track-info">
            <h2>{currentTrack.name}</h2>
            <p>{currentTrack.artists.map((a) => a.name).join(', ')}</p>
            <span>{currentTrack.album.name}</span>
            {trackUrl ? (
              <div>
                <a
                  className="spotify-track-link"
                  href={trackUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <SpotifyIcon /> Listen on Spotify <Icon name="external" />
                </a>
              </div>
            ) : null}
          </div>

          <div className="playback">
            <button
              type="button"
              className="scrubber-button"
              onClick={handleScrub}
              disabled={!isActive || duration <= 0}
              aria-label="Seek playback position"
            >
              <div
                className="scrubber"
                role="progressbar"
                aria-label="Playback progress"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={Math.round(playback.positionMs)}
              >
                <div style={{ width: `${percent}%` }} />
              </div>
            </button>
            <div className="playback-times">
              <span>{formatTime(playback.positionMs)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          <div className="transport">
            <button
              type="button"
              className="add-track-button"
              onClick={onAddCurrent}
              disabled={controlsDisabled || !canModifyPlaylists}
              title={
                canModifyPlaylists
                  ? `Add to ${targetName} (A)`
                  : 'Reconnect with playlist-modify permissions to add directly'
              }
            >
              <Icon name="plus" />
              <span>Add</span>
            </button>

            <button
              type="button"
              className="play-button"
              onClick={onTogglePlay}
              disabled={controlsDisabled}
              aria-label={isPlaying ? 'Pause' : 'Start listening'}
              title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            >
              <Icon name={isPlaying ? 'pause' : 'play'} />
            </button>

            <button
              type="button"
              className="skip-track-button"
              onClick={onSkipCurrent}
              disabled={controlsDisabled}
              aria-label="Skip this song"
              title="Skip this song (→)"
            >
              <span>Skip</span>
              <Icon name="skip" />
            </button>
          </div>

          <div className="player-footnote">
            {playback.status === 'outside_queue' ? (
              <span>
                {playback.outsideTrackName
                  ? `Spotify is playing “${playback.outsideTrackName}” outside this queue. Press Play to rejoin here.`
                  : 'Spotify is playing outside this queue. Press Play to rejoin here.'}
              </span>
            ) : playback.status === 'reconnecting' ? (
              <span>
                Reconnecting to your Spotify player… playback will resync
                automatically.
              </span>
            ) : playback.status === 'no_device' ? (
              <>
                <span>
                  {playback.devices.length > 0
                    ? 'Choose a Spotify device to start playback:'
                    : 'No active Spotify device found. Open Spotify on your phone or computer, then retry.'}
                </span>
                {playback.devices.length > 0 ? (
                  <div className="device-picker-inline">
                    {playback.devices
                      .filter((d) => d.id && !d.is_restricted)
                      .map((device) => (
                        <button
                          key={device.id}
                          type="button"
                          className="device-chip"
                          onClick={() => onSelectDevice(device.id!)}
                        >
                          {device.name || device.type || 'Spotify device'}
                        </button>
                      ))}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="text-button"
                    onClick={onRefreshDevices}
                  >
                    <Icon name="refresh" /> Check for devices
                  </button>
                )}
              </>
            ) : playback.deviceName ? (
              <span className="device-row">
                <Icon name="device" />
                Playing on {playback.deviceName}
              </span>
            ) : isActive ? (
              <span>Synced with Spotify.</span>
            ) : (
              <span>
                Open Spotify on a device, then press Play. Premium is required
                for remote playback.
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="player-empty">
          <span className="complete-icon">
            <Icon name={hasTarget ? 'check' : 'music'} />
          </span>
          <h2>
            {hasTarget
              ? hasAnyTracks
                ? 'All caught up.'
                : 'A clean slate.'
              : 'Pick your destination.'}
          </h2>
          <p>
            {hasTarget
              ? hasAnyTracks
                ? 'You’ve reviewed every song in this source for this target playlist.'
                : 'This source playlist has no playable tracks. Choose another source.'
              : 'Choose or create a target playlist to start your listening journey.'}
          </p>
          <button
            type="button"
            className="button primary"
            onClick={() => onOpenPicker(hasTarget ? 'source' : 'target')}
          >
            Choose {hasTarget ? 'another source' : 'a playlist'}{' '}
            <Icon name="arrow" />
          </button>
        </div>
      )}
    </section>
  )
}
