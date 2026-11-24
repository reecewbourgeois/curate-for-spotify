import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrandLogo, Icon, SpotifyAttribution } from '../components/Icons'
import { PairModals } from '../components/PairModals'
import { PlayerPanel } from '../components/PlayerPanel'
import { QueuePanel } from '../components/QueuePanel'
import { useToast } from '../components/Toast'
import {
  AuthorizationRequired,
  getSavedClientId,
  startSpotifyAuth,
} from '../lib/auth'
import { PlaybackController } from '../lib/playback'
import { filterTracks, orderTracks } from '../lib/queue'
import {
  addTrackToTargetPlaylist,
  createTargetPlaylist,
  fetchAllUserPlaylists,
  fetchCurrentUserProfile,
  fetchSourceTracks,
  formatSpotifyError,
  removeTrackFromTargetPlaylist,
  spotifySession,
} from '../lib/spotify-runtime'
import {
  exportAccountData,
  importAccountData,
  listSessions,
  loadProgress,
  loadSelection,
  saveProgress,
  saveSelection,
} from '../lib/storage'
import type { ActiveModal } from '../components/PairModals'
import type { PlaybackSnapshot } from '../lib/playback'
import type { Decision, Filter, Progress, ProgressEntry } from '../lib/queue'
import type {
  NormalizedPlaylist,
  NormalizedTrack,
} from '../lib/spotify-runtime'

interface CurateSearch {
  readonly source?: string
  readonly target?: string
}

type UndoAction =
  | {
      readonly kind: 'decision'
      readonly track: NormalizedTrack
      readonly previous: ProgressEntry | undefined
    }
  | {
      readonly kind: 'added'
      readonly track: NormalizedTrack
      readonly previous: ProgressEntry | undefined
    }

const INITIAL_PLAYBACK: PlaybackSnapshot = {
  status: 'idle',
  currentTrackId: null,
  positionMs: 0,
  deviceName: '',
  deviceId: null,
  devices: [],
  consecutiveMisses: 0,
  outsideTrackName: '',
}

export const Route = createFileRoute('/curate')({
  validateSearch: (search: Record<string, unknown>): CurateSearch => ({
    source: typeof search.source === 'string' ? search.source : undefined,
    target: typeof search.target === 'string' ? search.target : undefined,
  }),
  beforeLoad: () => {
    if (!spotifySession.isAuthenticated) {
      throw redirect({ to: '/setup', replace: true })
    }
  },
  loader: async ({ abortController }) => {
    try {
      const [profile, playlists] = await Promise.all([
        fetchCurrentUserProfile(abortController.signal),
        fetchAllUserPlaylists(abortController.signal),
      ])
      return { profile, playlists }
    } catch (error) {
      if (error instanceof AuthorizationRequired) {
        spotifySession.disconnect()
        throw redirect({
          to: '/setup',
          search: { error: error.message },
          replace: true,
        })
      }
      throw error
    }
  },
  pendingComponent: CuratePending,
  component: CuratePage,
})

function CuratePending() {
  return (
    <>
      <header className="topbar">
        <BrandLogo />
      </header>
      <main className="route-state">
        <span className="loading-spinner" />
        <h2>Loading your Spotify library…</h2>
        <p>Fetching your profile and playlists.</p>
      </main>
    </>
  )
}

