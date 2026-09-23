import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArcElement, Chart as ChartJS, Tooltip } from 'chart.js'
import type { ChartData, ChartOptions } from 'chart.js'
import { Doughnut } from 'react-chartjs-2'
import SettingsPanel from './components/SettingsPanel'
import CloudPanel from './components/CloudPanel'
import {
  clockDuration,
  duration,
  exportData,
  percentage,
  searchUsage,
  shiftDate,
  todayKey,
} from './lib/usage'
import './App.css'

ChartJS.register(ArcElement, Tooltip)

type Page = 'overview' | 'activity' | 'rules' | 'settings' | 'cloud'
type Notice = { kind: 'success' | 'error' | 'info'; text: string }
const ranges: Array<[UsageSummary['range'], string]> = [
  ['today', '今天'],
  ['week', '近 7 天'],
  ['month', '本月'],
]
const rangeNames = {
  today: '今天',
  week: '近 7 天',
  month: '本月',
  year: '近一年',
  all: '全部时间',
  date: '指定日期',
}
const pageInfo: Record<Page, [string, string]> = {
  cloud: ['跨设备', '电脑与手机的时间，在这里相遇。'],
  overview: ['时间概览', '看看今天的时间，都去了哪里。'],
  activity: ['使用明细', '从应用到窗口，每一段时间都有迹可循。'],
  rules: ['分类规则', '给时间一个归属，让统计更贴近你的日常。'],
  settings: ['偏好设置', '按你的习惯，安排记录与同步。'],
}

