import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type SourceUsage = { sourceId: string; sourceName: string; totalMs: number }
export type DeviceDay = { date: string; revision: number; timeZone: string; apps: SourceUsage[] }
type JournalDay = { revision: number; timeZone: string; apps: Record<string, SourceUsage>; accepted: Record<string, number> }
type JournalStore = { version: 1; clientId: string; days: Record<string, JournalDay> }

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function sourceForWindow(app: string, title: string): Omit<SourceUsage, 'totalMs'> {
  const name = app.trim().slice(0, 160) || '未知应用'
  const id = name.toLowerCase()
  if (/^(wechat|weixin)(\.exe)?$|^微信$/.test(id)) return { sourceId: 'wechat', sourceName: '微信' }
  if (/^(bilibili)(\.exe)?$|^哔哩哔哩$/.test(id)) return { sourceId: 'bilibili', sourceName: '哔哩哔哩' }
  const pageTitle = title.replace(/\s+[-—]\s+(?:Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Opera|Vivaldi)(?:\s.*)?$/i, '').trim()
  const bilibiliBrand = /(?:^|[_\s-])哔哩哔哩(?:[_\s-]+bilibili)?$/i.test(pageTitle) ||
    /^哔哩哔哩\s+.*[-_]bilibili$/i.test(pageTitle)
  if (/edge|chrome|firefox|brave|opera|vivaldi|browser|浏览器/i.test(name) && bilibiliBrand) {
    return { sourceId: 'site:bilibili', sourceName: '哔哩哔哩' }
  }
  if (/^qq(\.exe)?$/.test(id)) return { sourceId: 'qq', sourceName: 'QQ' }
  return { sourceId: id, sourceName: name }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseJournal(value: unknown): JournalStore {
  if (!record(value) || value.version !== 1 || typeof value.clientId !== 'string' ||
    !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value.clientId) || !record(value.days)) {
    throw new Error('本机独立记录文件无效，请保留该文件并检查数据目录。')
  }
  const store: JournalStore = { version: 1, clientId: value.clientId, days: Object.create(null) }
  for (const [date, day] of Object.entries(value.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !record(day) || !Number.isSafeInteger(day.revision) || Number(day.revision) < 1 ||
      typeof day.timeZone !== 'string' || !record(day.apps) || !record(day.accepted)) throw new Error('本机独立记录格式无效。')
    try { new Intl.DateTimeFormat('en', { timeZone: day.timeZone }) } catch { throw new Error('本机记录的时区无效。') }
    const apps: Record<string, SourceUsage> = Object.create(null)
    for (const [sourceId, usage] of Object.entries(day.apps)) {
      if (!record(usage) || usage.sourceId !== sourceId || typeof usage.sourceName !== 'string' ||
        !sourceId || sourceId.length > 160 || usage.sourceName.length > 160 ||
        !Number.isSafeInteger(usage.totalMs) || Number(usage.totalMs) < 0) throw new Error('本机应用记录格式无效。')
      apps[sourceId] = { sourceId, sourceName: usage.sourceName, totalMs: Number(usage.totalMs) }
    }
    if (Object.keys(apps).length > 2000 || Object.values(apps).reduce((sum, item) => sum + item.totalMs, 0) > 90_000_000) throw new Error('本机记录超过单日限制。')
    const accepted: Record<string, number> = Object.create(null)
    for (const [key, revision] of Object.entries(day.accepted)) {
      if (/^[\da-f]{64}$/.test(key) && Number.isSafeInteger(revision) && Number(revision) >= 0) accepted[key] = Number(revision)
    }
    store.days[date] = { apps, accepted, timeZone: day.timeZone, revision: Number(day.revision) }
  }
  return store
}

// This file has no migration from usage.json: that history may contain another
// device's WebDAV imports. Only new, validated foreground intervals reach it.
export async function createDeviceJournal(directory: string, timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const filename = path.join(directory, 'device-usage.json')
  let store: JournalStore
  try { store = parseJournal(JSON.parse(await fs.readFile(filename, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    store = { version: 1, clientId: randomUUID(), days: Object.create(null) }
  }
  let changes = 1
  let persisted = 0
  let queue = Promise.resolve()
  const flush = () => {
    const version = changes
    const snapshot = JSON.stringify(store)
    const writing = queue.then(async () => {
      if (version <= persisted) return
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(`${filename}.tmp`, snapshot, 'utf8')
      await fs.rename(`${filename}.tmp`, filename)
      persisted = version
    })
    queue = writing.catch(() => undefined)
    return writing
  }
  await flush()
  const snapshots = (account?: string): DeviceDay[] => Object.entries(store.days)
    .filter(([, day]) => !account || (day.accepted[account] ?? 0) < day.revision)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, day]) => ({ date, revision: day.revision, timeZone: day.timeZone,
      apps: Object.values(day.apps).map(item => ({ ...item })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)) }))
  return {
    clientId: store.clientId,
    flush,
    snapshots,
    record(app: string, title: string, from: number, to: number) {
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from || to - from > 5000) return
      const source = sourceForWindow(app, title)
      let cursor = from
      while (cursor < to) {
        const current = new Date(cursor)
        const date = localDate(current)
        const end = Math.min(to, new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime())
        const day = store.days[date] ??= { revision: 1, timeZone: timeZone(), apps: Object.create(null), accepted: Object.create(null) }
        const normalized = !day.apps[source.sourceId] && Object.keys(day.apps).length >= 1999
          ? { sourceId: 'windows:other', sourceName: '其他应用' } : source
        const total = Object.values(day.apps).reduce((sum, item) => sum + item.totalMs, 0)
        const added = Math.min(end - cursor, Math.max(0, 90_000_000 - total))
        if (added > 0) {
          const usage = day.apps[normalized.sourceId] ??= { ...normalized, totalMs: 0 }
          usage.totalMs += added
          day.revision += 1
          changes += 1
        }
        cursor = end
      }
    },
    acknowledge(account: string, date: string, revision: number) {
      const day = store.days[date]
      if (!day || revision > day.revision) return
      day.accepted[account] = Math.max(day.accepted[account] ?? 0, revision)
      changes += 1
    },
  }
}
