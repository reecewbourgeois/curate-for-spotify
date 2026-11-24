import type { Progress, ProgressEntry } from './queue'

const PROGRESS_PREFIX = 'curate:progress:v1:'
const SELECTION_PREFIX = 'curate:selection:v1:'
const PAIRINGS_PREFIX = 'curate:pairings:v1:'

export interface SavedSelection {
  readonly source: string
  readonly target: string
  readonly shuffleSeed?: number | null
}

export interface SavedSessionSummary {
  readonly source: string
  readonly target: string
  readonly count: number
  readonly updatedAt: number
}

export interface ExportBundle {
  readonly version: 1
  readonly exportedAt: number
  readonly account: string
  readonly pairs: ReadonlyArray<{
    readonly source: string
    readonly target: string
    readonly progress: Progress
  }>
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function progressKey(
  account: string,
  source: string,
  target: string,
): string {
  return `${PROGRESS_PREFIX}${encodeURIComponent(account)}:${encodeURIComponent(source)}:${encodeURIComponent(target)}`
}

export function parseProgress(raw: string | null): Progress {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const entries: Array<[string, ProgressEntry]> = []
    for (const [id, value] of Object.entries(parsed)) {
      if (
        id &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        ((value as ProgressEntry).status === 'skipped' ||
          (value as ProgressEntry).status === 'listened') &&
        Number.isFinite((value as ProgressEntry).at)
      ) {
        entries.push([
          id,
          {
            status: (value as ProgressEntry).status,
            at: (value as ProgressEntry).at,
          },
        ])
      }
    }
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

export function loadProgress(
  account: string,
  source: string,
  target: string,
): Progress {
  if (!account || !source || !target) return {}
  return parseProgress(safeGet(progressKey(account, source, target)))
}

export function saveProgress(
  account: string,
  source: string,
  target: string,
  progress: Progress,
): boolean {
  if (!account || !source || !target) return false
  touchPairing(account, source, target)
  return safeSet(progressKey(account, source, target), JSON.stringify(progress))
}

export function loadSelection(account: string): SavedSelection | null {
  if (!account) return null
  const raw =
    safeGet(`${SELECTION_PREFIX}${encodeURIComponent(account)}`) ??
    safeGet(`curate:selection:${account}`)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as Partial<SavedSelection>
    if (
      typeof candidate.source !== 'string' ||
      typeof candidate.target !== 'string'
    ) {
      return null
    }
    return {
      source: candidate.source,
      target: candidate.target,
      shuffleSeed:
        typeof candidate.shuffleSeed === 'number'
          ? candidate.shuffleSeed
          : null,
    }
  } catch {
    return null
  }
}

export function saveSelection(
  account: string,
  selection: SavedSelection,
): boolean {
  if (!account) return false
  if (selection.source && selection.target) {
    touchPairing(account, selection.source, selection.target)
  }
  return safeSet(
    `${SELECTION_PREFIX}${encodeURIComponent(account)}`,
    JSON.stringify(selection),
  )
}

interface PairingMeta {
  readonly source: string
  readonly target: string
  readonly lastOpenedAt: number
}

function loadPairingsMeta(account: string): Array<PairingMeta> {
  const raw = safeGet(`${PAIRINGS_PREFIX}${encodeURIComponent(account)}`)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is PairingMeta =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as PairingMeta).source === 'string' &&
        typeof (item as PairingMeta).target === 'string' &&
        typeof (item as PairingMeta).lastOpenedAt === 'number',
    )
  } catch {
    return []
  }
}

export function touchPairing(
  account: string,
  source: string,
  target: string,
): void {
  if (!account || !source || !target) return
  const existing = loadPairingsMeta(account).filter(
    (p) => !(p.source === source && p.target === target),
  )
  existing.unshift({ source, target, lastOpenedAt: Date.now() })
  safeSet(
    `${PAIRINGS_PREFIX}${encodeURIComponent(account)}`,
    JSON.stringify(existing.slice(0, 50)),
  )
}

export function listSessions(account: string): Array<SavedSessionSummary> {
  if (!account) return []
  const byPair = new Map<string, SavedSessionSummary>()

  for (const meta of loadPairingsMeta(account)) {
    const prog = loadProgress(account, meta.source, meta.target)
    const entries = Object.values(prog)
    const latestDecision = entries.length
      ? Math.max(...entries.map((e) => e.at))
      : 0
    byPair.set(`${meta.source}::${meta.target}`, {
      source: meta.source,
      target: meta.target,
      count: entries.length,
      updatedAt: Math.max(meta.lastOpenedAt, latestDecision),
    })
  }

  try {
    const prefix = `${PROGRESS_PREFIX}${encodeURIComponent(account)}:`
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(prefix)) continue
      const parts = k.slice(prefix.length).split(':')
      if (parts.length !== 2) continue
      const source = decodeURIComponent(parts[0] ?? '')
      const target = decodeURIComponent(parts[1] ?? '')
      const prog = parseProgress(localStorage.getItem(k))
      const entries = Object.values(prog)
      if (!entries.length && !byPair.has(`${source}::${target}`)) continue
      const latest = entries.length ? Math.max(...entries.map((e) => e.at)) : 0
      const pairKey = `${source}::${target}`
      const existing = byPair.get(pairKey)
      byPair.set(pairKey, {
        source,
        target,
        count: entries.length,
        updatedAt: Math.max(existing?.updatedAt ?? 0, latest),
      })
    }
  } catch {
    // Ignore storage enumeration failure.
  }

  return Array.from(byPair.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function exportAccountData(account: string): ExportBundle {
  const sessions = listSessions(account)
  return {
    version: 1,
    exportedAt: Date.now(),
    account,
    pairs: sessions.map((s) => ({
      source: s.source,
      target: s.target,
      progress: loadProgress(account, s.source, s.target),
    })),
  }
}

export function importAccountData(
  account: string,
  rawJson: string,
): { readonly pairsImported: number; readonly decisionsImported: number } {
  const parsed: unknown = JSON.parse(rawJson)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Partial<ExportBundle>).version !== 1 ||
    !Array.isArray((parsed as Partial<ExportBundle>).pairs)
  ) {
    throw new Error('Invalid Curate backup file.')
  }
  const bundle = parsed as ExportBundle
  let pairsImported = 0
  let decisionsImported = 0

  for (const pair of bundle.pairs) {
    if (typeof pair.source !== 'string' || typeof pair.target !== 'string') {
      continue
    }
    const existing = loadProgress(account, pair.source, pair.target)
    const incoming = parseProgress(JSON.stringify(pair.progress))
    const merged: Progress = { ...existing }
    for (const [trackId, entry] of Object.entries(incoming)) {
      if (!entry) continue
      const prev = merged[trackId]
      if (!prev || entry.at >= prev.at) {
        merged[trackId] = entry
        decisionsImported++
      }
    }
    saveProgress(account, pair.source, pair.target, merged)
    pairsImported++
  }

  return { pairsImported, decisionsImported }
}
