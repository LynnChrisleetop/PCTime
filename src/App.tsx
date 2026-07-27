import { useEffect, useMemo, useState } from 'react'
import {
  Chart as ChartJS,
  ArcElement,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from 'chart.js'
import type { ChartOptions, TooltipItem } from 'chart.js'
import { Bar, Doughnut } from 'react-chartjs-2'
import './App.css'

ChartJS.register(ArcElement, BarElement, CategoryScale, LinearScale, Tooltip, Legend)

type UsageSummary = {
  range: 'today' | 'week' | 'month' | 'year' | 'all' | 'date'
  date: string
  current?: { app: string; title: string }
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

function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}`
}

function formatMinutes(ms: number) {
  const totalMinutes = Math.floor(ms / 60000)
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `${hours}h${minutes}min`
  }
  return `${totalMinutes}min`
}

function toMinutes(ms: number) {
  return Number((ms / 60000).toFixed(2))
}

function getTodayKey() {
  const now = new Date()
  const year = now.getFullYear()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function makeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function App() {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<'today' | 'week' | 'month' | 'year' | 'all' | 'date'>('today')
  const [selectedDate, setSelectedDate] = useState(getTodayKey())
  const [config, setConfig] = useState<UsageConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [showAllApps, setShowAllApps] = useState(false)
  const [showAllWindows, setShowAllWindows] = useState(false)

  useEffect(() => {
    window.usage
      .getConfig()
      .then((data) => setConfig(data))
      .catch(() => setError('无法读取分类配置'))
  }, [])

  useEffect(() => {
    let active = true
    const fetchSummary = async () => {
      try {
        if (!window.usage?.getSummary) {
          if (active) {
            setError('当前是浏览器预览，请在 Electron 窗口中运行')
          }
          return
        }
        const data = await window.usage.getSummary(range, range === 'date' ? selectedDate : undefined)
        if (active) {
          setSummary(data)
          setError(null)
        }
      } catch (err) {
        if (active) {
          setError('无法读取使用时间数据')
        }
      }
    }

    fetchSummary()
    const timer = setInterval(fetchSummary, 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [range, selectedDate])

  const topApps = useMemo(() => (summary?.apps ?? []).slice(0, 10), [summary])
  const topWindows = useMemo(() => (summary?.windows ?? []).slice(0, 10), [summary])
  const visibleApps = useMemo(() => (showAllApps ? topApps : topApps.slice(0, 3)), [showAllApps, topApps])
  const visibleWindows = useMemo(
    () => (showAllWindows ? topWindows : topWindows.slice(0, 3)),
    [showAllWindows, topWindows]
  )
  const categoryTotals = useMemo(() => {
    const totals = summary?.categories ?? []
    const totalMap = new Map(totals.map((item) => [item.category, item.totalMs]))
    const categories = config?.categories ?? totals.map((item) => item.category)
    return categories.map((category) => ({
      category,
      totalMs: totalMap.get(category) ?? 0,
    }))
  }, [summary, config])

  const categoryColors = useMemo(() => {
    return config?.categoryColors ?? {}
  }, [config])

  const pieData = useMemo(() => {
    return {
      labels: categoryTotals.map((item) => item.category),
      datasets: [
        {
          data: categoryTotals.map((item) => toMinutes(item.totalMs)),
          backgroundColor: categoryTotals.map(
            (item) => categoryColors[item.category] || '#9ca3af'
          ),
        },
      ],
    }
  }, [categoryTotals, categoryColors])

  const categoryBarData = useMemo(() => {
    return {
      labels: categoryTotals.map((item) => item.category),
      datasets: [
        {
          label: '分钟',
          data: categoryTotals.map((item) => toMinutes(item.totalMs)),
          backgroundColor: categoryTotals.map(
            (item) => categoryColors[item.category] || '#9ca3af'
          ),
        },
      ],
    }
  }, [categoryTotals, categoryColors])

  const appBarData = useMemo(() => {
    return {
      labels: topApps.map((item) => item.app),
      datasets: [
        {
          label: '分钟',
          data: topApps.map((item) => toMinutes(item.totalMs)),
          backgroundColor: '#60a5fa',
        },
      ],
    }
  }, [topApps])

  const barOptions = useMemo<ChartOptions<'bar'>>(() => {
    return {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          title: {
            display: false,
            text: '分钟',
          },
        },
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            label: (context: TooltipItem<'bar'>) => {
              const raw = typeof context.raw === 'number' ? context.raw : Number(context.raw ?? 0)
              const ms = raw * 60000
              return formatMinutes(ms)
            },
          },
        },
      },
    }
  }, [])

  const doughnutOptions = useMemo(() => {
    return {
      plugins: {
        tooltip: {
          callbacks: {
            label: (context: { label?: string; parsed?: number }) => {
              const value = context?.parsed ?? 0
              const label = context?.label ?? ''
              return `${label}: ${formatMinutes(value * 60000)}`
            },
          },
        },
      },
    }
  }, [])

  const windowBarData = useMemo(() => {
    return {
      labels: topWindows.map((item) => item.title || '无标题'),
      datasets: [
        {
          label: '分钟',
          data: topWindows.map((item) => toMinutes(item.totalMs)),
          backgroundColor: '#34d399',
        },
      ],
    }
  }, [topWindows])

  const saveConfig = async (nextConfig: UsageConfig) => {
    setConfig(nextConfig)
    try {
      await window.usage.setConfig(nextConfig)
    } catch {
      setError('保存分类规则失败')
    }
  }

  const addRule = () => {
    if (!config) return
    const next = {
      ...config,
      rules: [
        ...config.rules,
        {
          id: makeId(),
          category: config.categories[0] ?? '其他',
          appContains: '',
          titleContains: '',
        },
      ],
    }
    saveConfig(next)
  }

  const setDefaultCategory = (value: string) => {
    if (!config) return
    saveConfig({ ...config, defaultCategory: value })
  }

  const setCategoryColor = (category: string, value: string) => {
    if (!config) return
    saveConfig({
      ...config,
      categoryColors: {
        ...config.categoryColors,
        [category]: value,
      },
    })
  }

  const updateRule = (id: string, field: 'category' | 'appContains' | 'titleContains', value: string) => {
    if (!config) return
    const next = {
      ...config,
      rules: config.rules.map((rule) =>
        rule.id === id
          ? {
              ...rule,
              [field]: value,
            }
          : rule
      ),
    }
    saveConfig(next)
  }

  const removeRule = (id: string) => {
    if (!config) return
    const next = {
      ...config,
      rules: config.rules.filter((rule) => rule.id !== id),
    }
    saveConfig(next)
  }

  const exportSummary = async (type: 'json' | 'csv') => {
    if (!summary) return
    setSaving(true)
    try {
      const baseName = `PCTime-${summary.range}-${summary.date}`
      if (type === 'json') {
        const payload = JSON.stringify({ summary, config }, null, 2)
        await window.usage.saveExport(payload, `${baseName}.json`)
      } else {
        const rows = [
          ['type', 'name', 'app', 'duration_seconds'],
          ...summary.apps.map((item) => ['app', item.app, '', Math.round(item.totalMs / 1000).toString()]),
          ...summary.windows.map((item) => [
            'window',
            item.title || '无标题',
            item.app,
            Math.round(item.totalMs / 1000).toString(),
          ]),
          ...(summary.categories ?? []).map((item) => [
            'category',
            item.category,
            '',
            Math.round(item.totalMs / 1000).toString(),
          ]),
        ]
        const csv = rows.map((row) => row.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')).join('\n')
        await window.usage.saveExport(csv, `${baseName}.csv`)
      }
    } catch {
      setError('导出失败')
    } finally {
      setSaving(false)
    }
  }

  const updateWebdav = (field: keyof UsageConfig['webdav'], value: string | boolean | number) => {
    if (!config) return
    saveConfig({
      ...config,
      webdav: {
        ...config.webdav,
        [field]: value,
      },
    })
  }

  const updateAppSetting = (field: keyof UsageConfig['appSettings'], value: boolean) => {
    if (!config) return
    saveConfig({
      ...config,
      appSettings: {
        ...config.appSettings,
        [field]: value,
      },
    })
  }

  const testWebdav = async () => {
    setSyncBusy(true)
    setSyncStatus(null)
    try {
      const result = await window.usage.testWebdav()
      setSyncStatus(result.ok ? '连接成功' : result.message ?? '连接失败')
    } catch {
      setSyncStatus('连接失败')
    } finally {
      setSyncBusy(false)
    }
  }

  const syncNow = async () => {
    setSyncBusy(true)
    setSyncStatus(null)
    try {
      const result = await window.usage.syncNow()
      setSyncStatus(result.ok ? '同步完成' : result.message ?? '同步失败')
    } catch {
      setSyncStatus('同步失败')
    } finally {
      setSyncBusy(false)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>PCTime 使用时间</h1>
          <p className="subtitle">统计当前电脑各软件与窗口的使用时长</p>
        </div>
        <div className="date-chip">{summary?.date ?? '--'}</div>
      </header>

      {error && <div className="error">{error}</div>}

      <section className="controls">
        <div className="range-group">
          <label>统计范围</label>
          <select value={range} onChange={(event) => setRange(event.target.value as typeof range)}>
            <option value="today">今天</option>
            <option value="week">本周</option>
            <option value="month">本月</option>
            <option value="year">近一年</option>
            <option value="all">所有时间</option>
            <option value="date">选择日期</option>
          </select>
          {range === 'date' && (
            <input
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          )}
        </div>
        <div className="export-group">
          <button type="button" onClick={() => exportSummary('json')} disabled={saving}>
            导出 JSON
          </button>
          <button type="button" onClick={() => exportSummary('csv')} disabled={saving}>
            导出 CSV
          </button>
        </div>
      </section>

      <section className="charts">
        <div className="panel panel-wide">
          <h2>PC端使用情况</h2>
          {categoryTotals.length === 0 ? (
            <div className="empty">暂无数据</div>
          ) : (
            <div className="category-charts horizontal">
              <div className="category-chart">
                <Doughnut data={pieData} options={doughnutOptions} />
              </div>
              <div className="category-chart bar">
                <div className="bar-chart">
                  <Bar data={categoryBarData} options={barOptions} />
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="panel">
          <h2>应用排行</h2>
          {topApps.length === 0 ? (
            <div className="empty">暂无数据</div>
          ) : (
            <div className="bar-chart">
              <Bar data={appBarData} options={barOptions} />
            </div>
          )}
        </div>
        <div className="panel">
          <h2>窗口/页面排行</h2>
          {topWindows.length === 0 ? (
            <div className="empty">暂无数据</div>
          ) : (
            <div className="bar-chart">
              <Bar data={windowBarData} options={barOptions} />
            </div>
          )}
        </div>
      </section>

      <section className="current">
        <h2>当前使用</h2>
        {summary?.current ? (
          <div className="current-info">
            <div className="current-app">{summary.current.app}</div>
            <div className="current-title">{summary.current.title || '无窗口标题'}</div>
          </div>
        ) : (
          <div className="empty">暂无数据</div>
        )}
      </section>

      <div className="grid">
        <section className="panel">
          <h2>应用使用排行</h2>
          {topApps.length === 0 ? (
            <div className="empty">暂无数据</div>
          ) : (
            <>
              <ul>
                {visibleApps.map((item) => (
                  <li key={item.app}>
                    <span className="item-name">{item.app}</span>
                    <span className="item-time">{formatDuration(item.totalMs)}</span>
                  </li>
                ))}
              </ul>
              {topApps.length > 3 && (
                <button className="toggle-btn" type="button" onClick={() => setShowAllApps((prev) => !prev)}>
                  {showAllApps ? '收起' : '展开更多'}
                </button>
              )}
            </>
          )}
        </section>

        <section className="panel">
          <h2>窗口/页面使用排行</h2>
          {topWindows.length === 0 ? (
            <div className="empty">暂无数据</div>
          ) : (
            <>
              <ul>
                {visibleWindows.map((item) => (
                  <li key={`${item.app}-${item.title}`}>
                    <div className="item-title">{item.title || '无窗口标题'}</div>
                    <div className="item-meta">
                      <span className="item-app">{item.app}</span>
                      <span className="item-time">{formatDuration(item.totalMs)}</span>
                    </div>
                  </li>
                ))}
              </ul>
              {topWindows.length > 3 && (
                <button className="toggle-btn" type="button" onClick={() => setShowAllWindows((prev) => !prev)}>
                  {showAllWindows ? '收起' : '展开更多'}
                </button>
              )}
            </>
          )}
        </section>
      </div>

      <section className="panel rules">
        <div className="rules-header">
          <h2>分类规则（应用 + 标题匹配）</h2>
          <button type="button" onClick={addRule}>
            新增规则
          </button>
        </div>
        {config && (
          <div className="default-category">
            <span>未匹配默认分类</span>
            <select
              value={config.defaultCategory}
              onChange={(event) => setDefaultCategory(event.target.value)}
            >
              {config.categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
        )}
        {config && (
          <div className="color-grid">
            {config.categories.map((category) => (
              <label key={category} className="color-row">
                <span>{category}</span>
                <input
                  type="color"
                  value={config.categoryColors?.[category] ?? '#9ca3af'}
                  onChange={(event) => setCategoryColor(category, event.target.value)}
                />
              </label>
            ))}
          </div>
        )}
        {!config ? (
          <div className="empty">加载中...</div>
        ) : config.rules.length === 0 ? (
          <div className="empty">暂无规则</div>
        ) : (
          <div className="rules-list">
            {config.rules.map((rule) => (
              <div className="rule-row" key={rule.id}>
                <select
                  value={rule.category}
                  onChange={(event) => updateRule(rule.id, 'category', event.target.value)}
                >
                  {config.categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                <input
                  placeholder="应用包含（如 Microsoft Edge）"
                  value={rule.appContains ?? ''}
                  onChange={(event) => updateRule(rule.id, 'appContains', event.target.value)}
                />
                <input
                  placeholder="标题包含（如 bilibili）"
                  value={rule.titleContains ?? ''}
                  onChange={(event) => updateRule(rule.id, 'titleContains', event.target.value)}
                />
                <button type="button" onClick={() => removeRule(rule.id)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel app-settings">
        <div className="rules-header">
          <h2>应用设置</h2>
        </div>
        {!config ? (
          <div className="empty">加载中...</div>
        ) : (
          <div className="settings-list">
            <label>
              <input
                type="checkbox"
                checked={config.appSettings.autoLaunch}
                onChange={(event) => updateAppSetting('autoLaunch', event.target.checked)}
              />
              开机自启
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.appSettings.startMinimized}
                onChange={(event) => updateAppSetting('startMinimized', event.target.checked)}
              />
              启动后最小化到托盘
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.appSettings.minimizeToTray}
                onChange={(event) => updateAppSetting('minimizeToTray', event.target.checked)}
              />
              最小化到托盘
            </label>
            <label>
              <input
                type="checkbox"
                checked={config.appSettings.closeToTray}
                onChange={(event) => updateAppSetting('closeToTray', event.target.checked)}
              />
              关闭窗口时保持后台运行
            </label>
            <p className="hint">开启托盘功能后，可从托盘图标打开或退出。</p>
          </div>
        )}
      </section>

      <section className="panel webdav">
        <div className="rules-header">
          <h2>坚果云 WebDAV 同步</h2>
        </div>
        {!config ? (
          <div className="empty">加载中...</div>
        ) : (
          <div className="webdav-form">
            <label>
              <input
                type="checkbox"
                checked={config.webdav.enabled}
                onChange={(event) => updateWebdav('enabled', event.target.checked)}
              />
              启用同步
            </label>
            <input
              placeholder="WebDAV 地址"
              value={config.webdav.url}
              onChange={(event) => updateWebdav('url', event.target.value)}
            />
            <input
              placeholder="账号（邮箱）"
              value={config.webdav.username}
              onChange={(event) => updateWebdav('username', event.target.value)}
            />
            <input
              placeholder="应用密码"
              type="password"
              value={config.webdav.password}
              onChange={(event) => updateWebdav('password', event.target.value)}
            />
            <input
              placeholder="远程目录（如 /PCTime）"
              value={config.webdav.remotePath}
              onChange={(event) => updateWebdav('remotePath', event.target.value)}
            />
            <input
              placeholder="同步间隔（分钟）"
              type="number"
              min={1}
              value={config.webdav.syncIntervalMinutes}
              onChange={(event) => updateWebdav('syncIntervalMinutes', Number(event.target.value))}
            />
            <div className="webdav-schedule">
              <label>自动同步方式</label>
              <select
                value={config.webdav.syncMode}
                onChange={(event) => updateWebdav('syncMode', event.target.value)}
              >
                <option value="interval">每隔N分钟</option>
                <option value="onClose">关闭软件前</option>
                <option value="daily">每天固定时间</option>
                <option value="weekly">每周固定时间</option>
              </select>
            </div>
            {(config.webdav.syncMode === 'daily' || config.webdav.syncMode === 'weekly') && (
              <div className="webdav-schedule">
                <label>同步时间</label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={config.webdav.syncHour}
                  onChange={(event) => updateWebdav('syncHour', Number(event.target.value))}
                />
                <span>:</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={config.webdav.syncMinute}
                  onChange={(event) => updateWebdav('syncMinute', Number(event.target.value))}
                />
              </div>
            )}
            {config.webdav.syncMode === 'weekly' && (
              <div className="webdav-schedule">
                <label>每周</label>
                <select
                  value={config.webdav.syncWeekday}
                  onChange={(event) => updateWebdav('syncWeekday', Number(event.target.value))}
                >
                  <option value={1}>周一</option>
                  <option value={2}>周二</option>
                  <option value={3}>周三</option>
                  <option value={4}>周四</option>
                  <option value={5}>周五</option>
                  <option value={6}>周六</option>
                  <option value={0}>周日</option>
                </select>
              </div>
            )}
            <div className="webdav-actions">
              <button type="button" onClick={testWebdav} disabled={syncBusy}>
                测试连接
              </button>
              <button type="button" onClick={syncNow} disabled={syncBusy}>
                立即同步
              </button>
              {syncStatus && <span className="sync-status">{syncStatus}</span>}
              {config.webdav.lastSyncAt && (
                <span className="sync-status">上次同步: {config.webdav.lastSyncAt}</span>
              )}
            </div>
            <p className="hint">密码仅保存在本机，不会上传到代码仓库。</p>
          </div>
        )}
      </section>
    </div>
  )
}

export default App
