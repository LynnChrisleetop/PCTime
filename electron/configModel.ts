import { randomUUID } from 'node:crypto'

export type CategoryRule = {
  id: string
  category: string
  appContains?: string
  titleContains?: string
}

export type WebDavConfig = {
  enabled: boolean
  url: string
  username: string
  password: string
  remotePath: string
  syncIntervalMinutes: number
  syncMode: 'interval' | 'onClose' | 'daily' | 'weekly'
  syncHour: number
  syncMinute: number
  syncWeekday: number
  lastSyncAt?: string
}

export type UsageConfig = {
  categories: string[]
  rules: CategoryRule[]
  defaultCategory: string
  categoryColors: Record<string, string>
  webdav: WebDavConfig
  appSettings: {
    autoLaunch: boolean
    minimizeToTray: boolean
    closeToTray: boolean
    startMinimized: boolean
  }
}

export const DEFAULT_CONFIG: UsageConfig = {
  categories: ['工作', '学习', '娱乐', '社交', '其他'],
  defaultCategory: '其他',
  categoryColors: {
    其他: '#c9ced3', 学习: '#82afa0', 工作: '#197568', 娱乐: '#d6b278', 社交: '#8a9bb8',
  },
  webdav: {
    enabled: false, url: '', username: '', password: '', remotePath: '/PCTime',
    syncIntervalMinutes: 5, syncMode: 'interval', syncHour: 9, syncMinute: 0, syncWeekday: 1,
  },
  appSettings: { autoLaunch: false, minimizeToTray: true, closeToTray: true, startMinimized: false },
  rules: [{ id: randomUUID(), category: '娱乐', appContains: 'Microsoft Edge', titleContains: 'bilibili' }],
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function integer(value: unknown, fallback: number, min: number, max: number) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback
}

export function sanitizeConfig(value: unknown): UsageConfig {
  const config = record(value)
  const categoryInput = Array.isArray(config.categories) ? config.categories : DEFAULT_CONFIG.categories
  const categories = [...new Set(categoryInput.map((category) => text(category)).filter(Boolean))]
  const orderedCategories = [...categories.filter((category) => category !== '其他'), '其他']
  const categoryColors: Record<string, string> = {}
  const colors = record(config.categoryColors)
  for (const category of orderedCategories) {
    const color = text(colors[category])
    categoryColors[category] = /^#[\da-f]{6}$/i.test(color) ? color : DEFAULT_CONFIG.categoryColors[category] ?? '#c9ced3'
  }
  const sourceWebdav = record(config.webdav)
  const mode = sourceWebdav.syncMode
  const webdav: WebDavConfig = {
    enabled: sourceWebdav.enabled === true,
    url: text(sourceWebdav.url), username: text(sourceWebdav.username),
    password: typeof sourceWebdav.password === 'string' ? sourceWebdav.password : '',
    remotePath: text(sourceWebdav.remotePath) || '/PCTime',
    syncIntervalMinutes: integer(sourceWebdav.syncIntervalMinutes, 5, 1, 1440),
    syncMode: mode === 'onClose' || mode === 'daily' || mode === 'weekly' ? mode : 'interval',
    syncHour: integer(sourceWebdav.syncHour, 9, 0, 23),
    syncMinute: integer(sourceWebdav.syncMinute, 0, 0, 59),
    syncWeekday: integer(sourceWebdav.syncWeekday, 1, 0, 6),
    lastSyncAt: text(sourceWebdav.lastSyncAt) || undefined,
  }
  const rules = (Array.isArray(config.rules) ? config.rules : DEFAULT_CONFIG.rules).map((value) => {
    const rule = record(value)
    const category = text(rule.category)
    return {
      id: text(rule.id) || randomUUID(),
      category: orderedCategories.includes(category) ? category : '其他',
      appContains: text(rule.appContains), titleContains: text(rule.titleContains),
    }
  }).filter((rule) => rule.appContains || rule.titleContains)
  const settings = record(config.appSettings)
  const booleanSetting = (key: keyof UsageConfig['appSettings']) =>
    typeof settings[key] === 'boolean' ? settings[key] as boolean : DEFAULT_CONFIG.appSettings[key]
  const appSettings = {
    autoLaunch: booleanSetting('autoLaunch'), minimizeToTray: booleanSetting('minimizeToTray'),
    closeToTray: booleanSetting('closeToTray'), startMinimized: booleanSetting('startMinimized'),
  }
  const requestedDefault = text(config.defaultCategory)
  const defaultCategory = orderedCategories.includes(requestedDefault) ? requestedDefault : '其他'
  return { categories: orderedCategories, rules, defaultCategory, categoryColors, webdav, appSettings }
}

export function resolveCategory(config: UsageConfig, appName: string, title: string) {
  const lowerApp = appName.toLowerCase()
  const lowerTitle = title.toLowerCase()
  const match = config.rules.find((rule) => {
    const appPattern = rule.appContains?.trim().toLowerCase() ?? ''
    const titlePattern = rule.titleContains?.trim().toLowerCase() ?? ''
    return Boolean(appPattern || titlePattern) &&
      (!appPattern || lowerApp.includes(appPattern)) && (!titlePattern || lowerTitle.includes(titlePattern))
  })
  return match?.category || config.defaultCategory || '其他'
}

// A failed operation must not prevent subsequent saves or syncs from running.
export function createSerialQueue() {
  let pending: Promise<unknown> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation, operation)
    pending = result.catch(() => undefined)
    return result
  }
}
