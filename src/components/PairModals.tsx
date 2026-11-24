import { useRef, useState } from 'react'
import { Icon } from './Icons'
import { Modal } from './Modal'
import type { ChangeEvent, FormEvent } from 'react'
import type { NormalizedPlaylist } from '../lib/spotify-runtime'
import type { SavedSessionSummary } from '../lib/storage'

export type ActiveModal =
  | null
  | 'source'
  | 'target'
  | 'menu'
  | 'sessions'
  | 'help'
  | 'account'
  | 'settings'

interface PairModalsProps {
  readonly activeModal: ActiveModal
  readonly onClose: () => void
  readonly onOpenModal: (modal: ActiveModal) => void
  readonly displayName: string
  readonly userId: string
  readonly playlists: ReadonlyArray<NormalizedPlaylist>
  readonly sourceId: string
  readonly targetId: string
  readonly canModifyPlaylists: boolean
  readonly sessions: ReadonlyArray<SavedSessionSummary>
  readonly busy: boolean
  readonly onSelectSource: (sourceId: string) => void
  readonly onSelectTarget: (targetId: string) => void
  readonly onCreateTargetPlaylist: (name: string) => Promise<void>
  readonly onSelectSession: (sourceId: string, targetId: string) => void
  readonly onDisconnect: () => void
  readonly onExportData: () => void
  readonly onImportData: (jsonText: string) => void
}

function visibilityLabel(playlist: NormalizedPlaylist): string {
  if (playlist.public === false) return 'Private playlist'
  if (playlist.public === true) return 'Public playlist'
  return 'Playlist'
}

