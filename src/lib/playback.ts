import { SpotifyHttpError } from '../spotify'
import { AuthorizationRequired } from './auth'
import { matchPlaybackTrack, observedDecision } from './queue'
import {
  fetchCurrentlyPlayingFallback,
  fetchDevices,
  fetchPlaybackState,
  pauseSpotifyPlayback,
  playTracksOnSpotify,
  seekSpotifyPlayback,
  transferToDevice,
} from './spotify-runtime'
import type { Device, PlaybackState } from '../spotify'
import type { Decision, PlaybackSample } from './queue'
import type { NormalizedTrack } from './spotify-runtime'

export type PlaybackSyncStatus =
  | 'idle'
  | 'starting'
  | 'playing'
  | 'paused'
  | 'reconnecting'
  | 'outside_queue'
  | 'no_device'

export interface PlaybackSnapshot {
  readonly status: PlaybackSyncStatus
  readonly currentTrackId: string | null
  readonly positionMs: number
  readonly deviceName: string
  readonly deviceId: string | null
  readonly devices: ReadonlyArray<Device>
  readonly consecutiveMisses: number
  readonly outsideTrackName: string
}

export interface PlaybackControllerCallbacks {
  readonly getRemainingQueue: () => ReadonlyArray<NormalizedTrack>
  readonly getCurrentTrack: () => NormalizedTrack | undefined
  readonly onSnapshot: (snapshot: PlaybackSnapshot) => void
  readonly onObservedDecision: (
    track: NormalizedTrack,
    decision: Decision,
  ) => void
  readonly onAuthExpired: (error: AuthorizationRequired) => void
  readonly onError: (error: unknown) => void
}

const ACTIVE_POLL_MS = 3_000
const HIDDEN_POLL_MS = 10_000
const MAX_BACKOFF_MS = 8_000
const MISSES_BEFORE_RECONNECTING = 3
const COMMAND_GRACE_MS = 1_600

export class PlaybackController {
  private callbacks: PlaybackControllerCallbacks
  private status: PlaybackSyncStatus = 'idle'
  private currentTrackId: string | null = null
  private positionMs = 0
  private deviceName = ''
  private deviceId: string | null = null
  private devices: ReadonlyArray<Device> = []
  private consecutiveMisses = 0
  private outsideTrackName = ''

  private lastSample: PlaybackSample | null = null
  private lastSampleCompleted = false
  private lastReading: {
    readonly id: string | null
    readonly timestamp: number
    readonly device?: string
  } | null = null
  private outsideConfirmCount = 0
  private commandGraceUntil = 0

  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private pollAbort: AbortController | null = null
  private pollingActive = false
  private pollInFlight = false
  private disposed = false

  constructor(callbacks: PlaybackControllerCallbacks) {
    this.callbacks = callbacks
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    document.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
  }

  getSnapshot(): PlaybackSnapshot {
    return {
      status: this.status,
      currentTrackId: this.currentTrackId,
      positionMs: this.positionMs,
      deviceName: this.deviceName,
      deviceId: this.deviceId,
      devices: this.devices,
      consecutiveMisses: this.consecutiveMisses,
      outsideTrackName: this.outsideTrackName,
    }
  }

  private emit(): void {
    if (this.disposed) return
    this.callbacks.onSnapshot(this.getSnapshot())
  }

  setCurrentTrackId(id: string | null): void {
    this.currentTrackId = id
    if (this.status === 'idle') {
      this.positionMs = 0
    }
    this.emit()
  }

  stop(): void {
    this.pollingActive = false
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.pollAbort?.abort()
    this.pollAbort = null
    this.pollInFlight = false

    this.status = 'idle'
    this.positionMs = 0
    this.deviceName = ''
    this.consecutiveMisses = 0
    this.lastSample = null
    this.lastSampleCompleted = false
    this.lastReading = null
    this.outsideConfirmCount = 0
    this.outsideTrackName = ''
    this.emit()
  }

