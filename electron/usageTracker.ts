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
  apps: Array<{ app: string; totalMs: number }>
  windows: Array<{ app: string; title: string; totalMs: number }>
}

const IDLE_THRESHOLD_SECONDS = 60
const TICK_INTERVAL_MS = 1000
const SAVE_INTERVAL_MS = 10000

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
    state.dates[dateKey] = { apps: {}, windows: {} }
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

async function loadState(dataPath: string): Promise<UsageStore> {
  try {
    const raw = await fs.readFile(dataPath, 'utf-8')
    const parsed = JSON.parse(raw) as UsageStore | any
    if (parsed?.dates) return parsed
    if (parsed?.date) {
      return {
        dates: {
          [parsed.date]: {
            apps: parsed.apps ?? {},
            windows: parsed.windows ?? {},
          },
        },
        current: parsed.current,
        lastTick: parsed.lastTick,
        lastDate: parsed.date,
      }
    }
    throw new Error('invalid data')
  } catch {
    return {
      dates: {},
    }
  }
}

async function saveState(dataPath: string, state: UsageStore) {
  const payload: UsageStore = {
    dates: state.dates,
    current: state.current,
    lastTick: state.lastTick,
    lastDate: state.lastDate,
  }
  await fs.writeFile(dataPath, JSON.stringify(payload, null, 2), 'utf-8')
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
  try {
    activeWin = require('active-win') as ActiveWin
  } catch (error) {
    console.error('active-win not available', error)
  }

  const dataPath = path.join(app.getPath('userData'), 'usage.json')
  const state = await loadState(dataPath)
  let dirty = false

  const tick = async () => {
    const now = Date.now()
    const todayKey = getLocalDateKey()
    state.lastDate = todayKey

    if (powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SECONDS) {
      state.lastTick = now
      return
    }

    if (!activeWin) {
      state.lastTick = now
      return
    }

    const info = await activeWin()
    if (!info || !info.owner) {
      state.lastTick = now
      return
    }

    const appName = info.owner.name || 'unknown'
    const title = normalizeTitle(appName, info.title || '')
    const isSelf =
      appName.toLowerCase() === 'electron' &&
      (title.toLowerCase().includes('pctime') || title.toLowerCase().includes('vite + react + ts'))

    if (!isSelf && state.current && state.lastTick) {
      const deltaMs = Math.max(0, now - state.lastTick)
      const day = ensureDay(state, todayKey)
      addUsage(day, state.current.app, state.current.title, deltaMs)
      dirty = true
    }

    if (!isSelf) {
      const windowKey = `${appName}::${title || 'unknown'}`
      state.current = { app: appName, title, windowKey }
    }
    state.lastTick = now
  }

  const getSummary = (range: UsageRange, targetDate?: string): UsageSummary => {
  const keys = listDateKeys(range, targetDate, state)
    const { appList, windowList } = aggregate(state, keys)
    return {
      range,
      date: targetDate ?? getLocalDateKey(),
      current: state.current ? { app: state.current.app, title: state.current.title } : undefined,
      apps: appList,
      windows: windowList,
    }
  }

  const tickTimer = setInterval(() => {
    tick().catch(() => {
      state.lastTick = Date.now()
    })
  }, TICK_INTERVAL_MS)

  const saveTimer = setInterval(() => {
    if (!dirty) return
    const snapshot = state
    dirty = false
    saveState(dataPath, snapshot).catch(() => {
      dirty = true
    })
  }, SAVE_INTERVAL_MS)

  const stop = async () => {
    clearInterval(tickTimer)
    clearInterval(saveTimer)
    await saveState(dataPath, state)
  }

  return {
    getSummary,
    stop,
  }
}
