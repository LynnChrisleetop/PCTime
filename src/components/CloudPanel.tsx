import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { cloudError, createBrowserCloudApi, demoCloudSummary, normalizeServerUrl } from '../lib/cloud'
import type { CloudState, CloudSummary } from '../lib/cloud'
import { duration, shiftDate, todayKey } from '../lib/usage'
import './CloudPanel.css'

function DeviceIcon({ phone = false }: { phone?: boolean }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    {phone ? <><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10 5h4M11 19h2" /></>
      : <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8m-4-4v4" /></>}
  </svg>
}

function syncedAt(value: string | null): string {
  if (!value) return '尚未同步'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '同步时间未知'
  return `${date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

const emptyState: CloudState = { serverUrl: '', user: null, device: null, syncing: false, lastSyncedAt: null, error: null }

export default function CloudPanel({ demo = false, onUseLocal }: { demo?: boolean; onUseLocal?: () => void }) {
  const native = !!window.cloud
  const api = useMemo(() => window.cloud ?? createBrowserCloudApi(), [])
  const [state, setState] = useState<CloudState>(emptyState)
  const [initialized, setInitialized] = useState(demo)
  const [serverUrl, setServerUrl] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [deviceName, setDeviceName] = useState('我的电脑')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [date, setDate] = useState(todayKey)
  const [deviceId, setDeviceId] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [summary, setSummary] = useState<{ key: string; value: CloudSummary } | null>(null)
  const [loading, setLoading] = useState(false)
  const [readError, setReadError] = useState('')
  const generation = useRef(0)
  const mounted = useRef(true)
  const loggedIn = demo || !!state.user
  const summaryKey = `${demo ? 'demo' : `${state.serverUrl}:${state.user?.id ?? ''}`}:${date}`

  useEffect(() => {
    mounted.current = true
    if (demo) return () => { mounted.current = false }
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const ownGeneration = generation.current
      try {
        const next = await api.getState()
        if (active && ownGeneration === generation.current) {
          setState(next)
          setInitialized(true)
          setServerUrl((previous) => previous || next.serverUrl)
        }
      } catch (cause) {
        if (active && ownGeneration === generation.current) {
          setError(cloudError(cause))
          setInitialized(true)
        }
      } finally { if (active) timer = setTimeout(poll, 3000) }
    }
    void poll()
    return () => { active = false; mounted.current = false; clearTimeout(timer) }
  }, [api, demo])

  useEffect(() => {
    if (!loggedIn) { setSummary(null); return }
    let active = true
    let timer: ReturnType<typeof setTimeout>
    setLoading(true)
    setReadError('')
    const read = async () => {
      try {
        const value = demo ? demoCloudSummary(date) : await api.getSummary(date)
        if (active) { setSummary({ key: summaryKey, value }); setReadError('') }
      } catch (cause) {
        if (active) setReadError(cloudError(cause))
        if (!demo && active) {
          const next = await api.getState().catch(() => null)
          if (active && next && !next.user) setState(next)
        }
      } finally {
        if (active) { setLoading(false); timer = setTimeout(read, 30000) }
      }
    }
    void read()
    return () => { active = false; clearTimeout(timer) }
  }, [api, demo, date, loggedIn, summaryKey, refresh, state.lastSyncedAt])

  const data = summary?.key === summaryKey ? summary.value : null
  const selectedDevice = data?.devices.find((device) => device.id === deviceId)
  const activeDevice = selectedDevice?.id ?? ''
  const apps = useMemo(() => (data?.apps ?? []).map((app) => {
    const devices = app.devices.filter((device) => !activeDevice || device.deviceId === activeDevice)
    return { ...app, devices, totalMs: devices.reduce((sum, device) => sum + device.totalMs, 0) }
  }).filter((app) => app.totalMs > 0).sort((a, b) => b.totalMs - a.totalMs), [data, activeDevice])
  const total = selectedDevice?.totalMs ?? data?.totalMs ?? 0
  const minutes = Math.floor(total / 60000)
  const selectedDevices = data?.devices.filter((device) => !activeDevice || device.id === activeDevice) ?? []

  async function authenticate(event: FormEvent) {
    event.preventDefault()
    setError(''); setNotice('')
    try {
      const url = normalizeServerUrl(serverUrl)
      generation.current += 1
      setBusy('auth')
      const next = await api.authenticate({ serverUrl: url, email, password, mode, deviceName: deviceName.trim() })
      if (!mounted.current) return
      setState(next)
      setPassword('')
      setDeviceId('')
      if (next.user && !next.error) setNotice(native ? '已连接账号，应用时长已同步。' : '已登录。这里可以查看账号统计；本页面不采集设备时间。')
      setRefresh((value) => value + 1)
    } catch (cause) { if (mounted.current) setError(cloudError(cause)) }
    finally { generation.current += 1; if (mounted.current) setBusy('') }
  }

  async function sync() {
    setError(''); setNotice(''); setBusy('sync'); generation.current += 1
    try {
      if (demo) setNotice('演示已刷新。示例展示同一应用在电脑和手机上的合计。')
      else {
        const next = await api.syncNow()
        if (!mounted.current) return
        setState(next)
        if (!next.error) setNotice(native ? '同步完成，已更新各设备统计。' : '已请求最新统计。')
      }
      if (mounted.current) setRefresh((value) => value + 1)
    } catch (cause) { if (mounted.current) setError(cloudError(cause)) }
    finally { generation.current += 1; if (mounted.current) setBusy('') }
  }

  async function logout() {
    setBusy('logout'); setError(''); setNotice(''); generation.current += 1
    // Hide the previous account immediately, even if revocation is offline.
    setSummary(null)
    setState((previous) => ({ ...previous, user: null, device: null, lastSyncedAt: null }))
    try {
      const next = await api.logout()
      if (mounted.current) { setState(next); setDeviceId(''); setPassword('') }
    } catch (cause) {
      if (mounted.current) { setState(emptyState); setError(cloudError(cause)) }
    } finally { generation.current += 1; if (mounted.current) setBusy('') }
  }

  return <div className="cloud-panel">
    {(error || state.error) && <div className="notice error" role="alert">{error || state.error}</div>}
    {notice && <div className="notice info" role="status">{notice}</div>}
    {!initialized ? <section className="panel cloud-loading" role="status">正在连接账号…</section> : !loggedIn ? (
      <div className="cloud-onboarding">
        <section className="cloud-intro panel">
          <span className="eyebrow">YOUR SCREENS, TOGETHER</span>
          <h2>换一块屏幕，<br />时间也连得上。</h2>
          <p>电脑上的工作，手机里的日常。放在一起，看看今天的时间去了哪里。</p>
          <div className="cloud-device-illustration" aria-hidden="true">
            <span className="cloud-screen desktop"><DeviceIcon /><i /><i /><i /></span>
            <span className="cloud-connection">＋</span>
            <span className="cloud-screen phone"><DeviceIcon phone /><i /><i /></span>
          </div>
          <ul className="cloud-benefits">
            <li><span>01</span><div><strong>总览，也能分开看</strong><p>按天汇总，随时切换电脑或手机。</p></div></li>
            <li><span>02</span><div><strong>同一个应用，一份合计</strong><p>微信、哔哩哔哩跨设备合并，展开就能看来源。</p></div></li>
            <li><span>03</span><div><strong>离线照常记录</strong><p>连接后补传应用时长，窗口标题留在电脑。</p></div></li>
          </ul>
        </section>
        <section className="panel cloud-login">
          <h2>先从这台设备开始</h2>
          <p className="muted">本机统计无需账号。Windows 打开“概览”即可查看记录，手机授权后即可使用。</p>
          <p className="muted">统一在线同步尚未开放。服务上线后，登录同一账号就能合并手机与电脑的时间。</p>
          {onUseLocal && <button className="button button-primary" onClick={onUseLocal}>查看本机记录</button>}
          <details className="cloud-setup-help">
          <summary>高级设置 · 连接已有同步服务</summary>
          <p className="muted">仅在你已拥有同步服务时填写。两台设备使用相同的服务地址和账号。</p>
          <div className="segmented cloud-auth-tabs" aria-label="账号操作">
            <button type="button" aria-pressed={mode === 'login'} className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError('') }} disabled={!!busy}>登录</button>
            <button type="button" aria-pressed={mode === 'register'} className={mode === 'register' ? 'selected' : ''} onClick={() => { setMode('register'); setError('') }} disabled={!!busy}>创建账号</button>
          </div>
          <form onSubmit={(event) => void authenticate(event)}>
            <label>同步服务地址<input type="url" autoComplete="url" required placeholder="https://time.example.com" value={serverUrl} disabled={!!busy} onChange={(event) => setServerUrl(event.target.value)} /></label>
            <label>邮箱<input type="email" autoComplete="username" required maxLength={254} placeholder="you@example.com" value={email} disabled={!!busy} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>密码<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={10} maxLength={128} placeholder="至少 10 个字符" value={password} disabled={!!busy} onChange={(event) => setPassword(event.target.value)} /></label>
            {native && <label>这台电脑的名字<input required maxLength={80} value={deviceName} disabled={!!busy} onChange={(event) => setDeviceName(event.target.value)} /></label>}
            <p className="cloud-consent">{native ? '登录后会同步本版本开始记录的应用名称和使用时长。原有历史仍可在“概览”查看；退出账号即可停止上传。' : '浏览器仅用于查看统计。登录状态仅在本页保存，刷新页面后需要重新登录。'}</p>
            <button className="button button-primary cloud-submit" type="submit" disabled={!!busy}>{busy === 'auth' ? '正在连接…' : mode === 'register' ? '创建账号并连接' : '登录并连接'}</button>
          </form>
          <details className="cloud-setup-help"><summary>还没有同步服务？</summary><p>这一版支持自行部署。先按项目中的《跨设备使用指南》启动服务；电脑可填写 http://127.0.0.1:4318，手机填写电脑的局域网 IP。公网部署使用 HTTPS。</p><p>首次注册不发送验证邮件。请保存好密码；此版本暂不支持找回密码。</p></details>
          </details>
        </section>
      </div>
    ) : <>
      <div className="cloud-account-bar">
        <div className="cloud-account-identity"><span className="cloud-account-dot" /><span>{demo ? '演示账号' : state.user?.email}<small>{demo ? '示例数据 · 不上传记录' : native ? state.device?.name ?? '正在连接这台电脑' : '浏览器查看模式'}</small></span></div>
        <div className="cloud-account-actions"><span className="muted">{demo ? '跨设备预览' : native ? `本机同步 ${syncedAt(state.lastSyncedAt)}` : '来自已连接的设备'}</span><button className="button" disabled={!!busy || state.syncing} onClick={() => void sync()}>{busy === 'sync' || state.syncing ? '正在同步…' : native ? '立即同步' : '刷新统计'}</button>{!demo && <button className="text-button" disabled={!!busy || state.syncing} onClick={() => void logout()}>{busy === 'logout' ? '正在退出…' : '退出账号'}</button>}</div>
      </div>
      <div className="cloud-toolbar">
        <div className="segmented cloud-view-tabs" aria-label="设备筛选"><button className={!activeDevice ? 'selected' : ''} aria-pressed={!activeDevice} onClick={() => setDeviceId('')}>全部设备</button>{data?.devices.map((device) => <button key={device.id} className={activeDevice === device.id ? 'selected' : ''} aria-pressed={activeDevice === device.id} onClick={() => setDeviceId(device.id)}>{device.name}</button>)}</div>
        <div className="cloud-date"><button className="icon-button" aria-label="跨设备统计前一天" onClick={() => setDate(shiftDate(date, -1))}>←</button><input type="date" aria-label="跨设备统计日期" value={date} max={todayKey()} onChange={(event) => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value) && event.target.value <= todayKey()) setDate(event.target.value) }} /><button className="icon-button" aria-label="跨设备统计后一天" disabled={date >= todayKey()} onClick={() => setDate(shiftDate(date, 1))}>→</button>{date !== todayKey() && <button className="text-button" onClick={() => setDate(todayKey())}>今天</button>}</div>
      </div>
      {readError && <div className="notice error" role="alert"><span>{readError}{data ? ' 当前保留上次成功读取的数据。' : ''}</span><button className="button" onClick={() => setRefresh((value) => value + 1)}>重试</button></div>}
      {!data ? <section className="panel cloud-loading" role="status">{loading ? '正在读取各设备统计…' : '暂时没有可显示的统计。'}</section> : <>
        <div className="cloud-summary-grid" aria-busy={loading}>
          <section className="panel cloud-total">
            <span className="eyebrow">{date === todayKey() ? '今天' : date} · {selectedDevice ? selectedDevice.name : '各设备合计'}</span>
            <div className="total-time" aria-label={duration(total)}>{Math.floor(minutes / 60)}<span>小时</span>{minutes % 60}<span>分钟</span></div>
            <p className="cloud-total-caption">{total > 0 && total < 60000 ? `已记录 ${Math.floor(total / 1000)} 秒` : selectedDevice ? '这块屏幕上的日常，尽在这里。' : '每一块屏幕，拼出今天的日常。'}</p>
            <div className="cloud-device-bar" aria-hidden="true">{selectedDevices.map((device) => <span key={device.id} className={device.platform} style={{ width: `${total ? device.totalMs / total * 100 : 0}%` }} />)}</div>
            <p className="cloud-sum-note">按设备累加：电脑、手机同时各用 10 分钟，合计为 20 分钟。</p>
          </section>
          <section className="panel cloud-devices">
            <div className="section-heading"><h2>我的设备</h2><span className="cloud-count">{data.devices.length} 台已连接</span></div>
            {data.devices.length ? data.devices.map((device) => <button className={`cloud-device-row ${activeDevice === device.id ? 'selected' : ''}`} key={device.id} onClick={() => setDeviceId(activeDevice === device.id ? '' : device.id)} aria-pressed={activeDevice === device.id}>
              <span className={`cloud-device-icon ${device.platform}`}><DeviceIcon phone={device.platform === 'android'} /></span><span className="cloud-device-name"><strong>{device.name}</strong><small>{device.platform === 'android' ? 'Android' : 'Windows'} · {syncedAt(device.lastSyncedAt)}</small></span><strong className="cloud-device-duration">{duration(device.totalMs)}</strong>
            </button>) : <p className="cloud-empty-copy">账号已就绪。在 Windows 或 Android 应用里登录，设备就会出现在这里。</p>}
          </section>
        </div>
        <section className="panel cloud-apps">
          <div className="section-heading"><div><h2>应用合计</h2><p className="muted">{selectedDevice ? `${selectedDevice.name} 的应用使用时间` : '同一个应用，汇总在一起。展开查看每台设备的时长。'}</p></div><span className="cloud-count">{apps.length} 个应用</span></div>
          {apps.length ? <div className="cloud-app-list">{apps.map((app, index) => <details className="cloud-app" key={app.canonicalId}>
            <summary><span className={`cloud-app-badge tone-${index % 4}`} aria-hidden="true">{app.name.slice(0, 1)}</span><span className="cloud-app-main"><strong>{app.name}</strong><span>{app.devices.length > 1 ? `${app.devices.length} 台设备合并` : app.devices[0]?.name}</span></span><span className="cloud-app-meter" aria-hidden="true"><span style={{ transform: `scaleX(${app.totalMs / (apps[0]?.totalMs || 1)})` }} /></span><strong className="cloud-app-duration">{duration(app.totalMs)}</strong><span className="cloud-expand" aria-hidden="true">⌄</span></summary>
            <div className="cloud-breakdown">{app.devices.map((device) => <div key={device.deviceId}><span className={`cloud-platform-dot ${device.platform}`} /><span>{device.name}<small>{device.platform === 'android' ? 'Android' : 'Windows'}</small></span><strong>{duration(device.totalMs)}</strong></div>)}</div>
          </details>)}</div> : <div className="cloud-empty"><DeviceIcon phone={selectedDevice?.platform === 'android'} /><h3>这一天，还没有同步的记录</h3><p>{date === todayKey() ? '在设备上使用一些应用，再点“立即同步”。Android 需要先允许“使用情况访问”。' : '选择其他日期，或在设备上同步已有记录。升级前的电脑历史保留在“概览”中。'}</p></div>}
        </section>
        <div className="cloud-footnote"><span>以各设备当地日期归档 · 设备列表标注最近同步时间</span><span>已识别的同名应用自动合并；其他应用按平台保留。</span></div>
      </>}
    </>}
  </div>
}
