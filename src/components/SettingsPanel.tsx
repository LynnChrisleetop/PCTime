import { useEffect, useRef, useState } from 'react'
import './SettingsPanel.css'

type Props = {
  config: UsageConfig
  onSave: (next: UsageConfig) => Promise<UsageConfig>
  onReload: () => Promise<UsageConfig>
  section: 'rules' | 'settings'
}
type RuleDraft = Pick<
  UsageConfig,
  'categories' | 'defaultCategory' | 'categoryColors' | 'rules'
>
type SettingsDraft = Pick<UsageConfig, 'appSettings' | 'webdav'>
type Notice = { tone: 'success' | 'error'; text: string }
type Rule = UsageConfig['rules'][number]

const pickRules = (config: UsageConfig): RuleDraft => ({
  categories: config.categories,
  defaultCategory: config.defaultCategory,
  categoryColors: config.categoryColors,
  rules: config.rules,
})
const pickSettings = (config: UsageConfig): SettingsDraft => ({
  appSettings: config.appSettings,
  webdav: config.webdav,
})
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right)
const settingsKey = (settings: SettingsDraft) => ({
  ...settings,
  webdav: { ...settings.webdav, lastSyncAt: undefined },
})

function connectionErrors(webdav: UsageConfig['webdav']) {
  const errors: Record<string, string> = {}
  try {
    const url = new URL(webdav.url)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname)
      throw new Error()
  } catch {
    errors.url = '请输入完整的 http:// 或 https:// WebDAV 地址。'
  }
  if (!webdav.username.trim()) errors.username = '请输入 WebDAV 账号。'
  if (!webdav.password) errors.password = '请输入应用密码。'
  if (!webdav.remotePath.trim())
    errors.remotePath = '请输入远程目录，例如 /PCTime。'
  return errors
}

function readableError(error: unknown, fallback: string) {
  const detail =
    error instanceof Error
      ? error.message.replace(
          /^Error invoking remote method '[^']+':\s*(Error: )?/,
          ''
        )
      : ''
  return detail ? `${fallback}：${detail}` : `${fallback}，请重试。`
}