export function PairModals({
  activeModal,
  onClose,
  onOpenModal,
  displayName,
  userId,
  playlists,
  sourceId,
  targetId,
  canModifyPlaylists,
  sessions,
  busy,
  onSelectSource,
  onSelectTarget,
  onCreateTargetPlaylist,
  onSelectSession,
  onDisconnect,
  onExportData,
  onImportData,
}: PairModalsProps) {
  const [search, setSearch] = useState('')
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [creating, setCreating] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleClose = () => {
    setSearch('')
    setNewPlaylistName('')
    onClose()
  }

  const editablePlaylists = playlists.filter(
    (p) => p.ownerId === userId || p.collaborative,
  )

  const pickerKind =
    activeModal === 'source' || activeModal === 'target' ? activeModal : null

  const pickerList = pickerKind
    ? (pickerKind === 'source' ? playlists : editablePlaylists).filter((p) => {
        const excluded = pickerKind === 'source' ? targetId : sourceId
        if (p.id === excluded) return false
        if (!search.trim()) return true
        return p.name.toLowerCase().includes(search.trim().toLowerCase())
      })
    : []

  const handleCreatePlaylist = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = newPlaylistName.trim()
    if (!trimmed || creating) return
    setCreating(true)
    try {
      await onCreateTargetPlaylist(trimmed)
      setNewPlaylistName('')
      handleClose()
    } finally {
      setCreating(false)
    }
  }

  const handleFileImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onImportData(reader.result)
      }
    }
    reader.readAsText(file)
    event.target.value = ''
  }

  const playlistName = (id: string) =>
    id === 'liked'
      ? 'Liked Songs'
      : playlists.find((p) => p.id === id)?.name || 'Unavailable playlist'

  return (
    <Modal
      open={activeModal !== null}
      onClose={handleClose}
    >
      {pickerKind ? (
        <>
          <div className="modal-eyebrow">MAKE IT YOURS</div>
          <h2>
            {pickerKind === 'source'
              ? 'Where are we listening?'
              : 'Where do the favorites go?'}
          </h2>
          <p>
            {pickerKind === 'source'
              ? 'Pick any source playlist or Liked Songs. Curate never removes songs from your source.'
              : 'Choose a playlist you own or collaborate on. Songs already in the target are automatically filtered out.'}
          </p>

          <div className="modal-search">
            <Icon name="search" />
            <input
              placeholder="Search your playlists"
              aria-label="Search your playlists"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="picker-options">
            {pickerKind === 'source' &&
            (!search.trim() ||
              'liked songs'.includes(search.trim().toLowerCase())) ? (
              <button
                type="button"
                className="picker-option"
                onClick={() => {
                  handleClose()
                  onSelectSource('liked')
                }}
              >
                <span className="selection-art liked-art">
                  <Icon name="heart" />
                </span>
                <span>
                  <strong>Liked Songs</strong>
                  <small>Your saved favorites · Default source</small>
                </span>
                <Icon name={sourceId === 'liked' ? 'check' : 'chevron'} />
              </button>
            ) : null}

            {pickerList.map((p, index) => (
              <button
                key={p.id}
                type="button"
                className="picker-option"
                onClick={() => {
                  handleClose()
                  if (pickerKind === 'source') onSelectSource(p.id)
                  else onSelectTarget(p.id)
                }}
              >
                <span className={`selection-art small-art-${index % 3}`}>
                  {p.imageUrl ? (
                    <img
                      src={p.imageUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <Icon name="music" />
                  )}
                </span>
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {visibilityLabel(p)}
                    {p.totalItems !== null ? ` · ${p.totalItems} songs` : ''}
                  </small>
                </span>
                <Icon
                  name={
                    p.id === (pickerKind === 'source' ? sourceId : targetId)
                      ? 'check'
                      : 'chevron'
                  }
                />
              </button>
            ))}

            {pickerList.length === 0 && pickerKind === 'target' ? (
              <p className="modal-footnote">
                No matching editable playlists found. Create a new one below.
              </p>
            ) : null}
          </div>

          {pickerKind === 'target' && canModifyPlaylists ? (
            <form
              className="create-playlist-box"
              onSubmit={(e) => void handleCreatePlaylist(e)}
            >
              <input
                className="form-input"
                placeholder="New playlist name…"
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                disabled={creating}
                aria-label="New playlist name"
              />
              <button
                type="submit"
                className="button primary"
                disabled={!newPlaylistName.trim() || creating}
              >
                <Icon name="plus" />
                {creating ? 'Creating…' : 'Create'}
              </button>
            </form>
          ) : null}
        </>
      ) : null}

      {activeModal === 'menu' ? (
        <>
          <div className="modal-eyebrow">CURATE</div>
          <h2>Options</h2>
          <button
            type="button"
            className="picker-option"
            onClick={() => onOpenModal('sessions')}
          >
            <Icon name="clock" />
            <span>
              <strong>Your sessions</strong>
              <small>Switch between remembered playlist pairings</small>
            </span>
            <Icon name="chevron" />
          </button>
          <button
            type="button"
            className="picker-option"
            onClick={() => onOpenModal('help')}
          >
            <Icon name="info" />
            <span>
              <strong>How it works</strong>
              <small>Tips, shortcuts, and playback sync</small>
            </span>
            <Icon name="chevron" />
          </button>
          <button
            type="button"
            className="picker-option"
            onClick={() => onOpenModal('settings')}
          >
            <Icon name="settings" />
            <span>
              <strong>Settings &amp; privacy</strong>
              <small>Local storage, backup export &amp; import</small>
            </span>
            <Icon name="chevron" />
          </button>
        </>
      ) : null}

      {activeModal === 'sessions' ? (
        <>
          <div className="modal-eyebrow">PICK UP WHERE YOU LEFT OFF</div>
          <h2>Your sessions</h2>
          <p>
            Each source/target pairing keeps its own listening history in this
            browser.
          </p>
          <div className="picker-options">
            {sessions.length > 0 ? (
              sessions.map((session) => {
                const targetAvailable = editablePlaylists.some(
                  (p) => p.id === session.target,
                )
                const sourceAvailable =
                  session.source === 'liked' ||
                  playlists.some((p) => p.id === session.source)
                return (
                  <button
                    key={`${session.source}:${session.target}`}
                    type="button"
                    className="picker-option"
                    disabled={!targetAvailable || !sourceAvailable}
                    onClick={() => {
                      handleClose()
                      onSelectSession(session.source, session.target)
                    }}
                  >
                    <span className="selection-art target-art">
                      <Icon name="music" />
                    </span>
                    <span>
                      <strong>{playlistName(session.target)}</strong>
                      <small>
                        From {playlistName(session.source)} · {session.count}{' '}
                        decisions ·{' '}
                        {new Date(session.updatedAt).toLocaleDateString()}
                      </small>
                    </span>
                    <Icon name="arrow" />
                  </button>
                )
              })
            ) : (
              <div className="queue-empty">
                <strong>Your next session starts here.</strong>
                <p>
                  Choose a source and target playlist to begin tracking your
                  progress.
                </p>
              </div>
            )}
          </div>
        </>
      ) : null}

      {activeModal === 'help' ? (
        <>
          <div className="modal-eyebrow">LESS SCROLLING, MORE LISTENING</div>
          <h2>Your playlist, one good song at a time.</h2>
          <div className="help-step">
            <b>01</b>
            <div>
              <h3>Choose your pairing.</h3>
              <p>
                Pick Liked Songs or any playlist as your source, and any
                playlist you own or collaborate on as your target. Curate
                remembers each pairing separately.
              </p>
            </div>
          </div>
          <div className="help-step">
            <b>02</b>
            <div>
              <h3>Listen, add, or skip.</h3>
              <p>
                Press Play to start on your active Spotify device. Click{' '}
                <strong>Add</strong> (or press <code>A</code>) to add the track
                directly to your target playlist, or <strong>Skip</strong> (
                <code>→</code>) to move on. Toggle Shuffle anytime—your progress
                is still tracked.
              </p>
            </div>
          </div>
          <div className="help-step">
            <b>03</b>
            <div>
              <h3>Undo anytime.</h3>
              <p>
                Undo reverts your last skip or listened mark—and if your last
                action was adding a song, Undo removes it from your target
                playlist too.
              </p>
            </div>
          </div>
          <div className="privacy-callout">
            <Icon name="shield" />
            <p>
              Your source playlist is never modified. All decisions stay in this
              browser.
            </p>
          </div>
        </>
      ) : null}

      {activeModal === 'account' ? (
        <>
          <div className="modal-eyebrow">YOUR SPOTIFY ACCOUNT</div>
          <h2>Hey, {displayName || 'music lover'}.</h2>
          <p>
            You’re connected. Playback runs on your active Spotify device, and
            Curate syncs automatically.
          </p>
          <button
            type="button"
            className="button secondary full-width"
            disabled={busy}
            onClick={() => {
              handleClose()
              onDisconnect()
            }}
          >
            <Icon name="logout" /> Disconnect Spotify
          </button>
          <p className="modal-footnote">
            Disconnecting clears your session tokens, not your saved local
            decisions or Client ID.
          </p>
        </>
      ) : null}

      {activeModal === 'settings' ? (
        <>
          <div className="modal-eyebrow">YOUR SPACE, YOUR RULES</div>
          <h2>Settings &amp; privacy</h2>
          <div className="settings-item">
            <strong>Local, not lost.</strong>
            <p>
              Playlist pairings and track decisions are saved in your browser’s
              local storage. Session tokens live in tab-scoped session storage
              and clear when you close the tab.
            </p>
          </div>
          <div className="settings-item">
            <strong>Backup &amp; restore</strong>
            <p>
              Export your pairings and track decisions as JSON to move between
              browsers or keep a backup.
            </p>
            <div className="settings-actions">
              <button
                type="button"
                className="button secondary"
                onClick={onExportData}
              >
                Export progress JSON
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                Import progress JSON
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                hidden
                onChange={handleFileImport}
              />
            </div>
          </div>
          <a
            className="terms-link"
            href="https://developer.spotify.com/terms"
            target="_blank"
            rel="noopener noreferrer"
          >
            Spotify Developer Terms <Icon name="external" />
          </a>
        </>
      ) : null}
    </Modal>
  )
}
