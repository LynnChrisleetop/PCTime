/// <reference types="vite/client" />

type UsageSummary = {
  range: 'today' | 'week' | 'month' | 'year' | 'all' | 'date'
  date: string
  current?: { app: string; title: string }
  trackingError?: string
  saveError?: string
  apps: Array<{ app: string; totalMs: number }>
  windows: Array<{ app: string; title: string; totalMs: number }>
  categories?: Array<{ category: string; totalMs: number }>
}

type UsageConfig = {
  categories: string[]
  defaultCategory: string
  categoryColors: Record<string, string>
  webdav: {
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
  appSettings: {
    autoLaunch: boolean
    minimizeToTray: boolean
    closeToTray: boolean
    startMinimized: boolean
  }
  rules: Array<{
    id: string
    category: string
    appContains?: string
    titleContains?: string
  }>
}

interface Window {
  usage: {
    getSummary: (range?: string, date?: string) => Promise<UsageSummary>
    getConfig: () => Promise<UsageConfig>
    setConfig: (config: UsageConfig) => Promise<UsageConfig>
    saveExport: (content: string, defaultPath: string) => Promise<{ saved: boolean; path?: string }>
    testWebdav: () => Promise<{ ok: boolean; message?: string }>
    syncNow: () => Promise<{ ok: boolean; message?: string }>
  }
}