function lastSyncLabel(value?: string) {
  if (!value) return '尚未同步'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '同步时间未知'
    : date.toLocaleString('zh-CN', { hour12: false })
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="settings-toggle-row">
      <span className="settings-toggle-copy">
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
      <input
        className="settings-switch"
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

export default function SettingsPanel({
  config,
  onSave,
  onReload,
  section,
}: Props) {
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(() => pickRules(config))
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>(() =>
    pickSettings(config)
  )
  const previousConfig = useRef(config)
  const operation = useRef(false)
  const [pending, setPending] = useState<'save' | 'test' | 'sync' | null>(null)
  const [notices, setNotices] = useState<
    Partial<Record<Props['section'], Notice>>
  >({})
  const [syncNotice, setSyncNotice] = useState<Notice | null>(null)
  const [deletedRules, setDeletedRules] = useState<
    Array<{ rule: Rule; index: number }>
  >([])
  const [categoryName, setCategoryName] = useState('')
  const [categoryError, setCategoryError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [attemptedSave, setAttemptedSave] = useState(false)

  useEffect(() => {
    const previous = previousConfig.current
    setRuleDraft((current) =>
      same(current, pickRules(previous)) ? pickRules(config) : current
    )
    setSettingsDraft((current) =>
      same(settingsKey(current), settingsKey(pickSettings(previous)))
        ? pickSettings(config)
        : {
            ...current,
            webdav: { ...current.webdav, lastSyncAt: config.webdav.lastSyncAt },
          }
    )
    previousConfig.current = config
  }, [config])

  const rulesDirty = !same(ruleDraft, pickRules(config))
  const settingsDirty = !same(
    settingsKey(settingsDraft),
    settingsKey(pickSettings(config))
  )
  const dirty = section === 'rules' ? rulesDirty : settingsDirty
  const anyDirty = rulesDirty || settingsDirty
  const busy = pending !== null
  const webdav = settingsDraft.webdav
  const ruleErrors = ruleDraft.rules.filter(
    (rule) => !rule.appContains?.trim() && !rule.titleContains?.trim()
  )
  const webdavErrors = webdav.enabled ? connectionErrors(webdav) : {}
  if (
    webdav.enabled &&
    webdav.syncMode === 'interval' &&
    (!Number.isInteger(webdav.syncIntervalMinutes) ||
      webdav.syncIntervalMinutes < 1 ||
      webdav.syncIntervalMinutes > 1440)
  ) {
    webdavErrors.syncIntervalMinutes = '同步间隔必须是 1–1440 分钟的整数。'
  }
  if (
    webdav.enabled &&
    (webdav.syncMode === 'daily' || webdav.syncMode === 'weekly') &&
    (!Number.isInteger(webdav.syncHour) ||
      webdav.syncHour < 0 ||
      webdav.syncHour > 23 ||
      !Number.isInteger(webdav.syncMinute) ||
      webdav.syncMinute < 0 ||
      webdav.syncMinute > 59)
  ) {
    webdavErrors.syncTime = '请选择有效的同步时间。'
  }
  const invalid =
    section === 'rules'
      ? ruleErrors.length > 0
      : Object.keys(webdavErrors).length > 0
  const savedConnectionReady =
    Object.keys(connectionErrors(config.webdav)).length === 0
  const operationDisabledReason = anyDirty
    ? '有未保存的更改，请先保存或放弃更改，再测试连接或同步。'
    : !savedConnectionReady
      ? '填写并保存连接信息后，即可测试连接或立即同步。'
      : ''
  const syncDisabledReason =
    operationDisabledReason ||
    (!config.webdav.enabled
      ? '立即同步需要先开启并保存自动同步；保存后，下方同步计划也会生效。'
      : '')

  const clearNotice = (target: Props['section']) => {
    setNotices((current) => ({ ...current, [target]: undefined }))
    setSyncNotice(null)
  }

  const updateRule = (
    id: string,
    field: 'category' | 'appContains' | 'titleContains',
    value: string
  ) => {
    clearNotice('rules')
    setRuleDraft((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === id ? { ...rule, [field]: value } : rule
      ),
    }))
  }

  const updateWebdav = <K extends keyof UsageConfig['webdav']>(
    field: K,
    value: UsageConfig['webdav'][K]
  ) => {
    clearNotice('settings')
    setSettingsDraft((current) => ({
      ...current,
      webdav: { ...current.webdav, [field]: value },
    }))
  }

  const updateAppSetting = (
    field: keyof UsageConfig['appSettings'],
    value: boolean
  ) => {
    clearNotice('settings')
    setSettingsDraft((current) => ({
      ...current,
      appSettings: { ...current.appSettings, [field]: value },
    }))
  }

  const addRule = () => {
    clearNotice('rules')
    const id = crypto.randomUUID()
    setRuleDraft((current) => ({
      ...current,
      rules: [
        ...current.rules,
        {
          id,
          category: current.categories[0] ?? current.defaultCategory,
          appContains: '',
          titleContains: '',
        },
      ],
    }))
    requestAnimationFrame(() =>
      document.getElementById(`rule-app-${id}`)?.focus()
    )
  }

  const moveRule = (index: number, direction: number) => {
    clearNotice('rules')
    setRuleDraft((current) => {
      const rules = [...current.rules]
      const target = index + direction
      if (target < 0 || target >= rules.length) return current
      ;[rules[index], rules[target]] = [rules[target], rules[index]]
      return { ...current, rules }
    })
  }

  const removeRule = (rule: Rule, index: number) => {
    clearNotice('rules')
    setDeletedRules((current) => [...current, { rule, index }])
    setRuleDraft((current) => ({
      ...current,
      rules: current.rules.filter((item) => item.id !== rule.id),
    }))
  }

  const undoDelete = () => {
    const deleted = deletedRules[deletedRules.length - 1]
    if (!deleted) return
    setRuleDraft((current) => {
      const rules = [...current.rules]
      rules.splice(Math.min(deleted.index, rules.length), 0, deleted.rule)
      return { ...current, rules }
    })
    setDeletedRules((current) => current.slice(0, -1))
    clearNotice('rules')
  }

  const addCategory = () => {
    const name = categoryName.trim()
    if (!name) {
      setCategoryError('请先填写分类名称。')
      return
    }
    if (ruleDraft.categories.includes(name)) {
      setCategoryError('已有同名分类，请换一个名称。')
      return
    }
    setRuleDraft((current) => ({
      ...current,
      categories: [...current.categories, name],
      categoryColors: { ...current.categoryColors, [name]: '#147d9e' },
    }))
    setCategoryName('')
    setCategoryError('')
    clearNotice('rules')
  }

  const discard = () => {
    if (section === 'rules') {
      setRuleDraft(pickRules(config))
      setDeletedRules([])
      setCategoryName('')
      setCategoryError('')
    } else {
      setSettingsDraft(pickSettings(config))
      setAttemptedSave(false)
    }
    setNotices((current) => ({
      ...current,
      [section]: {
        tone: 'success',
        text: '已放弃本页更改，恢复到已保存的设置。',
      },
    }))
    setSyncNotice(null)
  }

  const save = async () => {
    if (operation.current || !dirty) return
    setAttemptedSave(true)
    if (invalid) {
      setNotices((current) => ({
        ...current,
        [section]: {
          tone: 'error',
          text:
            section === 'rules'
              ? '请为每条规则填写至少一个匹配条件，再保存。'
              : '请修正标出的连接信息或同步时间，再保存。',
        },
      }))
      return
    }
    operation.current = true
    setPending('save')
    clearNotice(section)
    try {
      const next =
        section === 'rules'
          ? { ...config, ...ruleDraft }
          : { ...config, ...settingsDraft }
      const saved = await onSave(next)
      if (section === 'rules') {
        setRuleDraft(pickRules(saved))
        setDeletedRules([])
      } else {
        setSettingsDraft(pickSettings(saved))
        setAttemptedSave(false)
      }
      setNotices((current) => ({
        ...current,
        [section]: {
          tone: 'success',
          text:
            section === 'rules'
              ? '分类规则已保存，统计会按新规则更新。'
              : '设置已保存。',
        },
      }))
    } catch (error) {
      setNotices((current) => ({
        ...current,
        [section]: {
          tone: 'error',
          text: readableError(error, '保存失败，草稿已保留'),
        },
      }))
    } finally {
      operation.current = false
      setPending(null)
    }
  }

  const runWebdav = async (action: 'test' | 'sync') => {
    if (
      operation.current ||
      (action === 'sync' ? syncDisabledReason : operationDisabledReason)
    )
      return
    operation.current = true
    setPending(action)
    setSyncNotice(null)
    try {
      if (!window.usage) throw new Error('请在 PCTime 桌面应用中操作')
      const result = await (action === 'test'
        ? window.usage.testWebdav()
        : window.usage.syncNow())
      if (!result.ok) {
        setSyncNotice({
          tone: 'error',
          text:
            result.message ||
            (action === 'test'
              ? '连接失败，请检查地址、账号及应用密码。'
              : '同步失败，请检查网络后重试。'),
        })
      } else if (action === 'sync') {
        try {
          const latest = await onReload()
          setSettingsDraft(pickSettings(latest))
          setRuleDraft(pickRules(latest))
          setSyncNotice({ tone: 'success', text: '同步完成，已更新本地数据。' })
        } catch {
          setSyncNotice({
            tone: 'error',
            text: '同步已完成，但未能刷新本地状态。请重新打开页面查看。',
          })
        }
      } else {
        setSyncNotice({
          tone: 'success',
          text: result.message || '连接成功，写入权限将在同步时验证。',
        })
      }
    } catch (error) {
      setSyncNotice({
        tone: 'error',
        text: readableError(error, action === 'test' ? '连接失败' : '同步失败'),
      })
    } finally {
      operation.current = false
      setPending(null)
    }
  }

  const webdavError = (field: string) =>
    attemptedSave && webdavErrors[field] ? (
      <span className="settings-field-error" id={`webdav-error-${field}`}>
        {webdavErrors[field]}
      </span>
    ) : null

  return (
    <div className="settings-root">
      <fieldset className="settings-fieldset" disabled={busy}>
        {section === 'rules' ? (
          <>
            <section className="panel settings-card">
              <div className="settings-card-heading">
                <div>
                  <p className="eyebrow">CATEGORIES</p>
                  <h2>让时间各有所属</h2>
                  <p className="muted">设置分类颜色，选择未匹配记录的归属。</p>
                </div>
                <label className="settings-field settings-default-category">
                  <span>默认分类</span>
                  <select
                    value={ruleDraft.defaultCategory}
                    onChange={(event) => {
                      clearNotice('rules')
                      setRuleDraft((current) => ({
                        ...current,
                        defaultCategory: event.target.value,
                      }))
                    }}
                  >
                    {ruleDraft.categories.map((category) => (
                      <option key={category}>{category}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="settings-colors">
                {ruleDraft.categories.map((category) => (
                  <label className="settings-color" key={category}>
                    <input
                      type="color"
                      aria-label={`${category}分类颜色`}
                      value={
                        /^#[\da-f]{6}$/i.test(
                          ruleDraft.categoryColors[category] ?? ''
                        )
                          ? ruleDraft.categoryColors[category]
                          : '#9ca3af'
                      }
                      onChange={(event) => {
                        clearNotice('rules')
                        setRuleDraft((current) => ({
                          ...current,
                          categoryColors: {
                            ...current.categoryColors,
                            [category]: event.target.value,
                          },
                        }))
                      }}
                    />
                    <span>{category}</span>
                  </label>
                ))}
              </div>
              <div className="settings-add-category">
                <label className="settings-field">
                  <span>新增分类</span>
                  <input
                    value={categoryName}
                    maxLength={24}
                    placeholder="例如：创作"
                    onChange={(event) => {
                      setCategoryName(event.target.value)
                      setCategoryError('')
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        addCategory()
                      }
                    }}
                    aria-invalid={Boolean(categoryError)}
                    aria-describedby={
                      categoryError ? 'category-name-error' : undefined
                    }
                  />
                </label>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={addCategory}
                >
                  添加分类
                </button>
              </div>
              {categoryError && (
                <p
                  className="settings-field-error"
                  id="category-name-error"
                  role="alert"
                >
                  {categoryError}
                </p>
              )}
            </section>

            <section className="panel settings-card">
              <div className="settings-card-heading">
                <div>
                  <p className="eyebrow">AUTO CLASSIFY</p>
                  <h2>
                    自动分类规则{' '}
                    <span className="settings-count">
                      {ruleDraft.rules.length}
                    </span>
                  </h2>
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  onClick={addRule}
                >
                  ＋ 新增规则
                </button>
              </div>
              <p className="settings-rule-guide">
                从上到下匹配，首条命中的规则生效。应用名和标题同时填写时，需要同时满足；匹配不区分大小写。
              </p>
              {deletedRules.length > 0 && (
                <div className="settings-undo" role="status">
                  <span>已移除 {deletedRules.length} 条规则，保存后生效。</span>
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={undoDelete}
                  >
                    撤销上次删除
                  </button>
                </div>
              )}
              {ruleDraft.rules.length === 0 ? (
                <div className="empty-state settings-empty">
                  <strong>还没有分类规则</strong>
                  <p>添加应用名或窗口标题关键词，使用记录会自动归类。</p>
                  <button type="button" className="button" onClick={addRule}>
                    创建第一条规则
                  </button>
                </div>
              ) : (
                <div className="settings-rule-list">
                  {ruleDraft.rules.map((rule, index) => {
                    const empty =
                      !rule.appContains?.trim() && !rule.titleContains?.trim()
                    return (
                      <div
                        className={`settings-rule ${empty ? 'settings-rule-invalid' : ''}`}
                        key={rule.id}
                      >
                        <div className="settings-rule-top">
                          <span className="settings-rule-number">
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          <strong>规则 {index + 1}</strong>
                          <div className="settings-rule-actions">
                            <button
                              className="button button-quiet settings-icon-button"
                              type="button"
                              disabled={index === 0}
                              title="提高优先级"
                              aria-label={`上移规则 ${index + 1}`}
                              onClick={() => moveRule(index, -1)}
                            >
                              ↑
                            </button>
                            <button
                              className="button button-quiet settings-icon-button"
                              type="button"
                              disabled={index === ruleDraft.rules.length - 1}
                              title="降低优先级"
                              aria-label={`下移规则 ${index + 1}`}
                              onClick={() => moveRule(index, 1)}
                            >
                              ↓
                            </button>
                            <button
                              className="button button-quiet settings-delete"
                              type="button"
                              aria-label={`删除规则 ${index + 1}`}
                              onClick={() => removeRule(rule, index)}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                        <div className="settings-rule-fields">
                          <label className="settings-field">
                            <span>应用名包含</span>
                            <input
                              id={`rule-app-${rule.id}`}
                              placeholder="例如：Microsoft Edge"
                              value={rule.appContains ?? ''}
                              onChange={(event) =>
                                updateRule(
                                  rule.id,
                                  'appContains',
                                  event.target.value
                                )
                              }
                              aria-invalid={empty}
                              aria-describedby={
                                empty ? `rule-error-${rule.id}` : undefined
                              }
                            />
                          </label>
                          <label className="settings-field">
                            <span>窗口标题包含</span>
                            <input
                              placeholder="例如：bilibili"
                              value={rule.titleContains ?? ''}
                              onChange={(event) =>
                                updateRule(
                                  rule.id,
                                  'titleContains',
                                  event.target.value
                                )
                              }
                              aria-invalid={empty}
                              aria-describedby={
                                empty ? `rule-error-${rule.id}` : undefined
                              }
                            />
                          </label>
                          <label className="settings-field">
                            <span>归入分类</span>
                            <select
                              value={rule.category}
                              onChange={(event) =>
                                updateRule(
                                  rule.id,
                                  'category',
                                  event.target.value
                                )
                              }
                            >
                              {ruleDraft.categories.map((category) => (
                                <option key={category}>{category}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                        {empty && (
                          <p
                            className="settings-field-error"
                            id={`rule-error-${rule.id}`}
                          >
                            至少填写应用名或窗口标题中的一项，空规则无法保存。
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </>
        ) : (
          <>
            <section className="panel settings-card">
              <div className="settings-card-heading">
                <div>
                  <p className="eyebrow">PREFERENCES</p>
                  <h2>启动与后台运行</h2>
                  <p className="muted">按你的习惯，让记录自然地融入日常。</p>
                </div>
              </div>
              <div className="settings-toggles">
                <Toggle
                  label="开机自动启动"
                  description="登录 Windows 后自动开始记录。"
                  checked={settingsDraft.appSettings.autoLaunch}
                  onChange={(checked) =>
                    updateAppSetting('autoLaunch', checked)
                  }
                />
                <Toggle
                  label="启动时收起到托盘"
                  description="启动后在后台记录，不打断当前工作。"
                  checked={settingsDraft.appSettings.startMinimized}
                  onChange={(checked) =>
                    updateAppSetting('startMinimized', checked)
                  }
                />
                <Toggle
                  label="最小化到托盘"
                  description="最小化后隐藏任务栏窗口，可从托盘重新打开。"
                  checked={settingsDraft.appSettings.minimizeToTray}
                  onChange={(checked) =>
                    updateAppSetting('minimizeToTray', checked)
                  }
                />
                <Toggle
                  label="关闭窗口后继续记录"
                  description="点击关闭仅收起窗口；要结束记录，请从托盘退出。"
                  checked={settingsDraft.appSettings.closeToTray}
                  onChange={(checked) =>
                    updateAppSetting('closeToTray', checked)
                  }
                />
              </div>
            </section>

            <section className="panel settings-card">
              <div className="settings-card-heading">
                <div>
                  <p className="eyebrow">SYNC</p>
                  <h2>WebDAV 云同步</h2>
                  <p className="muted">支持坚果云及其他 WebDAV 服务。</p>
                </div>
                <span
                  className={`settings-sync-badge ${webdav.enabled ? 'settings-sync-enabled' : ''}`}
                >
                  {webdav.enabled ? '自动同步已开启' : '自动同步已关闭'}
                </span>
              </div>
              <Toggle
                label="自动同步"
                description="启用并保存后按下方计划同步，也可以随时手动同步。"
                checked={webdav.enabled}
                onChange={(checked) => updateWebdav('enabled', checked)}
              />
              <div className="settings-webdav-grid">
                <label className="settings-field settings-full-width">
                  <span>服务器地址</span>
                  <input
                    type="url"
                    placeholder="https://dav.jianguoyun.com/dav/"
                    value={webdav.url}
                    onChange={(event) =>
                      updateWebdav('url', event.target.value)
                    }
                    aria-invalid={Boolean(attemptedSave && webdavErrors.url)}
                    aria-describedby={
                      webdavError('url') ? 'webdav-error-url' : undefined
                    }
                  />
                  {webdavError('url')}
                </label>
                <label className="settings-field">
                  <span>账号</span>
                  <input
                    autoComplete="username"
                    placeholder="填写 WebDAV 账号"
                    value={webdav.username}
                    onChange={(event) =>
                      updateWebdav('username', event.target.value)
                    }
                    aria-invalid={Boolean(
                      attemptedSave && webdavErrors.username
                    )}
                    aria-describedby={
                      webdavError('username')
                        ? 'webdav-error-username'
                        : undefined
                    }
                  />
                  {webdavError('username')}
                </label>
                <div className="settings-field">
                  <label htmlFor="webdav-password">应用密码</label>
                  <span className="settings-password">
                    <input
                      id="webdav-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="off"
                      placeholder="填写服务商提供的应用密码"
                      value={webdav.password}
                      onChange={(event) =>
                        updateWebdav('password', event.target.value)
                      }
                      aria-invalid={Boolean(
                        attemptedSave && webdavErrors.password
                      )}
                      aria-describedby={
                        webdavError('password')
                          ? 'webdav-error-password'
                          : undefined
                      }
                    />
                    <button
                      type="button"
                      className="settings-password-toggle"
                      aria-label={
                        showPassword ? '隐藏应用密码' : '显示应用密码'
                      }
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((current) => !current)}
                    >
                      {showPassword ? '隐藏' : '显示'}
                    </button>
                  </span>
                  {webdavError('password')}
                </div>
                <label className="settings-field settings-full-width">
                  <span>远程目录</span>
                  <input
                    placeholder="/PCTime"
                    value={webdav.remotePath}
                    onChange={(event) =>
                      updateWebdav('remotePath', event.target.value)
                    }
                    aria-invalid={Boolean(
                      attemptedSave && webdavErrors.remotePath
                    )}
                    aria-describedby={
                      webdavError('remotePath')
                        ? 'webdav-error-remotePath'
                        : undefined
                    }
                  />
                  {webdavError('remotePath')}
                </label>
              </div>
              <div className="settings-schedule">
                <label className="settings-field">
                  <span>自动同步方式</span>
                  <select
                    value={webdav.syncMode}
                    onChange={(event) =>
                      updateWebdav(
                        'syncMode',
                        event.target.value as UsageConfig['webdav']['syncMode']
                      )
                    }
                  >
                    <option value="interval">按时间间隔</option>
                    <option value="onClose">退出应用时</option>
                    <option value="daily">每天固定时间</option>
                    <option value="weekly">每周固定时间</option>
                  </select>
                </label>
                {webdav.syncMode === 'interval' && (
                  <label className="settings-field">
                    <span>间隔（分钟）</span>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      step={1}
                      value={
                        Number.isNaN(webdav.syncIntervalMinutes)
                          ? ''
                          : webdav.syncIntervalMinutes
                      }
                      onChange={(event) =>
                        updateWebdav(
                          'syncIntervalMinutes',
                          event.target.valueAsNumber
                        )
                      }
                      aria-invalid={Boolean(
                        attemptedSave && webdavErrors.syncIntervalMinutes
                      )}
                      aria-describedby={
                        webdavError('syncIntervalMinutes')
                          ? 'webdav-error-syncIntervalMinutes'
                          : undefined
                      }
                    />
                    {webdavError('syncIntervalMinutes')}
                  </label>
                )}
                {webdav.syncMode === 'weekly' && (
                  <label className="settings-field">
                    <span>每周</span>
                    <select
                      value={webdav.syncWeekday}
                      onChange={(event) =>
                        updateWebdav('syncWeekday', Number(event.target.value))
                      }
                    >
                      <option value={1}>星期一</option>
                      <option value={2}>星期二</option>
                      <option value={3}>星期三</option>
                      <option value={4}>星期四</option>
                      <option value={5}>星期五</option>
                      <option value={6}>星期六</option>
                      <option value={0}>星期日</option>
                    </select>
                  </label>
                )}
                {(webdav.syncMode === 'daily' ||
                  webdav.syncMode === 'weekly') && (
                  <label className="settings-field">
                    <span>本地时间</span>
                    <input
                      type="time"
                      value={
                        Number.isNaN(webdav.syncHour) ||
                        Number.isNaN(webdav.syncMinute)
                          ? ''
                          : `${String(webdav.syncHour).padStart(2, '0')}:${String(webdav.syncMinute).padStart(2, '0')}`
                      }
                      onChange={(event) => {
                        const [hour, minute] = event.target.value
                          .split(':')
                          .map(Number)
                        setSettingsDraft((current) => ({
                          ...current,
                          webdav: {
                            ...current.webdav,
                            syncHour: event.target.value ? hour : NaN,
                            syncMinute: event.target.value ? minute : NaN,
                          },
                        }))
                        clearNotice('settings')
                      }}
                      aria-invalid={Boolean(
                        attemptedSave && webdavErrors.syncTime
                      )}
                      aria-describedby={
                        webdavError('syncTime')
                          ? 'webdav-error-syncTime'
                          : undefined
                      }
                    />
                    {webdavError('syncTime')}
                  </label>
                )}
              </div>
              {webdav.syncMode === 'onClose' && (
                <p className="settings-help">
                  从托盘退出应用时同步；仅关闭窗口并继续后台运行时不会触发。
                </p>
              )}
              {(webdav.syncMode === 'daily' ||
                webdav.syncMode === 'weekly') && (
                <p className="settings-help">
                  自动同步需要 PCTime 正在运行，时间使用当前电脑的本地时区。
                </p>
              )}
              <div className="settings-sync-footer">
                <div className="settings-sync-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={busy || Boolean(operationDisabledReason)}
                    onClick={() => void runWebdav('test')}
                  >
                    {pending === 'test' ? '正在连接…' : '测试连接'}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busy || Boolean(syncDisabledReason)}
                    onClick={() => void runWebdav('sync')}
                  >
                    {pending === 'sync' ? '正在同步…' : '立即同步'}
                  </button>
                </div>
                <span className="settings-last-sync">
                  上次同步 · {lastSyncLabel(config.webdav.lastSyncAt)}
                </span>
              </div>
              {syncDisabledReason && (
                <p className="settings-help">{syncDisabledReason}</p>
              )}
              {syncNotice && (
                <div
                  className={`settings-notice settings-notice-${syncNotice.tone}`}
                  role={syncNotice.tone === 'error' ? 'alert' : 'status'}
                >
                  {syncNotice.text}
                </div>
              )}
              <div className="settings-sync-note">
                <strong>同步会如何处理数据？</strong>
                <p>
                  分类规则和颜色会备份到远端，应用密码与启动偏好不会上传，也不会用远端设置覆盖本机。相同日期、相同窗口的记录保留较大时长，多个设备的使用时间不会累加。
                </p>
              </div>
            </section>
          </>
        )}
      </fieldset>
      <div className="settings-savebar">
        <div className="settings-save-copy">
          <strong>{dirty ? '有未保存的更改' : '所有更改已保存'}</strong>
          <span>
            {dirty
              ? '切换页面会保留草稿，保存后才会生效。'
              : section === 'rules'
                ? '规则按优先级自动应用于使用记录。'
                : '你的偏好已在本机保存。'}
          </span>
        </div>
        <div className="settings-save-actions">
          <button
            className="button button-quiet"
            type="button"
            disabled={!dirty || busy}
            onClick={discard}
          >
            放弃更改
          </button>
          <button
            className="button button-primary"
            type="button"
            disabled={!dirty || busy || (section === 'rules' && invalid)}
            onClick={() => void save()}
          >
            {pending === 'save'
              ? '正在保存…'
              : section === 'rules'
                ? '保存分类规则'
                : '保存设置'}
          </button>
        </div>
      </div>
      {section === 'rules' && ruleErrors.length > 0 && (
        <p
          className="settings-field-error settings-save-validation"
          role="status"
        >
          还有 {ruleErrors.length} 条规则未填写匹配条件，请完善或删除后保存。
        </p>
      )}
      {notices[section] && (
        <div
          className={`settings-notice settings-notice-${notices[section]?.tone}`}
          role={notices[section]?.tone === 'error' ? 'alert' : 'status'}
        >
          {notices[section]?.text}
        </div>
      )}
    </div>
  )
}
