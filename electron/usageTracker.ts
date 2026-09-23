import { app, powerMonitor } from 'electron'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'

type UsageStat = {
  totalMs: number
  lastUpdated: number
}

type UsageDay = {
  apps: Record<string, UsageStat>
  windows: Record<string, UsageStat & { app: string; title: string }>
}

type UsageStore = {
  dates: Record<string, UsageDay>
  current?: { app: string; title: string; windowKey: string }
  lastTick?: number
  lastDate?: string
}

export type UsageRange = 'today' | 'week' | 'month' | 'year' | 'all' | 'date'

export type UsageSummary = {
  range: UsageRange
  date: string
  current?: { app: string; title: string }
  trackingError?: string
  saveError?: string
  apps: Array<{ app: string; totalMs: number }>
  windows: Array<{ app: string; title: string; totalMs: number }>
}

const IDLE_THRESHOLD_SECONDS = 60
const TICK_INTERVAL_MS = 1000
const SAVE_INTERVAL_MS = 10000
// A missed OS event must not turn a long sleep or stalled lookup into usage.
const MAX_SAMPLE_GAP_MS = 5000

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateKey(key: string) {
  const [year, month, day] = key.split('-').map((value) => Number(value))
  return new Date(year, (month ?? 1) - 1, day ?? 1)
}

function normalizeTitle(appName: string, title: string) {
  if (!title) return ''
  if (/edge/i.test(appName)) {
    return title.replace(/\s+-\s+Microsoft Edge$/i, '')
  }
  return title
}

function ensureDay(state: UsageStore, dateKey: string) {
  if (!state.dates[dateKey]) {
    state.dates[dateKey] = { apps: Object.create(null), windows: Object.create(null) }
  }
  return state.dates[dateKey]
}

function addUsage(day: UsageDay, app: string, title: string, deltaMs: number) {
  const now = Date.now()
  const appKey = app || 'unknown'
  const winKey = `${appKey}::${title || 'unknown'}`

  if (!day.apps[appKey]) {
    day.apps[appKey] = { totalMs: 0, lastUpdated: now }
  }
  day.apps[appKey].totalMs += deltaMs
  day.apps[appKey].lastUpdated = now

  if (!day.windows[winKey]) {
    day.windows[winKey] = { app: appKey, title: title || 'unknown', totalMs: 0, lastUpdated: now }
  }
  day.windows[winKey].totalMs += deltaMs
  day.windows[winKey].lastUpdated = now
}

function addInterval(state: UsageStore, current: NonNullable<UsageStore['current']>, from: number, to: number) {
  let cursor = from
  while (cursor < to) {
    const date = new Date(cursor)
    const nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
    const end = Math.min(to, nextDay)
    addUsage(ensureDay(state, getLocalDateKey(date)), current.app, current.title, end - cursor)
    cursor = end
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readStat(value: unknown): UsageStat {
  if (!isRecord(value) || typeof value.totalMs !== 'number' || !Number.isFinite(value.totalMs) || value.totalMs < 0) {
    throw new Error('Invalid usage duration')
  }
  return {
    totalMs: value.totalMs,
    lastUpdated: typeof value.lastUpdated === 'number' && Number.isFinite(value.lastUpdated) ? value.lastUpdated : 0,
  }
}

function readState(value: unknown): UsageStore {
  if (!isRecord(value)) throw new Error('Invalid usage data')
  const dates = value.dates ?? (typeof value.date === 'string' ? {
    [value.date]: { apps: value.apps ?? {}, windows: value.windows ?? {} },
  } : undefined)
  if (!isRecord(dates)) throw new Error('Invalid usage dates')
  const state: UsageStore = { dates: Object.create(null) }
  for (const [key, value] of Object.entries(dates)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || getLocalDateKey(parseDateKey(key)) !== key || !isRecord(value)) {
      throw new Error('Invalid usage date')
    }
    if (!isRecord(value.apps) || !isRecord(value.windows)) throw new Error('Invalid daily usage')
    const day = ensureDay(state, key)
    for (const [appName, stat] of Object.entries(value.apps)) day.apps[appName] = readStat(stat)
    for (const stat of Object.values(value.windows)) {
      if (!isRecord(stat) || typeof stat.app !== 'string' || typeof stat.title !== 'string') {
        throw new Error('Invalid window usage')
      }
      day.windows[`${stat.app}::${stat.title}`] = { ...readStat(stat), app: stat.app, title: stat.title }
    }
  }
  return state
}

async function loadState(dataPath: string): Promise<UsageStore> {
  try {
    return readState(JSON.parse(await fs.readFile(dataPath, 'utf-8')))
  } catch (error) {
    // Do not replace unreadable or malformed historical data with an empty file.
    if (isRecord(error) && error.code === 'ENOENT') return { dates: Object.create(null) }
    throw error
  }
}

async function saveState(dataPath: string, snapshot: string) {
  const temporaryPath = `${dataPath}.tmp`
  await fs.writeFile(temporaryPath, snapshot, 'utf-8')
  await fs.rename(temporaryPath, dataPath)
}

function listDateKeys(range: UsageRange, targetDate?: string, store?: UsageStore) {
  const todayKey = getLocalDateKey()
  if (range === 'today') return [todayKey]

  if (range === 'date' && targetDate) {
    return [targetDate]
  }

  if (range === 'week') {
    const keys: string[] = []
    const today = parseDateKey(todayKey)
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(today)
      date.setDate(today.getDate() - offset)
      keys.push(getLocalDateKey(date))
    }
    return keys
  }

  if (range === 'month') {
    const keys: string[] = []
    const now = parseDateKey(todayKey)
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    for (let day = start.getDate(); day <= end.getDate(); day += 1) {
      const date = new Date(now.getFullYear(), now.getMonth(), day)
      keys.push(getLocalDateKey(date))
    }
    return keys
  }

  if (range === 'year') {
    const keys: string[] = []
    const now = parseDateKey(todayKey)
    const start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1)
    const end = now
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      keys.push(getLocalDateKey(date))
    }
    return keys
  }

  if (range === 'all' && store) {
    return Object.keys(store.dates).sort()
  }

  return [todayKey]
}

