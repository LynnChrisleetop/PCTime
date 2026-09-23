export function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function shiftDate(key: string, offset: number) {
  const [year, month, day] = key.split('-').map(Number)
  return todayKey(new Date(year, month - 1, day + offset))
}

export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes} 分钟`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

export function clockDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

export function percentage(ms: number, total: number) {
  return total > 0 ? Math.round((ms / total) * 100) : 0
}

export function exportData(summary: UsageSummary, type: 'csv' | 'json') {
  // A usage export contains statistics only, never WebDAV credentials or settings.
  if (type === 'json') return JSON.stringify({ summary }, null, 2)
  const rows = [
    ['类型', '名称', '应用', '时长（秒）'],
    ...summary.apps.map((item) => [
      '应用',
      item.app,
      '',
      String(Math.round(item.totalMs / 1000)),
    ]),
    ...summary.windows.map((item) => [
      '窗口',
      item.title || '无标题',
      item.app,
      String(Math.round(item.totalMs / 1000)),
    ]),
    ...(summary.categories ?? []).map((item) => [
      '分类',
      item.category,
      '',
      String(Math.round(item.totalMs / 1000)),
    ]),
  ]
  const quote = (value: string) => {
    // Prevent window titles beginning with spreadsheet formulas from being executed.
    const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value
    return `"${safe.replace(/"/g, '""')}"`
  }
  return '\uFEFF' + rows.map((row) => row.map(quote).join(',')).join('\r\n')
}

export function searchUsage(
  summary: UsageSummary | null,
  kind: 'apps' | 'windows',
  query: string,
  appFilter = ''
) {
  const entries =
    kind === 'apps'
      ? (summary?.apps ?? []).map((item) => ({ ...item, title: item.app }))
      : (summary?.windows ?? [])
  const needle = query.trim().toLocaleLowerCase()
  return entries.filter(
    (item) =>
      (!appFilter || item.app === appFilter) &&
      `${item.app} ${item.title}`.toLocaleLowerCase().includes(needle)
  )
}
