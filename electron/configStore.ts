import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
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

const DEFAULT_CONFIG: UsageConfig = {
  categories: ['工作', '学习', '娱乐', '社交', '其他'],
  defaultCategory: '其他',
  categoryColors: {
    其他: '#9ca3af',
    学习: '#34d399',
    工作: '#f87171',
    娱乐: '#fbbf24',
    社交: '#60a5fa',
  },
  webdav: {
    enabled: false,
    url: '',
    username: '',
    password: '',
    remotePath: '/PCTime',
    syncIntervalMinutes: 5,
    syncMode: 'interval',
    syncHour: 9,
    syncMinute: 0,
    syncWeekday: 1,
  },
  appSettings: {
    autoLaunch: false,
    minimizeToTray: true,
    closeToTray: true,
    startMinimized: false,
  },
  rules: [
    {
      id: randomUUID(),
      category: '娱乐',
      appContains: 'Microsoft Edge',
      titleContains: 'bilibili',
    },
  ],
}

const CONFIG_FILE = 'config.json'

export function getConfigPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

function sanitizeConfig(config: UsageConfig): UsageConfig {
  const categories = Array.from(
    new Set(config.categories.filter((value) => value && value.trim()))
  )
  if (!categories.includes('社交')) {
    categories.push('社交')
  }
  if (!categories.includes('其他')) {
    categories.push('其他')
  }
  const orderedCategories = [
    ...categories.filter((category) => category !== '其他'),
    '其他',
  ]
  const defaultCategory = categories.includes(config.defaultCategory)
    ? config.defaultCategory
    : '其他'
  const defaultColors: Record<string, string> = {
    其他: '#9ca3af',
    学习: '#34d399',
    工作: '#f87171',
    娱乐: '#fbbf24',
    社交: '#60a5fa',
  }
  const categoryColors: Record<string, string> = { ...defaultColors }
  if (config.categoryColors) {
    Object.entries(config.categoryColors).forEach(([key, value]) => {
      if (key && typeof value === 'string' && value.trim()) {
        categoryColors[key] = value.trim()
      }
    })
  }
  orderedCategories.forEach((category) => {
    if (!categoryColors[category]) {
      categoryColors[category] = '#9ca3af'
    }
  })
  const webdav: WebDavConfig = {
    enabled: Boolean(config.webdav?.enabled),
    url: config.webdav?.url?.trim() || '',
    username: config.webdav?.username?.trim() || '',
    password: config.webdav?.password || '',
    remotePath: config.webdav?.remotePath?.trim() || '/PCTime',
    syncIntervalMinutes: Number(config.webdav?.syncIntervalMinutes) || 5,
    syncMode: config.webdav?.syncMode || 'interval',
    syncHour: Number(config.webdav?.syncHour) || 9,
    syncMinute: Number(config.webdav?.syncMinute) || 0,
    syncWeekday: Number(config.webdav?.syncWeekday) || 1,
    lastSyncAt: config.webdav?.lastSyncAt,
  }
  const rules = (config.rules ?? []).map((rule) => ({
    id: rule.id || randomUUID(),
    category: rule.category || '其他',
    appContains: rule.appContains?.trim() || '',
    titleContains: rule.titleContains?.trim() || '',
  }))
  const appSettings = {
    autoLaunch: Boolean(config.appSettings?.autoLaunch),
    minimizeToTray: Boolean(config.appSettings?.minimizeToTray),
    closeToTray: Boolean(config.appSettings?.closeToTray),
    startMinimized: Boolean(config.appSettings?.startMinimized),
  }
  return { categories: orderedCategories, rules, defaultCategory, categoryColors, webdav, appSettings }
}

export async function loadConfig(): Promise<UsageConfig> {
  const filePath = getConfigPath()
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as UsageConfig
    return sanitizeConfig(parsed)
  } catch {
    const initial = sanitizeConfig(DEFAULT_CONFIG)
    await fs.writeFile(filePath, JSON.stringify(initial, null, 2), 'utf-8')
    return initial
  }
}

export async function saveConfig(config: UsageConfig) {
  const filePath = getConfigPath()
  const normalized = sanitizeConfig(config)
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf-8')
  return normalized
}