function aggregate(store: UsageStore, keys: string[]) {
  const apps = new Map<string, number>()
  const windows = new Map<string, { app: string; title: string; totalMs: number }>()

  keys.forEach((key) => {
    const day = store.dates[key]
    if (!day) return
    Object.entries(day.apps).forEach(([appKey, stat]) => {
      apps.set(appKey, (apps.get(appKey) ?? 0) + stat.totalMs)
    })
    Object.values(day.windows).forEach((entry) => {
      const winKey = `${entry.app}::${entry.title}`
      const existing = windows.get(winKey)
      if (existing) {
        existing.totalMs += entry.totalMs
      } else {
        windows.set(winKey, { app: entry.app, title: entry.title, totalMs: entry.totalMs })
      }
    })
  })

  const appList = Array.from(apps.entries())
    .map(([app, totalMs]) => ({ app, totalMs }))
    .sort((a, b) => b.totalMs - a.totalMs)

  const windowList = Array.from(windows.values()).sort((a, b) => b.totalMs - a.totalMs)

  return { appList, windowList }
}

export async function createUsageTracker() {
  const require = createRequire(import.meta.url)
  type ActiveWin = typeof import('active-win')
  let activeWin: ActiveWin | null = null
  let trackingError: string | undefined
  let saveError: string | undefined
  try {
    activeWin = require('active-win') as ActiveWin
  } catch {
    trackingError = '记录组件未能加载，暂时无法记录新的使用时间。请重启 PCTime；若仍失败，请重新安装应用。'
  }

  const dataPath = path.join(app.getPath('userData'), 'usage.json')
  const state = await loadState(dataPath)
  // Samples describe this process session; persisted timestamps cannot be used
  // to infer activity while the application was closed.
  state.current = undefined
  state.lastTick = undefined
  let dirty = false
  let stopped = false
  let suspended = false
  let locked = false
  let sampleGeneration = 0
  let pendingTick: Promise<void> | null = null
  let saveQueue = Promise.resolve()

  const flush = () => {
    const snapshot = JSON.stringify({ dates: state.dates }, null, 2)
    dirty = false
    const save = saveQueue.then(() => saveState(dataPath, snapshot))
    saveQueue = save.then(() => {
      saveError = undefined
    }, () => {
      dirty = true
      saveError = '最新记录暂时未能保存，正在自动重试。请检查磁盘空间和数据目录权限，恢复保存前请勿退出应用。'
    })
    return save
  }

  const merge = async (imported: unknown) => {
    // Validate everything before touching live state, so a bad remote file
    // cannot partially replace a day's records.
    const incoming = readState(imported)
    for (const [key, remoteDay] of Object.entries(incoming.dates)) {
      const day = ensureDay(state, key)
      for (const [appName, stat] of Object.entries(remoteDay.apps)) {
        const existing = day.apps[appName]
        day.apps[appName] = {
          totalMs: Math.max(existing?.totalMs ?? 0, stat.totalMs),
          lastUpdated: Math.max(existing?.lastUpdated ?? 0, stat.lastUpdated),
        }
      }
      for (const [windowKey, stat] of Object.entries(remoteDay.windows)) {
        const existing = day.windows[windowKey]
        day.windows[windowKey] = {
          ...stat,
          totalMs: Math.max(existing?.totalMs ?? 0, stat.totalMs),
          lastUpdated: Math.max(existing?.lastUpdated ?? 0, stat.lastUpdated),
        }
      }
      const windowTotals = new Map<string, number>()
      for (const stat of Object.values(day.windows)) {
        windowTotals.set(stat.app, (windowTotals.get(stat.app) ?? 0) + stat.totalMs)
      }
      for (const [appName, totalMs] of windowTotals) {
        const existing = day.apps[appName]
        day.apps[appName] = { totalMs: Math.max(existing?.totalMs ?? 0, totalMs), lastUpdated: existing?.lastUpdated ?? 0 }
      }
    }
    await flush()
  }

  const resetSample = () => {
    sampleGeneration += 1
    state.current = undefined
    state.lastTick = undefined
  }

  const onSuspend = () => { suspended = true; resetSample() }
  const onResume = () => { suspended = false; resetSample() }
  const onLock = () => { locked = true; resetSample() }
  const onUnlock = () => { locked = false; resetSample() }
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('resume', onResume)
  powerMonitor.on('lock-screen', onLock)
  powerMonitor.on('unlock-screen', onUnlock)

  const tick = async () => {
    if (stopped || suspended || locked || !activeWin || powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SECONDS) {
      resetSample()
      return
    }

    const generation = sampleGeneration
    const info = await activeWin()
    // A suspension or lock can happen while the OS lookup is in flight.
    if (stopped || generation !== sampleGeneration) return
    trackingError = undefined
    if (!info?.owner || powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SECONDS) {
      resetSample()
      return
    }

    const now = Date.now()
    const appName = info.owner.name || 'unknown'
    const title = normalizeTitle(appName, info.title || '')
    const isSelf =
      info.owner.processId === process.pid || appName.toLowerCase() === 'pctime' ||
      (appName.toLowerCase() === 'electron' &&
        (title.toLowerCase().includes('pctime') || title.toLowerCase().includes('vite + react + ts')))

    if (state.current && state.lastTick !== undefined) {
      const deltaMs = now - state.lastTick
      if (deltaMs > 0 && deltaMs <= MAX_SAMPLE_GAP_MS) {
        addInterval(state, state.current, state.lastTick, now)
        dirty = true
      }
    }

    if (isSelf) {
      resetSample()
    } else {
      const windowKey = `${appName}::${title || 'unknown'}`
      state.current = { app: appName, title, windowKey }
      state.lastTick = now
    }
  }

  const getSummary = (range: UsageRange, targetDate?: string): UsageSummary => {
    const keys = listDateKeys(range, targetDate, state)
    const { appList, windowList } = aggregate(state, keys)
    return {
      range,
      date: targetDate ?? getLocalDateKey(),
      current: state.current ? { app: state.current.app, title: state.current.title } : undefined,
      trackingError,
      saveError,
      apps: appList,
      windows: windowList,
    }
  }

  const tickTimer = setInterval(() => {
    if (pendingTick || stopped) return
    pendingTick = tick().catch(() => {
      resetSample()
      trackingError = '暂时无法读取活动窗口，记录已暂停，正在自动重试。若持续出现，请重启 PCTime 并检查应用安装。'
    }).finally(() => { pendingTick = null })
  }, TICK_INTERVAL_MS)

  const saveTimer = setInterval(() => {
    if (!dirty) return
    flush().catch(() => undefined)
  }, SAVE_INTERVAL_MS)

  const stop = async () => {
    stopped = true
    resetSample()
    clearInterval(tickTimer)
    clearInterval(saveTimer)
    powerMonitor.removeListener('suspend', onSuspend)
    powerMonitor.removeListener('resume', onResume)
    powerMonitor.removeListener('lock-screen', onLock)
    powerMonitor.removeListener('unlock-screen', onUnlock)
    await flush()
  }

  return {
    getSummary,
    flush,
    merge,
    stop,
  }
}