function Icon({
  name,
  size = 20,
}: {
  name:
    | 'clock'
    | 'grid'
    | 'list'
    | 'tag'
    | 'settings'
    | 'arrow'
    | 'download'
    | 'search'
    | 'monitor'
    | 'chevron'
  size?: number
}) {
  const paths = {
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    grid: (
      <>
        <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
        <rect x="14.5" y="3.5" width="6" height="6" rx="1" />
        <rect x="3.5" y="14.5" width="6" height="6" rx="1" />
        <rect x="14.5" y="14.5" width="6" height="6" rx="1" />
      </>
    ),
    list: (
      <>
        <path d="M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01" />
      </>
    ),
    tag: (
      <>
        <path d="m3 4 8-.5 10 10-7.5 7.5-10-10Z" />
        <circle cx="8" cy="8" r="1" />
      </>
    ),
    settings: (
      <>
        <path d="M4 6h16M4 12h16M4 18h16" />
        <rect x="7" y="4" width="3" height="4" rx="1" />
        <rect x="14" y="10" width="3" height="4" rx="1" />
        <rect x="8" y="16" width="3" height="4" rx="1" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6.5" />
        <path d="m15 15 5 5" />
      </>
    ),
    monitor: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

function AppBadge({ app }: { app: string }) {
  const colors = ['blue', 'coral', 'sand', 'slate']
  const hash = Array.from(app).reduce(
    (value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) >>> 0,
    0
  )
  const index = (hash ^ (hash >>> 16)) >>> 0
  return (
    <span className={`app-badge ${colors[index % colors.length]}`} aria-hidden="true">
      {app
        .replace(/^Microsoft /, '')
        .slice(0, 1)
        .toUpperCase()}
    </span>
  )
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(preference.matches)
    update()
    preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [])
  return reduced
}

function App() {
  const api = window.usage
  const isDemo =
    import.meta.env.DEV &&
    new URLSearchParams(location.search).get('demo') === '1' &&
    !window.ipcRenderer
  const cloudViewer = !api && new URLSearchParams(location.search).get('cloud') === '1'
  const [page, setPage] = useState<Page>(cloudViewer || new URLSearchParams(location.search).get('view') === 'cloud' ? 'cloud' : 'overview')
  const [range, setRange] = useState<UsageSummary['range']>('today')
  const [selectedDate, setSelectedDate] = useState(todayKey())
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [config, setConfig] = useState<UsageConfig | null>(null)
  const [configError, setConfigError] = useState('')
  const [summaryError, setSummaryError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshId, setRefreshId] = useState(0)
  const [exportBusy, setExportBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'apps' | 'windows'>('apps')
  const [appFilter, setAppFilter] = useState('')
  const [listPage, setListPage] = useState(1)
  const [chartUpdateMode, setChartUpdateMode] = useState<'default' | 'none'>('none')
  const reducedMotion = useReducedMotion()
  const lastLoadedSelection = useRef<string | null>(null)
  const exportMenu = useRef<HTMLDetailsElement>(null)

  const reloadConfig = useCallback(async () => {
    try {
      const data = await api.getConfig()
      setConfig(data)
      setConfigError('')
      return data
    } catch (error) {
      setConfigError('配置读取失败，请重试。')
      throw error
    }
  }, [api])

  useEffect(() => {
    if (api) void reloadConfig().catch(() => undefined)
  }, [api, reloadConfig])

  useEffect(() => {
    if (!api) {
      setLoading(false)
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout>
    // Keep the chart mounted while changing ranges. Its labels continue to
    // describe the displayed response until the replacement has arrived.
    setLoading(true)
    setSummaryError('')
    const selection = range === 'date' ? `date:${selectedDate}` : range
    const poll = async () => {
      try {
        const data = await api.getSummary(
          range,
          range === 'date' ? selectedDate : undefined
        )
        if (active) {
          setChartUpdateMode(
            lastLoadedSelection.current !== null &&
              lastLoadedSelection.current !== selection
              ? 'default'
              : 'none'
          )
          lastLoadedSelection.current = selection
          setSummary(data)
          setSummaryError('')
        }
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message.replace(
                /^Error invoking remote method '[^']+':\s*(Error: )?/,
                ''
              )
            : ''
        if (active) setSummaryError(detail || '统计暂时无法更新，请重试。')
      } finally {
        if (active) {
          setLoading(false)
          timer = setTimeout(poll, 2000)
        }
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, range, selectedDate, refreshId])

  const saveConfig = useCallback(
    async (next: UsageConfig) => {
      const saved = await api.setConfig(next)
      setConfig(saved)
      setRefreshId((value) => value + 1)
      return saved
    },
    [api]
  )

  const total = (summary?.apps ?? []).reduce(
    (sum, item) => sum + item.totalMs,
    0
  )
  const categories = useMemo(
    () =>
      (summary?.categories ?? [])
        .filter((item) => item.totalMs > 0)
        .sort((a, b) => b.totalMs - a.totalMs),
    [summary]
  )
  const entries = useMemo(
    () => searchUsage(summary, kind, query, appFilter),
    [summary, kind, query, appFilter]
  )
  const pages = Math.max(1, Math.ceil(entries.length / 12))
  const currentPage = Math.min(listPage, pages)
  const visibleEntries = entries.slice((currentPage - 1) * 12, currentPage * 12)
  const topApp = summary?.apps[0]
  const isStats = page === 'overview' || page === 'activity'
  const displayedRange = summary?.range ?? range
  const rangeLabel = displayedRange === 'date'
    ? summary?.date ?? selectedDate
    : rangeNames[displayedRange]
  const requestedRangeLabel = range === 'date' ? selectedDate : rangeNames[range]
  const summaryMatchesSelection = Boolean(summary && summary.range === range &&
    (range !== 'date' || summary.date === selectedDate))
  const summaryPending = loading || !summaryMatchesSelection
  const isRecording = Boolean(summary?.current && !summaryPending &&
    !configError && !summaryError && !summary.trackingError && !summary.saveError)
  const totalMinutes = Math.floor(total / 60000)
  const chartData = useMemo<ChartData<'doughnut'>>(() => ({
    labels: categories.map((item) => item.category),
    datasets: [{
      data: categories.map((item) => item.totalMs),
      backgroundColor: categories.map((item) => config?.categoryColors[item.category] ?? '#cbd5df'),
      borderWidth: 4,
      borderColor: '#ffffff',
      borderRadius: 5,
      hoverOffset: 3,
    }],
  }), [categories, config?.categoryColors])
  const chartOptions = useMemo<ChartOptions<'doughnut'>>(() => ({
    cutout: '78%',
    maintainAspectRatio: false,
    animation: !reducedMotion && chartUpdateMode === 'default'
      ? {
          duration: 350,
          easing: 'easeOutQuart',
          animateRotate: false,
          animateScale: false,
          onComplete: () => setChartUpdateMode('none'),
        }
      : false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (context) => ` ${context.label}：${duration(Number(context.raw))}` } },
    },
  }), [reducedMotion, chartUpdateMode])

  useEffect(() => {
    setListPage(1)
  }, [query, kind, appFilter, range, selectedDate])

  const exportSummary = async (type: 'csv' | 'json') => {
    if (!summary || summaryPending || exportBusy) return
    if (exportMenu.current) exportMenu.current.open = false
    setExportBusy(true)
    try {
      const result = await api.saveExport(
        exportData(summary, type),
        `PCTime-${summary.range}-${summary.date}.${type}`
      )
      setNotice({
        kind: result.saved ? 'success' : 'info',
        text: result.saved
          ? `已导出 ${type.toUpperCase()} 文件。`
          : isDemo
            ? '演示模式不写入文件。请在桌面应用中导出。'
            : '已取消导出。',
      })
    } catch {
      setNotice({ kind: 'error', text: '导出失败，请检查保存位置后重试。' })
    } finally {
      setExportBusy(false)
    }
  }

  const showWindows = (app: string) => {
    if (summaryPending) return
    setAppFilter(app)
    setQuery('')
    setKind('windows')
    setPage('activity')
  }
  const selectRange = (next: UsageSummary['range']) => {
    setRange(next)
    setAppFilter('')
  }

  if (!api && !cloudViewer)
    return (
      <main className="connection-screen">
        <div className="brand-mark">
          <Icon name="clock" size={32} />
        </div>
        <h1>在桌面端，开始记录时间。</h1>
        <p>这个页面需要连接 PCTime 桌面应用，才能读取电脑使用记录。</p>
        <p className="muted">请运行 PCTime，或使用项目中的桌面开发命令启动。</p>
        <a className="button" href="?cloud=1">登录查看跨设备统计</a>
        {import.meta.env.DEV && (
          <a className="button button-primary" href="?demo=1">
            查看界面演示
          </a>
        )}
      </main>
    )

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳转到主要内容
      </a>
      <header className="topbar">
        <a
          className="brand"
          href="#overview"
          onClick={(event) => {
            event.preventDefault()
            setPage(cloudViewer ? 'cloud' : 'overview')
          }}
          aria-label="PCTime 首页"
        >
          <span className="brand-mark">
            <Icon name="clock" size={24} />
          </span>
          <span>
            PCTime<span className="brand-caption">每一刻，都有迹可循</span>
          </span>
        </a>
        <nav className="main-nav" aria-label="主导航">
          {(
            [
              ['overview', 'grid', '概览'],
              ['cloud', 'monitor', '跨设备'],
              ['activity', 'list', '明细'],
              ['rules', 'tag', '分类'],
              ['settings', 'settings', '设置'],
            ] as const
          ).map(([id, icon, label]) => (
            <button
              key={id}
              className={page === id ? 'nav-item active' : 'nav-item'}
              aria-current={page === id ? 'page' : undefined}
              disabled={cloudViewer && id !== 'cloud'}
              onClick={() => setPage(id)}
            >
              <Icon name={icon} size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="local-label">
          <span className="status-dot" />
          {cloudViewer ? '账号统计' : '本机记录'}
        </div>
      </header>

      <main id="main-content" className="main-content">
        {isDemo && (
          <div className="demo-banner">
            <span>
              <strong>界面演示</strong> · 当前显示示例数据，不代表真实使用记录。
            </span>
            <a href="/">退出演示</a>
          </div>
        )}
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR TIME, IN FOCUS</p>
            <h1>{pageInfo[page][0]}</h1>
            <p className="page-description">{pageInfo[page][1]}</p>
          </div>
          <div className="heading-date">
            <Icon name="clock" size={16} />
            {new Date().toLocaleDateString('zh-CN', {
              month: 'long',
              day: 'numeric',
              weekday: 'long',
            })}
          </div>
        </div>
        {configError && (
          <div className="notice error" role="alert">
            <span>{configError}</span>
            <button
              className="button button-quiet"
              onClick={() => void reloadConfig().catch(() => undefined)}
            >
              重试
            </button>
          </div>
        )}
        {summary?.trackingError && (
          <div className="notice error" role="alert">
            {summary.trackingError}
          </div>
        )}
        {summary?.saveError && (
          <div className="notice error" role="alert">
            {summary.saveError}
          </div>
        )}
        {notice && (
          <div
            className={`notice ${notice.kind}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
          >
            <span>{notice.text}</span>
            <button
              className="notice-close"
              aria-label="关闭提示"
              onClick={() => setNotice(null)}
            >
              ×
            </button>
          </div>
        )}

        {isStats && (
          <>
            <div className="toolbar">
              <div className="range-controls">
                <div className="segmented" aria-label="统计范围">
                  {ranges.map(([value, label]) => (
                    <button
                      key={value}
                      aria-pressed={range === value}
                      className={range === value ? 'selected' : ''}
                      onClick={() => selectRange(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <select
                  className={
                    ['year', 'all', 'date'].includes(range)
                      ? 'range-select chosen'
                      : 'range-select'
                  }
                  aria-label="更多统计范围"
                  value={['year', 'all', 'date'].includes(range) ? range : ''}
                  onChange={(event) =>
                    selectRange(event.target.value as UsageSummary['range'])
                  }
                >
                  <option value="" disabled>
                    更多范围
                  </option>
                  <option value="year">近一年</option>
                  <option value="all">全部时间</option>
                  <option value="date">指定日期</option>
                </select>
                {range === 'date' && (
                  <div className="date-controls">
                    <button
                      className="icon-button previous"
                      aria-label="前一天"
                      onClick={() =>
                        setSelectedDate(shiftDate(selectedDate, -1))
                      }
                    >
                      <Icon name="chevron" size={15} />
                    </button>
                    <input
                      aria-label="统计日期"
                      type="date"
                      max={todayKey()}
                      value={selectedDate}
                      onChange={(event) => {
                        if (
                          /^\d{4}-\d{2}-\d{2}$/.test(event.target.value) &&
                          event.target.value <= todayKey()
                        )
                          setSelectedDate(event.target.value)
                      }}
                    />
                    <button
                      className="icon-button"
                      aria-label="后一天"
                      disabled={selectedDate >= todayKey()}
                      onClick={() =>
                        setSelectedDate(shiftDate(selectedDate, 1))
                      }
                    >
                      <Icon name="chevron" size={15} />
                    </button>
                  </div>
                )}
              </div>
              <details
                className="export-menu"
                ref={exportMenu}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') event.currentTarget.open = false
                }}
              >
                <summary className="button">
                  <Icon name="download" size={16} />
                  {exportBusy ? '正在导出…' : '导出统计'}
                </summary>
                <div className="export-options">
                  <button
                    disabled={!summary || summaryPending || exportBusy}
                    onClick={() => void exportSummary('csv')}
                  >
                    CSV 表格<span>适合 Excel 查看</span>
                  </button>
                  <button
                    disabled={!summary || summaryPending || exportBusy}
                    onClick={() => void exportSummary('json')}
                  >
                    JSON 数据<span>完整使用统计</span>
                  </button>
                </div>
              </details>
            </div>
            {summary && summaryPending && !summaryError && (
              <p className="range-update" role="status">
                正在读取{requestedRangeLabel}，当前仍显示{rangeLabel}的统计。
              </p>
            )}
            {summaryError && (
              <div className="notice error" role="alert">
                <span>
                  {summaryError}
                  {summary && ` 当前显示${rangeLabel}上次读取的数据。`}
                </span>
                <button
                  className="button button-quiet"
                  onClick={() => setRefreshId((value) => value + 1)}
                >
                  重试
                </button>
              </div>
            )}
          </>
        )}

        {isStats && loading && !summary ? (
          <div
            className="loading-grid"
            role="status"
            aria-label="正在读取使用记录"
          >
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton wide" />
            <span className="sr-only">正在读取使用记录</span>
          </div>
        ) : page === 'overview' ? (
          <>
            <div className="overview-grid" aria-busy={loading}>
              <section className="panel time-panel">
                <span className="time-decoration" aria-hidden="true" hidden={totalMinutes >= 6000}>
                  <Icon name="clock" size={108} />
                </span>
                <div className="section-heading">
                  <span className="eyebrow">{rangeLabel} · 累计使用</span>
                  <span className="subtle-icon">
                    <Icon name="monitor" />
                  </span>
                </div>
                <div className="total-time" aria-label={duration(total)}>
                  {Math.floor(totalMinutes / 60)}
                  <span>小时</span>
                  {totalMinutes % 60}
                  <span>分钟</span>
                </div>
                <p className="time-caption">
                  {total > 0 && total < 60000
                    ? `已记录 ${Math.floor(total / 1000)} 秒`
                    : total > 0
                      ? '每一段时间，都有自己的去处。'
                      : '切换到其他应用，开始记录今天。'}
                </p>
                <div className="time-metrics">
                  <div>
                    <span className="metric-label">使用应用</span>
                    <strong>
                      {summary?.apps.length ?? 0}
                      <small>个</small>
                    </strong>
                  </div>
                  <div>
                    <span className="metric-label">最常使用</span>
                    <strong className="metric-app" title={topApp?.app}>
                      {topApp?.app ?? '暂无记录'}
                    </strong>
                    {topApp && (
                      <span className="metric-detail">
                        占总时长 {percentage(topApp.totalMs, total)}%
                      </span>
                    )}
                  </div>
                </div>
                <div className="time-note">
                  <span className="status-dot" />
                  {displayedRange === 'today'
                    ? '每 2 秒更新 · 空闲超过 60 秒暂停记录'
                    : '按所选范围汇总 · 仅统计活跃使用时间'}
                </div>
              </section>
              <section className="panel category-panel">
                <div className="section-heading">
                  <h2>时间分布</h2>
                  <button
                    className="text-button"
                    onClick={() => setPage('rules')}
                  >
                    管理分类
                    <Icon name="arrow" size={14} />
                  </button>
                </div>
                {categories.length ? (
                  <div className="distribution">
                    <div className="donut">
                      <Doughnut
                        aria-label="各分类使用时长分布，详细数据见右侧列表"
                        data={chartData}
                        options={chartOptions}
                        updateMode={reducedMotion ? 'none' : chartUpdateMode}
                      />
                      <div className="donut-label">
                        <strong>{categories.length}</strong>
                        <span>时间分类</span>
                      </div>
                    </div>
                    <ul className="category-legend">
                      {categories.map((item) => (
                        <li key={item.category}>
                          <div>
                            <span
                              className="category-dot"
                              style={{
                                background:
                                  config?.categoryColors[item.category] ??
                                  '#cbd5df',
                              }}
                            />
                            <span>{item.category}</span>
                            <span className="category-percent">
                              {percentage(item.totalMs, total)}%
                            </span>
                          </div>
                          <small>{duration(item.totalMs)}</small>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="empty-state chart-empty">
                    <Icon name="clock" size={34} />
                    <h3>还没有时间分布</h3>
                    <p>有了使用记录后，分类占比会显示在这里。</p>
                  </div>
                )}
              </section>
              <section className="panel ranking-panel">
                <div className="section-heading">
                  <div>
                    <h2>应用排行</h2>
                    <p className="muted">时间花在哪里，一目了然</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => {
                      setPage('activity')
                      setKind('apps')
                      setQuery('')
                      setAppFilter('')
                    }}
                  >
                    查看全部
                    <Icon name="arrow" size={14} />
                  </button>
                </div>
                {summary?.apps.length ? (
                  <div className="ranking-list">
                    {summary.apps.slice(0, 5).map((item, index) => (
                      <button
                        className="ranking-row"
                        key={item.app}
                        disabled={summaryPending}
                        onClick={() => showWindows(item.app)}
                        aria-label={`查看 ${item.app} 的窗口明细`}
                      >
                        <span className="rank-number">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <AppBadge app={item.app} />
                        <div className="rank-name">
                          <strong>{item.app}</strong>
                          <div className="usage-track">
                            <span
                              style={{
                                width: '100%',
                                transform: `scaleX(${Math.min(1, Math.max(0, percentage(item.totalMs, topApp?.totalMs ?? total) / 100))})`,
                              }}
                            />
                          </div>
                        </div>
                        <div className="rank-duration">
                          <strong>{duration(item.totalMs)}</strong>
                          <span>{percentage(item.totalMs, total)}%</span>
                        </div>
                        <Icon name="chevron" size={14} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <Icon name="monitor" size={34} />
                    <h3>
                      {displayedRange === 'today'
                        ? '今天的记录，从现在开始'
                        : '这个时间范围还没有记录'}
                    </h3>
                    <p>
                      {displayedRange === 'today'
                        ? '保持 PCTime 运行，切换到其他应用即可自动记录。'
                        : '试试其他日期，或返回今天查看实时记录。'}
                    </p>
                    {displayedRange !== 'today' && (
                      <button
                        className="button"
                        onClick={() => selectRange('today')}
                      >
                        返回今天
                      </button>
                    )}
                  </div>
                )}
              </section>
              <aside className="activity-aside">
                <section className="panel current-panel">
                  <div className="section-heading">
                    <h2>当前状态</h2>
                    <span
                      className={`live-label ${isRecording ? 'recording' : 'idle'}`}
                    >
                      <span className="status-dot" />
                      {summaryError
                        ? '连接异常'
                        : summary?.trackingError
                          ? '记录异常'
                          : summary?.saveError
                            ? '保存异常'
                            : summary?.current
                              ? isDemo ? '演示记录中' : '记录中'
                              : '等待活动'}
                    </span>
                  </div>
                  {summary?.current ? (
                    <>
                      <AppBadge app={summary.current.app} />
                      <h3>{summary.current.app}</h3>
                      <p
                        className="current-title"
                        title={summary.current.title}
                      >
                        {summary.current.title || '无窗口标题'}
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="idle-icon">
                        <Icon name="monitor" size={28} />
                      </div>
                      <h3>
                        {summaryError || summary?.trackingError
                          ? '记录暂时中断'
                          : '给时间留一点空白'}
                      </h3>
                      <p className="current-title">
                        {summaryError || summary?.trackingError
                          ? '请查看上方错误提示，处理后恢复记录。'
                          : '空闲、锁屏或查看 PCTime 时暂停记录，回到其他应用后自动继续。'}
                      </p>
                    </>
                  )}
                  <div className="current-footnote">
                    实时状态 · 与上方统计范围无关
                  </div>
                </section>
                <div className="local-note">
                  <Icon name="tag" size={19} />
                  <div>
                    <strong>为时间添加分类</strong>
                    <p>按应用和窗口标题自动归类，随时调整你的规则。</p>
                    <button
                      className="text-button"
                      onClick={() => setPage('rules')}
                    >
                      整理分类
                      <Icon name="arrow" size={14} />
                    </button>
                  </div>
                </div>
              </aside>
            </div>
          </>
        ) : page === 'activity' ? (
          <section className="panel detail-panel" aria-busy={loading}>
            <div className="section-heading detail-heading">
              <div className="segmented">
                <button
                  className={kind === 'apps' ? 'selected' : ''}
                  aria-pressed={kind === 'apps'}
                  onClick={() => {
                    setKind('apps')
                    setAppFilter('')
                  }}
                >
                  应用
                </button>
                <button
                  className={kind === 'windows' ? 'selected' : ''}
                  aria-pressed={kind === 'windows'}
                  onClick={() => setKind('windows')}
                >
                  窗口 / 页面
                </button>
              </div>
              <label className="search-box">
                <Icon name="search" size={17} />
                <input
                  aria-label="搜索应用或窗口标题"
                  type="search"
                  placeholder="搜索应用或窗口标题"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            </div>
            {appFilter && (
              <div className="filter-chip">
                应用：{appFilter}
                <button
                  aria-label="清除应用筛选"
                  onClick={() => setAppFilter('')}
                >
                  ×
                </button>
              </div>
            )}
            <div className="table-summary">
              {rangeLabel} · 共 {entries.length} 条
              {query || appFilter ? '匹配记录' : '记录'}
              <span>总使用时长 {duration(total)}</span>
            </div>
            {entries.length ? (
              <>
                <div className="usage-table-wrap">
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th scope="col">
                          {kind === 'apps' ? '应用名称' : '窗口 / 页面'}
                        </th>
                        <th scope="col">使用时长</th>
                        <th scope="col">占总时长</th>
                        {kind === 'apps' && (
                          <th scope="col">
                            <span className="sr-only">操作</span>
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleEntries.map((item) => (
                        <tr key={JSON.stringify([item.app, item.title])}>
                          <td>
                            <div className="table-app">
                              <AppBadge app={item.app} />
                              <div>
                                <strong title={item.title}>
                                  {item.title || '无标题'}
                                </strong>
                                {kind === 'windows' && <span>{item.app}</span>}
                              </div>
                            </div>
                          </td>
                          <td className="numeric">
                            {clockDuration(item.totalMs)}
                          </td>
                          <td>
                            <div className="table-share">
                              <span>{percentage(item.totalMs, total)}%</span>
                              <div className="usage-track">
                                <span
                                  style={{
                                    width: '100%',
                                    transform: `scaleX(${Math.min(1, Math.max(0, percentage(item.totalMs, total) / 100))})`,
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                          {kind === 'apps' && (
                            <td>
                              <button
                                className="text-button"
                                disabled={summaryPending}
                                onClick={() => showWindows(item.app)}
                              >
                                查看窗口
                                <Icon name="chevron" size={12} />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pagination">
                  <span>
                    第 {(currentPage - 1) * 12 + 1}–
                    {Math.min(currentPage * 12, entries.length)} 条，共{' '}
                    {entries.length} 条
                  </span>
                  <div>
                    <button
                      className="button"
                      disabled={currentPage <= 1}
                      onClick={() => setListPage(currentPage - 1)}
                    >
                      上一页
                    </button>
                    <span>
                      {currentPage} / {pages}
                    </span>
                    <button
                      className="button"
                      disabled={currentPage >= pages}
                      onClick={() => setListPage(currentPage + 1)}
                    >
                      下一页
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-state">
                <Icon name="search" size={32} />
                <h3>
                  {query || appFilter
                    ? '没有找到匹配记录'
                    : '这个时间范围还没有记录'}
                </h3>
                <p>
                  {query || appFilter
                    ? '试试更短的关键词，或清除筛选条件。'
                    : '切换时间范围，或保持 PCTime 运行以积累记录。'}
                </p>
                {(query || appFilter) && (
                  <button
                    className="button"
                    onClick={() => {
                      setQuery('')
                      setAppFilter('')
                    }}
                  >
                    清除筛选
                  </button>
                )}
              </div>
            )}
          </section>
        ) : null}

        {page === 'cloud' && <CloudPanel demo={isDemo} onUseLocal={cloudViewer ? undefined : () => setPage('overview')} />}

        <div hidden={isStats || page === 'cloud'}>
          {config ? (
            <SettingsPanel
              config={config}
              onSave={saveConfig}
              onReload={reloadConfig}
              section={page === 'rules' ? 'rules' : 'settings'}
            />
          ) : !isStats && !configError ? (
            <div className="panel empty-state" role="status">
              正在读取设置…
            </div>
          ) : null}
        </div>
        <footer className="app-footer">
          <span>
            PCTime <span className="footer-separator">/</span> 让时间看得见
          </span>
          <span>
            {page === 'cloud' ? '登录后同步应用时长 · 窗口标题保留在本机' : '统计保存在本机'}
            {config?.webdav.enabled ? ' · WebDAV 自动同步已开启' : ''}
          </span>
        </footer>
      </main>
    </div>
  )
}

export default App
