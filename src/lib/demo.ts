import { todayKey } from './usage'

const config: UsageConfig = {
  categories: ['工作', '学习', '娱乐', '社交', '其他'],
  defaultCategory: '其他',
  categoryColors: {
    工作: '#147d9e',
    学习: '#f4cc39',
    娱乐: '#f48158',
    社交: '#a49bca',
    其他: '#cbd5df',
  },
  categoryPaletteVersion: 1,
  appSettings: {
    autoLaunch: false,
    minimizeToTray: true,
    closeToTray: true,
    startMinimized: false,
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
  rules: [
    {
      id: 'demo-code',
      category: '工作',
      appContains: 'Code',
      titleContains: '',
    },
  ],
}

const apps = [
  ['Visual Studio Code', 8324000],
  ['Microsoft Edge', 5862000],
  ['Obsidian', 2740000],
  ['Windows Terminal', 1353000],
  ['微信', 984000],
  ['Spotify', 537000],
  ['文件资源管理器', 265000],
  ['Figma', 237000],
  ['Notion', 186000],
  ['计算器', 129000],
  ['画图', 64000],
  ['记事本', 47000],
] as const

let draft = structuredClone(config)
export const demoApi: Window['usage'] = {
  getSummary: async (range = 'today', date) => {
    const factor =
      range === 'week'
        ? 4.7
        : range === 'month'
          ? 18.3
          : range === 'year' || range === 'all'
            ? 110.8
            : 1
    const empty = range === 'date' && date !== todayKey()
    const entries = empty
      ? []
      : apps.map(([app, totalMs]) => ({
          app,
          totalMs: Math.round(totalMs * factor),
        }))
    const total = entries.reduce((sum, item) => sum + item.totalMs, 0)
    return {
      range: range as UsageSummary['range'],
      date: date ?? todayKey(),
      current: { app: 'Visual Studio Code', title: 'PCTime — 让时间更清晰' },
      apps: entries,
      windows: entries.map((item, index) => ({
        ...item,
        title:
          [
            'PCTime · 项目工作区',
            'React 官方文档 — Microsoft Edge',
            '本周笔记与计划',
          ][index] ?? `${item.app} — 主窗口`,
      })),
      categories: draft.categories.map((category, index) => ({
        category,
        totalMs: Math.round(
          total * ((range === 'week'
            ? [0.49, 0.27, 0.12, 0.08, 0.04]
            : range === 'month'
              ? [0.48, 0.24, 0.14, 0.09, 0.05]
              : [0.56, 0.22, 0.11, 0.07, 0.04])[index] ?? 0)
        ),
      })),
    }
  },
  getConfig: async () => structuredClone(draft),
  setConfig: async (next) => {
    draft = structuredClone(next)
    return structuredClone(draft)
  },
  saveExport: async () => ({ saved: false }),
  testWebdav: async () => ({
    ok: false,
    message: '演示模式不连接同步服务，请在桌面应用中使用。',
  }),
  syncNow: async () => ({
    ok: false,
    message: '演示模式不连接同步服务，请在桌面应用中使用。',
  }),
}