function CuratePage() {
  const { profile, playlists: initialPlaylists } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { showToast } = useToast()

  const userId = profile.id ?? ''
  const accountId = profile.account_id || userId
  const displayName = profile.display_name || 'Music lover'
  const canModifyPlaylists = spotifySession.canModifyPlaylists

  const [playlists, setPlaylists] =
    useState<ReadonlyArray<NormalizedPlaylist>>(initialPlaylists)

  useEffect(() => {
    setPlaylists(initialPlaylists)
  }, [initialPlaylists])

  const editablePlaylists = useMemo(
    () => playlists.filter((p) => p.ownerId === userId || p.collaborative),
    [playlists, userId],
  )

  const initialSelection = useMemo(() => {
    const saved = loadSelection(accountId)
    const validSource = (id: string | undefined): id is string =>
      Boolean(id) && (id === 'liked' || playlists.some((p) => p.id === id))
    const validTarget = (id: string | undefined, src: string): id is string =>
      Boolean(id) && id !== src && editablePlaylists.some((p) => p.id === id)

    const src = validSource(search.source)
      ? search.source
      : validSource(saved?.source)
        ? saved.source
        : 'liked'

    const tgt = validTarget(search.target, src)
      ? search.target
      : validTarget(saved?.target, src)
        ? saved.target
        : (editablePlaylists.find((p) => p.id !== src)?.id ?? '')

    return {
      source: src,
      target: tgt,
      shuffleSeed: saved?.shuffleSeed ?? null,
    }
  }, [accountId, editablePlaylists, playlists, search.source, search.target])

  const sourceId = initialSelection.source
  const targetId = initialSelection.target

  const [shuffleSeed, setShuffleSeed] = useState<number | null>(
    initialSelection.shuffleSeed,
  )
  const [tracks, setTracks] = useState<ReadonlyArray<NormalizedTrack>>([])
  const [targetIds, setTargetIds] = useState<Set<string>>(() => new Set())
  const [progress, setProgress] = useState<Progress>(() =>
    loadProgress(accountId, sourceId, targetId),
  )
  const [filter, setFilter] = useState<Filter>('remaining')
  const [query, setQuery] = useState('')
  const [loadingPair, setLoadingPair] = useState(true)
  const [loadProgressText, setLoadProgressText] = useState<string | null>(null)
  const [pairReady, setPairReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [undoEntry, setUndoEntry] = useState<UndoAction | null>(null)
  const [activeModal, setActiveModal] = useState<ActiveModal>(null)
  const [playback, setPlayback] = useState<PlaybackSnapshot>(INITIAL_PLAYBACK)

  // Save selection & keep URL in sync when resolved
  useEffect(() => {
    saveSelection(accountId, {
      source: sourceId,
      target: targetId,
      shuffleSeed,
    })
    if (
      search.source !== sourceId ||
      search.target !== (targetId || undefined)
    ) {
      void navigate({
        search: {
          source: sourceId,
          target: targetId || undefined,
        },
        replace: true,
      })
    }
  }, [
    accountId,
    navigate,
    search.source,
    search.target,
    shuffleSeed,
    sourceId,
    targetId,
  ])

  const orderedTracks = useMemo(
    () => orderTracks(tracks, shuffleSeed),
    [shuffleSeed, tracks],
  )

  const orderedRemaining = useMemo(
    () => filterTracks(orderedTracks, progress, targetIds, 'remaining'),
    [orderedTracks, progress, targetIds],
  )

  const addedTracks = useMemo(
    () => filterTracks(tracks, progress, targetIds, 'added'),
    [progress, targetIds, tracks],
  )
  const skippedTracks = useMemo(
    () => filterTracks(tracks, progress, targetIds, 'skipped'),
    [progress, targetIds, tracks],
  )
  const listenedTracks = useMemo(
    () => filterTracks(tracks, progress, targetIds, 'listened'),
    [progress, targetIds, tracks],
  )

  const currentTrack = useMemo(() => {
    if (orderedRemaining.length === 0) return undefined
    if (playback.currentTrackId) {
      const found = orderedRemaining.find(
        (t) => t.id === playback.currentTrackId,
      )
      if (found) return found
    }
    return orderedRemaining[0]
  }, [orderedRemaining, playback.currentTrackId])

  const shownTracks = useMemo(() => {
    const list =
      filter === 'remaining'
        ? orderedRemaining
        : filter === 'added'
          ? addedTracks
          : filter === 'skipped'
            ? skippedTracks
            : listenedTracks
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return list
    return list.filter((t) =>
      `${t.name} ${t.artists.map((a) => a.name).join(' ')} ${t.album.name}`
        .toLowerCase()
        .includes(trimmed),
    )
  }, [
    addedTracks,
    filter,
    listenedTracks,
    orderedRemaining,
    query,
    skippedTracks,
  ])

  // Refs for PlaybackController callbacks so the controller never sees stale closures
  const remainingRef = useRef(orderedRemaining)
  remainingRef.current = orderedRemaining
  const currentTrackRef = useRef(currentTrack)
  currentTrackRef.current = currentTrack
  const progressRef = useRef(progress)
  progressRef.current = progress

  const handleAuthExpired = useCallback(
    (reason: string) => {
      spotifySession.disconnect()
      void navigate({
        to: '/setup',
        search: { error: reason },
        replace: true,
      })
    },
    [navigate],
  )

  const handleError = useCallback(
    (error: unknown) => {
      const msg = formatSpotifyError(error)
      showToast(msg, true)
      if (error instanceof AuthorizationRequired) {
        handleAuthExpired(msg)
      }
    },
    [handleAuthExpired, showToast],
  )

  const commitDecision = useCallback(
    (track: NormalizedTrack, status: Decision) => {
      const prev = progressRef.current[track.id]
      const next: Progress = {
        ...progressRef.current,
        [track.id]: { status, at: Date.now() },
      }
      progressRef.current = next
      setProgress(next)
      setUndoEntry({ kind: 'decision', track, previous: prev })
      saveProgress(accountId, sourceId, targetId, next)
    },
    [accountId, sourceId, targetId],
  )

  const controllerRef = useRef<PlaybackController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = new PlaybackController({
      getRemainingQueue: () => remainingRef.current,
      getCurrentTrack: () => currentTrackRef.current,
      onSnapshot: (snapshot) => setPlayback(snapshot),
      onObservedDecision: (track, decision) => commitDecision(track, decision),
      onAuthExpired: (err) => handleAuthExpired(err.message),
      onError: (err) => handleError(err),
    })
  }

  useEffect(() => {
    const controller = controllerRef.current
    return () => {
      controller?.dispose()
      controllerRef.current = null
    }
  }, [])

  // Subscribe to session-wide rate limit & expiration events
  useEffect(() => {
    const unsubRate = spotifySession.onRateLimit((seconds) => {
      showToast(
        `Spotify rate limit reached. Pausing requests for ~${seconds}s.`,
        true,
      )
    })
    const unsubExpired = spotifySession.onExpired((reason) => {
      controllerRef.current?.stop()
      handleAuthExpired(reason)
    })
    return () => {
      unsubRate()
      unsubExpired()
    }
  }, [handleAuthExpired, showToast])

  // Load source + target tracks whenever the pairing or reloadNonce changes
  useEffect(() => {
    const abort = new AbortController()
    controllerRef.current?.stop()
    setLoadingPair(true)
    setPairReady(false)
    setLoadProgressText(null)
    setUndoEntry(null)
    setFilter('remaining')
    setQuery('')

    const load = async () => {
      try {
        const [sourceTracks, targetTracks] = await Promise.all([
          fetchSourceTracks(sourceId, {
            signal: abort.signal,
            onProgress: (loaded, total) => {
              if (!abort.signal.aborted) {
                setLoadProgressText(
                  total
                    ? `Loaded ${loaded} of ${total} source songs…`
                    : `Loaded ${loaded} source songs…`,
                )
              }
            },
          }),
          targetId
            ? fetchSourceTracks(targetId, { signal: abort.signal })
            : Promise.resolve([]),
        ])
        if (abort.signal.aborted) return

        const loadedProgress = loadProgress(accountId, sourceId, targetId)
        const nextTargetIds = new Set(targetTracks.map((t) => t.id))
        setTracks(sourceTracks)
        setTargetIds(nextTargetIds)
        setPlaylists((prev) =>
          prev.map((p) => {
            if (targetId && p.id === targetId) {
              return { ...p, totalItems: nextTargetIds.size }
            }
            if (sourceId !== 'liked' && p.id === sourceId) {
              return { ...p, totalItems: sourceTracks.length }
            }
            return p
          }),
        )
        setProgress(loadedProgress)
        progressRef.current = loadedProgress
        setPairReady(true)
      } catch (error) {
        if (abort.signal.aborted) return
        handleError(error)
      } finally {
        if (!abort.signal.aborted) {
          setLoadingPair(false)
          setLoadProgressText(null)
        }
      }
    }

    void load()
    return () => {
      abort.abort()
    }
  }, [accountId, handleError, reloadNonce, sourceId, targetId])

  const switchPair = useCallback(
    async (nextSource: string, nextTarget: string) => {
      if (busy || loadingPair) return
      if (nextSource === nextTarget) {
        showToast('Choose different source and target playlists.', true)
        return
      }
      await controllerRef.current?.pauseIfPlaying()
      controllerRef.current?.stop()
      void navigate({
        search: {
          source: nextSource,
          target: nextTarget || undefined,
        },
      })
    },
    [busy, loadingPair, navigate, showToast],
  )

  const handleTogglePlay = useCallback(async () => {
    if (busy || loadingPair || !pairReady || !targetId) return
    const queue = remainingRef.current
    if (queue.length === 0) return
    const current = currentTrackRef.current
    const startIdx = current ? queue.findIndex((t) => t.id === current.id) : 0
    const rotated =
      startIdx > 0
        ? [...queue.slice(startIdx), ...queue.slice(0, startIdx)]
        : queue

    setBusy(true)
    try {
      await controllerRef.current?.togglePlayPause(rotated)
    } catch (error) {
      handleError(error)
    } finally {
      setBusy(false)
    }
  }, [busy, handleError, loadingPair, pairReady, targetId])

  const handlePlayFrom = useCallback(
    async (trackId: string) => {
      if (busy || loadingPair || !pairReady || !targetId) return
      const queue = remainingRef.current
      const idx = queue.findIndex((t) => t.id === trackId)
      if (idx < 0) return
      const rotated = [...queue.slice(idx), ...queue.slice(0, idx)]

      setBusy(true)
      try {
        await controllerRef.current?.playQueue(rotated)
      } catch (error) {
        handleError(error)
      } finally {
        setBusy(false)
      }
    },
    [busy, handleError, loadingPair, pairReady, targetId],
  )

  const handleSkipCurrent = useCallback(async () => {
    if (busy || loadingPair || !pairReady || !targetId) return
    const track = currentTrackRef.current
    if (!track) return

    const wasPlaying = playback.status === 'playing'
    setBusy(true)
    try {
      commitDecision(track, 'skipped')
      const nextQueue = remainingRef.current.filter((t) => t.id !== track.id)
      if (wasPlaying && nextQueue.length > 0) {
        await controllerRef.current?.playQueue(nextQueue)
      } else {
        if (wasPlaying) await controllerRef.current?.pauseIfPlaying()
        controllerRef.current?.stop()
        controllerRef.current?.setCurrentTrackId(nextQueue[0]?.id ?? null)
      }
      showToast(`“${track.name}” skipped.`)
    } catch (error) {
      controllerRef.current?.stop()
      handleError(error)
    } finally {
      setBusy(false)
    }
  }, [
    busy,
    commitDecision,
    handleError,
    loadingPair,
    pairReady,
    playback.status,
    showToast,
    targetId,
  ])

  const handleAddTrack = useCallback(
    async (track: NormalizedTrack) => {
      if (busy || loadingPair || !pairReady || !targetId) return
      if (!canModifyPlaylists) {
        showToast(
          'Reconnect with playlist-modify permissions to add songs directly.',
          true,
        )
        return
      }
      const isCurrentTrack = currentTrackRef.current?.id === track.id
      const wasPlaying = playback.status === 'playing'
      const prevProgress = progressRef.current[track.id]

      setBusy(true)
      try {
        await addTrackToTargetPlaylist(targetId, track.uri)
        const nextTargetIds = new Set(targetIds)
        nextTargetIds.add(track.id)
        setTargetIds(nextTargetIds)
        setPlaylists((currentPlaylists) =>
          currentPlaylists.map((p) =>
            p.id === targetId ? { ...p, totalItems: nextTargetIds.size } : p,
          ),
        )
        if (prevProgress) {
          const nextProg = { ...progressRef.current }
          delete nextProg[track.id]
          progressRef.current = nextProg
          setProgress(nextProg)
          saveProgress(accountId, sourceId, targetId, nextProg)
        }
        setUndoEntry({ kind: 'added', track, previous: prevProgress })

        if (isCurrentTrack) {
          const nextQueue = remainingRef.current.filter(
            (t) => t.id !== track.id,
          )
          if (wasPlaying && nextQueue.length > 0) {
            await controllerRef.current?.playQueue(nextQueue)
          } else if (wasPlaying) {
            await controllerRef.current?.pauseIfPlaying()
            controllerRef.current?.stop()
          } else {
            controllerRef.current?.setCurrentTrackId(nextQueue[0]?.id ?? null)
          }
        }

        const targetPlaylistName =
          playlists.find((p) => p.id === targetId)?.name || 'target playlist'
        showToast(`Added “${track.name}” to ${targetPlaylistName}.`)
      } catch (error) {
        handleError(error)
      } finally {
        setBusy(false)
      }
    },
    [
      accountId,
      busy,
      canModifyPlaylists,
      handleError,
      loadingPair,
      pairReady,
      playback.status,
      playlists,
      showToast,
      sourceId,
      targetId,
      targetIds,
    ],
  )

  const handleAddCurrent = useCallback(() => {
    const track = currentTrackRef.current
    if (track) void handleAddTrack(track)
  }, [handleAddTrack])

  const handleUndo = useCallback(async () => {
    if (!undoEntry || busy || loadingPair) return
    if (playback.status === 'playing') {
      showToast('Pause playback before undoing.', true)
      return
    }
    setBusy(true)
    try {
      if (undoEntry.kind === 'added') {
        await removeTrackFromTargetPlaylist(targetId, undoEntry.track.uri)
        const nextTargetIds = new Set(targetIds)
        nextTargetIds.delete(undoEntry.track.id)
        setTargetIds(nextTargetIds)
        setPlaylists((currentPlaylists) =>
          currentPlaylists.map((p) =>
            p.id === targetId ? { ...p, totalItems: nextTargetIds.size } : p,
          ),
        )
      }

      const nextProg = { ...progressRef.current }
      if (undoEntry.previous) {
        nextProg[undoEntry.track.id] = undoEntry.previous
      } else {
        delete nextProg[undoEntry.track.id]
      }
      progressRef.current = nextProg
      setProgress(nextProg)
      saveProgress(accountId, sourceId, targetId, nextProg)

      controllerRef.current?.stop()
      controllerRef.current?.setCurrentTrackId(undoEntry.track.id)
      setFilter('remaining')
      setUndoEntry(null)
      showToast(
        undoEntry.kind === 'added'
          ? `Removed “${undoEntry.track.name}” from target and returned it to Remaining.`
          : `Returned “${undoEntry.track.name}” to Remaining.`,
      )
    } catch (error) {
      handleError(error)
    } finally {
      setBusy(false)
    }
  }, [
    accountId,
    busy,
    handleError,
    loadingPair,
    playback.status,
    showToast,
    sourceId,
    targetId,
    targetIds,
    undoEntry,
  ])

  const handleRequeueTrack = useCallback(
    (trackId: string) => {
      if (busy || loadingPair) return
      const nextProg = { ...progressRef.current }
      delete nextProg[trackId]
      progressRef.current = nextProg
      setProgress(nextProg)
      saveProgress(accountId, sourceId, targetId, nextProg)
      showToast('Moved song back to Remaining.')
    },
    [accountId, busy, loadingPair, showToast, sourceId, targetId],
  )

  const handleResetProgress = useCallback(() => {
    if (
      busy ||
      loadingPair ||
      playback.status === 'playing' ||
      !pairReady ||
      !targetId
    ) {
      showToast(
        'Pause playback and wait for pending actions before resetting.',
        true,
      )
      return
    }
    if (
      !window.confirm(
        'Reset skipped and listened decisions for this source/target pair? Existing target playlist songs remain excluded.',
      )
    ) {
      return
    }
    progressRef.current = {}
    setProgress({})
    saveProgress(accountId, sourceId, targetId, {})
    controllerRef.current?.stop()
    setUndoEntry(null)
    setFilter('remaining')
    setQuery('')
    showToast('Local progress reset. Your Spotify playlists are unchanged.')
  }, [
    accountId,
    busy,
    loadingPair,
    pairReady,
    playback.status,
    showToast,
    sourceId,
    targetId,
  ])

  const handleRefresh = useCallback(async () => {
    if (busy || loadingPair) return
    await controllerRef.current?.pauseIfPlaying()
    try {
      const freshPlaylists = await fetchAllUserPlaylists()
      setPlaylists(freshPlaylists)
    } catch (error) {
      handleError(error)
    }
    setReloadNonce((n) => n + 1)
    showToast('Refreshing playlists from Spotify…')
  }, [busy, handleError, loadingPair, showToast])

  const handleToggleShuffle = useCallback(() => {
    setShuffleSeed((prev) =>
      prev === null ? Math.floor(Math.random() * 0x7fffffff) + 1 : null,
    )
  }, [])

  const handleCreateTargetPlaylist = useCallback(
    async (name: string) => {
      try {
        const created = await createTargetPlaylist({
          name,
          public: false,
          description: 'Curated with Curate for Spotify',
        })
        setPlaylists((prev) => [created, ...prev])
        showToast(`Created playlist “${created.name}”.`)
        await switchPair(sourceId, created.id)
      } catch (error) {
        handleError(error)
      }
    },
    [handleError, showToast, sourceId, switchPair],
  )

  const handleSelectDevice = useCallback(
    async (deviceId: string) => {
      setBusy(true)
      try {
        const queue = remainingRef.current
        const current = currentTrackRef.current
        const idx = current ? queue.findIndex((t) => t.id === current.id) : 0
        const rotated =
          idx > 0 ? [...queue.slice(idx), ...queue.slice(0, idx)] : queue
        await controllerRef.current?.selectDevice(deviceId, rotated)
      } catch (error) {
        handleError(error)
      } finally {
        setBusy(false)
      }
    },
    [handleError],
  )

  const handleRefreshDevices = useCallback(async () => {
    try {
      const found = await controllerRef.current?.refreshDevices()
      if (!found || found.length === 0) {
        showToast(
          'Still no Spotify devices found. Open Spotify and play/pause anything once to wake it up.',
          true,
        )
      }
    } catch (error) {
      handleError(error)
    }
  }, [handleError, showToast])

  const handleSeek = useCallback(
    (positionMs: number) => {
      void controllerRef.current?.seek(positionMs).catch(handleError)
    },
    [handleError],
  )

  const handleDisconnect = useCallback(() => {
    controllerRef.current?.stop()
    spotifySession.disconnect()
    showToast('Disconnected. Your local progress is safe.')
    void navigate({ to: '/setup', replace: true })
  }, [navigate, showToast])

  const handleReauthorizeForWrite = useCallback(async () => {
    const clientId = getSavedClientId()
    if (!clientId) {
      handleDisconnect()
      return
    }
    try {
      await startSpotifyAuth(clientId, { showDialog: true })
    } catch (error) {
      handleError(error)
    }
  }, [handleDisconnect, handleError])

  const handleExportData = useCallback(() => {
    const bundle = exportAccountData(accountId)
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `curate-progress-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast('Exported your Curate progress backup.')
  }, [accountId, showToast])

  const handleImportData = useCallback(
    (jsonText: string) => {
      try {
        const result = importAccountData(accountId, jsonText)
        const reloaded = loadProgress(accountId, sourceId, targetId)
        progressRef.current = reloaded
        setProgress(reloaded)
        showToast(
          `Imported ${result.decisionsImported} decisions across ${result.pairsImported} playlist pairs.`,
        )
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : 'Could not import backup.',
          true,
        )
      }
    },
    [accountId, showToast, sourceId, targetId],
  )

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        activeModal !== null ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat
      ) {
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target?.closest('input, textarea, select, button, a, [contenteditable]')
      ) {
        return
      }
      if (event.code === 'Space') {
        event.preventDefault()
        void handleTogglePlay()
      } else if (event.code === 'ArrowRight') {
        event.preventDefault()
        void handleSkipCurrent()
      } else if (event.code === 'KeyA') {
        event.preventDefault()
        handleAddCurrent()
      } else if (event.code === 'KeyZ') {
        event.preventDefault()
        void handleUndo()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    activeModal,
    handleAddCurrent,
    handleSkipCurrent,
    handleTogglePlay,
    handleUndo,
  ])

  const sourcePlaylist = playlists.find((p) => p.id === sourceId)
  const targetPlaylist = playlists.find((p) => p.id === targetId)
  const sourceName =
    sourceId === 'liked'
      ? 'Liked Songs'
      : sourcePlaylist?.name || 'Source playlist'
  const targetName = targetPlaylist?.name || 'Choose a playlist'

  const completed = tracks.length - orderedRemaining.length
  const percent = tracks.length
    ? Math.round((completed / tracks.length) * 100)
    : 0

  const sessions = useMemo(
    () => (activeModal === 'sessions' ? listSessions(accountId) : []),
    [accountId, activeModal],
  )

  return (
    <>
      <header className="topbar">
        <a
          className="brand-link"
          href="#top"
          aria-label="Curate home"
          onClick={(e) => {
            e.preventDefault()
            window.scrollTo({ top: 0, behavior: 'smooth' })
          }}
        >
          <BrandLogo />
        </a>
        <div className="header-actions">
          <span className="mode-badge">
            <i />
            Spotify connected
          </span>
          <button
            type="button"
            className="profile-button"
            onClick={() => setActiveModal('account')}
          >
            <span className="avatar">
              {displayName[0]?.toUpperCase() || 'M'}
            </span>
            <span>{displayName}</span>
            <Icon name="down" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setActiveModal('menu')}
            aria-label="Open options menu"
          >
            <Icon name="dots" />
          </button>
        </div>
      </header>

      <main className="playlist-page">
        <section className="intro">
          <div>
            <div className="eyebrow">
              <span /> ONE SONG AT A TIME
            </div>
            <h1>
              Your playlists. <em>Your pace.</em>
            </h1>
            <p>
              Listen, add favorites straight to your target playlist, or skip
              for later. Every pairing remembers where you left off.
            </p>
          </div>
          <button
            type="button"
            className="text-button how-button"
            onClick={() => setActiveModal('help')}
          >
            How it works <Icon name="arrow" />
          </button>
        </section>

        {!canModifyPlaylists ? (
          <div
            className="scope-banner"
            role="status"
          >
            <span>
              Your Spotify session does not include playlist-modify permissions.
              Reconnect to add songs directly from Curate.
            </span>
            <button
              type="button"
              className="button primary"
              onClick={() => void handleReauthorizeForWrite()}
            >
              Grant permission
            </button>
          </div>
        ) : null}

        <section
          className="selection-row"
          aria-label="Choose your playlists"
        >
          <button
            type="button"
            className="selection-card"
            disabled={busy || loadingPair}
            onClick={() => setActiveModal('source')}
          >
            <span className="selection-art liked-art">
              {sourceId === 'liked' ? (
                <Icon name="heart" />
              ) : sourcePlaylist?.imageUrl ? (
                <img
                  src={sourcePlaylist.imageUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : (
                <Icon name="music" />
              )}
            </span>
            <span className="selection-text">
              <span className="eyebrow">LISTENING FROM</span>
              <strong>{sourceName}</strong>
              <span>
                {loadingPair ? 'Loading songs…' : `${tracks.length} songs`}{' '}
                <b>·</b> Source playlist
              </span>
            </span>
            <Icon name="down" />
          </button>

          <span className="flow-arrow">
            <Icon name="arrow" />
          </span>

          <button
            type="button"
            className="selection-card target-card"
            disabled={busy || loadingPair}
            onClick={() => setActiveModal('target')}
          >
            <span className="selection-art target-art">
              {targetPlaylist?.imageUrl ? (
                <img
                  src={targetPlaylist.imageUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : (
                <Icon name="music" />
              )}
            </span>
            <span className="selection-text">
              <span className="eyebrow">BUILDING YOUR</span>
              <strong>{targetName}</strong>
              <span>
                {targetId ? (
                  <>
                    {targetIds.size} songs <b>·</b> Target playlist
                  </>
                ) : (
                  'Select a destination for your favorites'
                )}
              </span>
            </span>
            <Icon name="down" />
          </button>
        </section>

        <section
          className="progress-strip"
          aria-label="Session progress"
        >
          <div className="progress-heading">
            <span className="progress-dot" />
            <strong>Your listening journey</strong>
            <span>
              {completed} of {tracks.length} reviewed
            </span>
          </div>
          <div className="progress-track">
            <div style={{ width: `${percent}%` }} />
          </div>
          <span className="progress-percent">{percent}%</span>
          <span className="autosave">
            <Icon name="shield" /> Saved on this device
          </span>
        </section>

        <div className="workspace">
          <PlayerPanel
            loading={loadingPair}
            loadProgressText={loadProgressText}
            pairReady={pairReady}
            hasTarget={Boolean(targetId)}
            hasAnyTracks={tracks.length > 0}
            currentTrack={currentTrack}
            playback={playback}
            busy={busy}
            canModifyPlaylists={canModifyPlaylists}
            targetName={targetName}
            onTogglePlay={() => void handleTogglePlay()}
            onAddCurrent={handleAddCurrent}
            onSkipCurrent={() => void handleSkipCurrent()}
            onSeek={handleSeek}
            onSelectDevice={(id) => void handleSelectDevice(id)}
            onRefreshDevices={() => void handleRefreshDevices()}
            onOpenPicker={(kind) => setActiveModal(kind)}
            onRetryLoad={() => setReloadNonce((n) => n + 1)}
          />

          <QueuePanel
            loading={loadingPair}
            busy={busy}
            isPlaying={playback.status === 'playing'}
            pairReady={pairReady}
            hasTarget={Boolean(targetId)}
            canModifyPlaylists={canModifyPlaylists}
            filter={filter}
            query={query}
            shuffled={shuffleSeed !== null}
            canUndo={undoEntry !== null}
            counts={{
              remaining: orderedRemaining.length,
              added: addedTracks.length,
              skipped: skippedTracks.length,
              listened: listenedTracks.length,
            }}
            shownTracks={shownTracks}
            currentTrackId={currentTrack?.id ?? null}
            onFilterChange={setFilter}
            onQueryChange={setQuery}
            onToggleShuffle={handleToggleShuffle}
            onRefresh={() => void handleRefresh()}
            onResetProgress={handleResetProgress}
            onUndo={() => void handleUndo()}
            onPlayFrom={(id) => void handlePlayFrom(id)}
            onAddTrack={(track) => void handleAddTrack(track)}
            onRequeueTrack={handleRequeueTrack}
          />
        </div>

        <section className="bottom-note">
          <span className="note-circle">
            <Icon name="headphones" />
          </span>
          <div>
            <strong>Pick up right where you left off.</strong>
            <p>
              Added, skipped, and listened songs stay out of your queue for this
              pairing. Your source playlist stays as it is.
            </p>
          </div>
          <SpotifyAttribution />
        </section>

        <footer className="page-footer">
          <span>Thoughtfully curated. Entirely yours.</span>
          <span>
            Quick keys <kbd>Space</kbd> play / pause <kbd>A</kbd> add{' '}
            <kbd>→</kbd> skip <kbd>Z</kbd> undo
          </span>
        </footer>
      </main>

      <PairModals
        activeModal={activeModal}
        onClose={() => setActiveModal(null)}
        onOpenModal={(next) => setActiveModal(next)}
        displayName={displayName}
        userId={userId}
        playlists={playlists}
        sourceId={sourceId}
        targetId={targetId}
        canModifyPlaylists={canModifyPlaylists}
        sessions={sessions}
        busy={busy}
        onSelectSource={(nextSource) => {
          const nextTarget =
            nextSource === targetId
              ? (editablePlaylists.find((p) => p.id !== nextSource)?.id ?? '')
              : targetId
          void switchPair(nextSource, nextTarget)
        }}
        onSelectTarget={(nextTarget) => void switchPair(sourceId, nextTarget)}
        onCreateTargetPlaylist={handleCreateTargetPlaylist}
        onSelectSession={(nextSource, nextTarget) =>
          void switchPair(nextSource, nextTarget)
        }
        onDisconnect={handleDisconnect}
        onExportData={handleExportData}
        onImportData={handleImportData}
      />
    </>
  )
}