  private startLoops(): void {
    if (this.disposed) return
    this.pollingActive = true

    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => {
        if (this.status !== 'playing') return
        const track = this.callbacks.getCurrentTrack()
        if (!track) return
        if (this.lastSample?.playing) {
          const estimated =
            this.lastSample.position + (Date.now() - this.lastSample.at)
          this.positionMs = Math.min(estimated, track.duration_ms)
          this.emit()
        }
      }, 500)
    }

    this.scheduleNextPoll(ACTIVE_POLL_MS)
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.pollingActive || this.disposed) return
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.pollOnce()
    }, delayMs)
  }

  private handleVisibilityChange = (): void => {
    if (!this.pollingActive || this.disposed) return
    if (document.visibilityState === 'visible') {
      if (this.pollTimer !== null) {
        clearTimeout(this.pollTimer)
        this.pollTimer = null
      }
      void this.pollOnce()
    }
  }

  private nextPollInterval(): number {
    if (document.hidden) return HIDDEN_POLL_MS
    if (this.consecutiveMisses > 0) {
      return Math.min(
        ACTIVE_POLL_MS + this.consecutiveMisses * 1_500,
        MAX_BACKOFF_MS,
      )
    }
    return ACTIVE_POLL_MS
  }

  private isPollingAlive(): boolean {
    return this.pollingActive && !this.disposed
  }

  private async pollOnce(): Promise<void> {
    if (!this.isPollingAlive() || this.pollInFlight) return
    this.pollInFlight = true
    const controller = new AbortController()
    this.pollAbort = controller

    try {
      let state = await fetchPlaybackState(controller.signal)
      if (!state && !controller.signal.aborted) {
        // Fallback to /me/player/currently-playing in case /me/player returned transient 204
        state = await fetchCurrentlyPlayingFallback(controller.signal)
      }
      if (controller.signal.aborted || !this.isPollingAlive()) return

      this.applyPlaybackState(state)
    } catch (error) {
      if (controller.signal.aborted || !this.isPollingAlive()) return
      if (error instanceof AuthorizationRequired) {
        this.stop()
        this.callbacks.onAuthExpired(error)
        return
      }
      this.handleTransientMiss()
    } finally {
      this.pollInFlight = false
      if (this.pollAbort === controller) {
        this.pollAbort = null
      }
      if (this.isPollingAlive()) {
        this.scheduleNextPoll(this.nextPollInterval())
      }
    }
  }

  private handleTransientMiss(): void {
    this.consecutiveMisses++
    // Keep lastSample intact so we can still detect track completion when sync recovers!
    if (
      this.consecutiveMisses >= MISSES_BEFORE_RECONNECTING &&
      this.status !== 'reconnecting' &&
      this.status !== 'outside_queue' &&
      this.status !== 'no_device'
    ) {
      this.status = 'reconnecting'
      this.emit()
    }
  }

  private applyPlaybackState(data: PlaybackState | null): void {
    const now = Date.now()
    if (now < this.commandGraceUntil && !data?.item) {
      return
    }

    if (!data || !data.item) {
      // Check if the previous track likely finished right before a 204
      const current = this.callbacks.getCurrentTrack()
      if (
        current &&
        this.lastSample &&
        observedDecision(current, this.lastSample, {
          id: null,
          position: 0,
          playing: false,
          at: now,
        }) === 'listened'
      ) {
        this.callbacks.onObservedDecision(current, 'listened')
        this.lastSample = null
        this.lastSampleCompleted = false
      }
      this.handleTransientMiss()
      return
    }

    const reportedDevice = data.device?.name ?? ''
    const reportedDeviceId = data.device?.id ?? null
    const reportedItem = data.item
    const reportedId = reportedItem.id ?? reportedItem.uri ?? null

    // Ignore out-of-order timestamps from the same device
    const sameDeviceReading =
      this.lastReading &&
      (!reportedDevice ||
        !this.lastReading.device ||
        reportedDevice === this.lastReading.device)
        ? this.lastReading
        : null

    if (
      sameDeviceReading &&
      typeof data.timestamp === 'number' &&
      data.timestamp < sameDeviceReading.timestamp
    ) {
      return
    }

    const queue = this.callbacks.getRemainingQueue()
    const current = this.callbacks.getCurrentTrack()
    const match = matchPlaybackTrack(queue, reportedItem, current)

    if (!match) {
      // Ignore ads or stale pre-skip readings during command grace
      const isAd = data.currently_playing_type === 'ad'
      const isStalePreSkip =
        now < this.commandGraceUntil ||
        (sameDeviceReading &&
          reportedId === sameDeviceReading.id &&
          data.timestamp === sameDeviceReading.timestamp)

      if (isAd || isStalePreSkip) {
        return
      }

      this.outsideConfirmCount++
      if (this.outsideConfirmCount < 2) {
        return
      }

      const outsideSample: PlaybackSample = {
        id: reportedId,
        position: data.progress_ms ?? 0,
        playing: data.is_playing ?? false,
        at: now,
      }

      if (
        current &&
        (this.lastSampleCompleted ||
          observedDecision(current, this.lastSample, outsideSample) ===
            'listened')
      ) {
        this.callbacks.onObservedDecision(current, 'listened')
      }

      this.consecutiveMisses = 0
      this.lastSample = null
      this.lastSampleCompleted = false
      this.deviceName = reportedDevice
      this.deviceId = reportedDeviceId
      this.outsideTrackName = reportedItem.name ?? ''
      this.status = 'outside_queue'
      this.emit()
      return
    }

    // Matched a track in our remaining queue!
    this.consecutiveMisses = 0
    this.outsideConfirmCount = 0
    this.outsideTrackName = ''
    if (typeof data.timestamp === 'number') {
      this.lastReading = {
        id: reportedId,
        timestamp: data.timestamp,
        device: reportedDevice || undefined,
      }
    }

    const sample: PlaybackSample = {
      id: match.id,
      position: data.progress_ms ?? 0,
      playing: data.is_playing ?? false,
      at: now,
    }

    const sameTrack = match.id === current?.id
    const observed = current
      ? observedDecision(current, this.lastSample, sample)
      : null
    const decision = sameTrack
      ? sample.playing
        ? null
        : observed
      : this.lastSampleCompleted
        ? 'listened'
        : observed

    if (current && decision) {
      this.callbacks.onObservedDecision(current, decision)
      if (sameTrack) {
        this.stop()
        return
      }
    }

    this.currentTrackId = match.id
    this.positionMs = sample.position
    this.deviceName = reportedDevice || this.deviceName
    this.deviceId = reportedDeviceId ?? this.deviceId
    this.status = sample.playing ? 'playing' : 'paused'
    this.lastSample = sample
    this.lastSampleCompleted =
      sameTrack && (this.lastSampleCompleted || observed === 'listened')
    this.emit()
  }

  async refreshDevices(): Promise<ReadonlyArray<Device>> {
    const devices = await fetchDevices()
    this.devices = devices
    this.emit()
    return devices
  }

  async selectDevice(
    deviceId: string,
    resumeQueue?: ReadonlyArray<NormalizedTrack>,
  ): Promise<void> {
    this.deviceId = deviceId
    const target = this.devices.find((d) => d.id === deviceId)
    if (target?.name) this.deviceName = target.name
    await transferToDevice(deviceId, false)
    if (resumeQueue && resumeQueue.length > 0) {
      await this.playQueue(resumeQueue, deviceId)
    } else {
      this.emit()
    }
  }

  async playQueue(
    queue: ReadonlyArray<NormalizedTrack>,
    preferredDeviceId?: string,
  ): Promise<void> {
    const batch = queue.slice(0, 50)
    if (batch.length === 0) {
      this.stop()
      return
    }
    const firstTrack = batch[0]

    this.pollAbort?.abort()
    this.status = 'starting'
    this.currentTrackId = firstTrack.id
    this.positionMs = 0
    this.emit()

    const uris = batch.map((t) => t.uri)
    const targetDevice = preferredDeviceId ?? this.deviceId ?? undefined

    try {
      await playTracksOnSpotify({
        deviceId: targetDevice,
        body: { uris, position_ms: 0 },
      })
    } catch (error) {
      if (error instanceof SpotifyHttpError && error.status === 404) {
        const recovered = await this.tryRecoverNoActiveDevice(uris)
        if (!recovered) return
      } else {
        this.status = 'idle'
        this.emit()
        throw error
      }
    }

    const now = Date.now()
    this.commandGraceUntil = now + COMMAND_GRACE_MS
    this.consecutiveMisses = 0
    this.outsideConfirmCount = 0
    this.lastSample = {
      id: firstTrack.id,
      position: 0,
      playing: true,
      at: now,
    }
    this.lastSampleCompleted = false
    this.status = 'playing'
    this.emit()
    this.startLoops()
  }

  private async tryRecoverNoActiveDevice(
    uris: ReadonlyArray<string>,
  ): Promise<boolean> {
    const devices = await fetchDevices()
    this.devices = devices
    const usable = devices.filter(
      (d): d is Device & { readonly id: string } =>
        typeof d.id === 'string' && d.id.length > 0 && !d.is_restricted,
    )

    if (usable.length === 1) {
      const only = usable[0]
      this.deviceId = only.id
      this.deviceName = only.name ?? ''
      await transferToDevice(only.id, false)
      await playTracksOnSpotify({
        deviceId: only.id,
        body: { uris, position_ms: 0 },
      })
      return true
    }

    this.status = 'no_device'
    this.emit()
    return false
  }

  async togglePlayPause(queue: ReadonlyArray<NormalizedTrack>): Promise<void> {
    if (
      this.status === 'idle' ||
      this.status === 'outside_queue' ||
      this.status === 'no_device'
    ) {
      await this.playQueue(queue)
      return
    }

    this.pollAbort?.abort()
    const shouldPause = this.status === 'playing'
    try {
      if (shouldPause) {
        await pauseSpotifyPlayback(this.deviceId ?? undefined)
      } else {
        await playTracksOnSpotify({ deviceId: this.deviceId ?? undefined })
      }
    } catch (error) {
      if (
        !shouldPause &&
        error instanceof SpotifyHttpError &&
        error.status === 404
      ) {
        await this.playQueue(queue)
        return
      }
      throw error
    }

    const now = Date.now()
    this.commandGraceUntil = now + COMMAND_GRACE_MS
    this.status = shouldPause ? 'paused' : 'playing'
    if (this.lastSample) {
      this.lastSample = {
        ...this.lastSample,
        playing: !shouldPause,
        position: this.positionMs,
        at: now,
      }
    }
    this.emit()
    this.startLoops()
  }

  async pauseIfPlaying(): Promise<void> {
    if (this.status !== 'playing') return
    try {
      await pauseSpotifyPlayback(this.deviceId ?? undefined)
    } catch {
      // Ignore pause errors on teardown/refresh.
    }
    this.status = 'paused'
    this.emit()
  }

  async seek(positionMs: number): Promise<void> {
    if (this.status !== 'playing' && this.status !== 'paused') return
    const clamped = Math.max(0, Math.round(positionMs))
    await seekSpotifyPlayback(clamped, this.deviceId ?? undefined)
    const now = Date.now()
    this.commandGraceUntil = now + COMMAND_GRACE_MS
    this.positionMs = clamped
    if (this.lastSample) {
      this.lastSample = {
        ...this.lastSample,
        position: clamped,
        at: now,
      }
    }
    this.emit()
  }
}
