/**
 * DSH 账号中心 —— 浏览器半身。
 *
 * 把两个插件的账号登录收进同一个设置页（Settings 侧边栏一节），界面按 DSH
 * WorkBuddy 的设置卡风格实现：同款卡片边框/圆角、折叠箭头、分区、账号行、
 * 状态 chip、胶囊按钮，颜色全部取自 DSH 主题变量（`--dsw-alias-*`）。
 *
 * 四个分区：
 *   1. 渠道账号 —— 13 个渠道的账号 / 余额 / 签到状态（**折叠状态就显示**），可登录、
 *      领取、续期、停用、删除；可开「自动补签」。
 *   2. 按模型   —— **只看账号渠道**：模型来自 channel-pack 的 `model.list` RPC，
 *      展开可见它落在哪些渠道、渠道下有哪些账号与余额。
 *   3. 积分上限 —— 每账号渠道每天最多消耗多少**积分**；已用量 = 余额差分，
 *      由 Host 半身记到 `credit-usage.json`，channel-pack 的补丁在选号时执行。
 *   4. WorkBuddy —— 国内版 / 国际版。
 *
 * 数据与动作都**不复制**后端逻辑：
 *   - 13 个渠道：宿主 connection 的 RPC `/api/channel-pack`（方法名与它自己的
 *     界面一致：account.* / login.poll / credits.status / credits.balances /
 *     credits.claimAll / usage.autoCheckin / model.list）。
 *   - 积分上限与余额采样：本插件自己的 `/plugins/dsh-auth-hub/{policy,credit-sample}`。
 *   - WorkBuddy：登录/账号/签到走内置 channel-pack 的 RPC；成长中心（猫猫旅行 +
 *     每日任务 + 连登）走本插件的 `GET/POST /plugins/dsh-auth-hub/growth`。
 *
 * ⚠️ **不再用 `/api/our-free-model/combos` 的模型目录**：那份目录由上游
 * `src/catalog.js` 构建，只含 free / kilo / eac 三条免费车道，账号渠道不在里面。
 *
 * 手写 ModuleLoader 包：无构建步骤，除 shell 自带的 `react` 外无依赖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-auth-hub',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback } = React

    //#region 平台注册表
    /** dsh-our-free-model 的 13 个账号渠道（`provider` 原样透传给 channel-pack）。 */
    const CHANNEL_PLATFORMS = [
      { provider: 'workbuddy', label: 'WorkBuddy 渠道', hint: '浏览器授权登录' },
      { provider: 'buddy', label: 'CodeBuddy', hint: '浏览器授权登录' },
      { provider: 'codearts', label: '华为 CodeArts', hint: '浏览器授权登录（AK/SK）' },
      { provider: 'qoder', label: 'Qoder 国际版', hint: '浏览器授权登录' },
      { provider: 'qodercn', label: 'Qoder 国内版', hint: '浏览器授权登录 · 每日 10:00 刷新' },
      { provider: 'trae', label: 'TRAE', hint: '浏览器授权登录' },
      { provider: 'cline', label: 'Cline', hint: '设备码轮询' },
      { provider: 'lobsterai', label: '有道 LobsterAI', hint: '扫码 / 短信' },
      { provider: 'loomy', label: '讯飞 Loomy', hint: '扫码 / 短信' },
      { provider: 'raccoon', label: '商汤 Raccoon', hint: '浏览器授权登录' },
      { provider: 'minimax', label: 'MiniMax', hint: '浏览器授权登录' },
      { provider: 'zcode', label: 'ZCode / Z.ai', hint: '需要过验证码' },
      { provider: 'gemini', label: 'Gemini', hint: '浏览器授权登录' },
    ]

    /**
     * WorkBuddy 两态：国际版走 www.workbuddy.ai，国内版与 CodeBuddy 共用
     * copilot.tencent.com（所以「国内版」在渠道上就是 CodeBuddy 那一条）。
     * 两者都由内置 pack 提供登录与签到；成长中心由本插件补上。
     */
    const WORKBUDDY_CHANNELS = [
      { provider: 'workbuddy', label: 'WorkBuddy 国际版', hint: 'www.workbuddy.ai · 支持成长中心' },
      { provider: 'buddy', label: 'WorkBuddy 国内版 / CodeBuddy', hint: 'copilot.tencent.com → codebuddy.cn' },
    ]

    const GROWTH_PATH = '/plugins/dsh-auth-hub/growth'
    const HUB_STATUS_PATH = '/plugins/dsh-auth-hub/status'
    const HUB_POLICY_PATH = '/plugins/dsh-auth-hub/policy'
    const HUB_SAMPLE_PATH = '/plugins/dsh-auth-hub/credit-sample'
    const HUB_ROTATIONS_PATH = '/plugins/dsh-auth-hub/rotations'
    const HUB_CONTROL_KEY_HEADER = 'x-auth-hub-control-key'
    const COMBOS_PATH = '/api/our-free-model/combos'
    /** 渠道账号登录链接的存活窗口（与 channel-pack 一致）。 */
    const LOGIN_TIMEOUT_MS = 10 * 60_000
    const CHANNEL_POLL_MS = 3000
    /** 折叠卡片的数据刷新周期；余额会因为别处用掉模型而变，所以要有心跳。 */
    const DATA_HEARTBEAT_MS = 90_000
    /** 拉 13 个平台数据的并发上限：全并发会同时打出几十个上游请求。 */
    const LOAD_CONCURRENCY = 3
    const AUTO_CLAIM_STORAGE_KEY = 'dsh-auth-hub:auto-claim'
    //#endregion

    //#region 样式（对齐 DSH WorkBuddy 设置卡）
    const cardStyle = {
      overflow: 'hidden',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-module-platform)',
    }
    const headerStyle = {
      boxSizing: 'border-box',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      border: 0,
      padding: '13px 14px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
    }
    const headTextStyle = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 3 }
    const nameStyle = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
    const descriptionStyle = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
    const chevronStyle = { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform 160ms ease' }
    const cardBodyStyle = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px' }
    const bodyStyle = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
    const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
    const statusStyle = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
    const buttonStyle = {
      boxSizing: 'border-box',
      minHeight: 34,
      padding: '6px 14px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 18,
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 14,
      cursor: 'pointer',
    }
    const smallButtonStyle = { ...buttonStyle, minHeight: 26, padding: '2px 10px', fontSize: 12, borderRadius: 13 }
    const disabledButtonStyle = { ...buttonStyle, opacity: 0.45, cursor: 'not-allowed' }
    const smallDisabledButtonStyle = { ...smallButtonStyle, opacity: 0.45, cursor: 'not-allowed' }
    const tabBarStyle = { display: 'flex', gap: 4, marginTop: 4, borderBottom: '1px solid var(--dsw-alias-border-l2)', flexWrap: 'wrap' }
    const tabStyle = {
      padding: '6px 12px',
      border: 0,
      borderBottom: '2px solid transparent',
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
    }
    const tabActiveStyle = { borderBottom: '2px solid var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-primary)' }
    const sectionStyle = { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 16 }
    const sectionTitleStyle = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
    const accountItemStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: 10,
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    const accountItemSelectedStyle = {
      borderColor: 'var(--dsw-alias-brand-primary)',
      boxShadow: 'inset 0 0 0 1px var(--dsw-alias-brand-primary)',
    }
    const accountMetaStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
    const accountRowStyle = { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', width: '100%' }
    const accountTextStyle = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 auto' }
    const accountActionsStyle = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }
    const chipStyle = {
      padding: '1px 8px',
      borderRadius: 999,
      fontSize: 11,
      lineHeight: '18px',
      background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
      color: 'var(--dsw-alias-state-success-primary, #22a06b)',
    }
    const mutedChipStyle = {
      padding: '1px 8px',
      borderRadius: 999,
      fontSize: 11,
      lineHeight: '18px',
      background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))',
      color: 'var(--dsw-alias-label-tertiary)',
    }
    const warnChipStyle = {
      ...mutedChipStyle,
      background: 'var(--dsw-alias-state-warn-subtle, rgba(209, 145, 0, 0.14))',
      color: 'var(--dsw-alias-state-warn-primary, #d19100)',
    }
    const errorStyle = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
    const subCardStyle = {
      display: 'flex',
      flexDirection: 'column',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-1)',
      overflow: 'hidden',
    }
    const subHeaderStyle = {
      boxSizing: 'border-box',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      border: 0,
      padding: '10px 12px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
    }
    const subBodyStyle = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '12px', display: 'flex', flexDirection: 'column', gap: 10 }
    const toolbarStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 10 }
    const spacerStyle = { flex: '1 1 auto' }
    const linkStyle = {
      color: 'var(--dsw-alias-brand-primary)',
      fontSize: 13,
      lineHeight: '20px',
      background: 'transparent',
      border: 0,
      padding: 0,
      font: 'inherit',
      cursor: 'pointer',
      textDecoration: 'underline',
    }
    const progressTrackStyle = { height: 6, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }
    const progressBarStyle = { height: '100%', borderRadius: 999, background: 'var(--dsw-alias-brand-primary)' }
    const inputStyle = {
      boxSizing: 'border-box',
      minHeight: 30,
      minWidth: 0,
      padding: '3px 8px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 6,
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
    }
    const selectStyle = { ...inputStyle, cursor: 'pointer' }
    const checkboxStyle = { accentColor: 'var(--dsw-alias-brand-primary, #4b8cff)', width: 16, height: 16, flex: 'none' }
    const listBoxStyle = {
      maxHeight: 260,
      overflowY: 'auto',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    const listRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 10px',
      borderBottom: '1px solid var(--dsw-alias-border-l2)',
      fontSize: 13,
      lineHeight: '18px',
    }
    //#endregion

    //#region 后端：channel-pack RPC + 同源 HTTP
    /**
     * 取宿主 connection 服务并包一层 RPC 调用。拿不到时返回 undefined，界面据此
     * 提示「需要 shell 提供 connection」，而不是抛进加载器把设置页打挂。
     */
    function makeChannelRpc(ctx) {
      let connection
      try { connection = ctx?.connection } catch { connection = undefined }
      if (connection === undefined && typeof ctx?.get === 'function') {
        try { connection = ctx.get('connection') } catch { connection = undefined }
      }
      const rpc = connection?.rpc
      if (rpc === undefined || typeof rpc.call !== 'function') return undefined
      return (method, payload, timeoutMs = 60_000) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        return Promise.resolve(rpc.call('/api', 'channel-pack', { method, payload }, controller.signal))
          .then(result => {
            if (result?.ok === true) return result.value
            if (result?.ok === false) throw new Error(result.error?.message ?? result.error?.code ?? 'rpc-failed')
            return result
          })
          .finally(() => clearTimeout(timer))
      }
    }

    async function readJsonResponse(response, label) {
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`${label} HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 160)}`}`)
      }
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined || typeof payload !== 'object') throw new Error(`${label} 响应无法解析`)
      return payload
    }

    /** 成长中心状态（内置实现，不再经 dsh-workbuddy）。 */
    async function readGrowth(provider) {
      return readJsonResponse(await fetch(`${GROWTH_PATH}?provider=${encodeURIComponent(provider)}`, { headers: { accept: 'application/json' } }), '成长中心')
    }

    /** 跑一轮成长清扫（接任务 → 领任务 → 派发旅行 → 领奖励）。 */
    async function postGrowthSweep(controlKey, provider) {
      return readJsonResponse(await fetch(GROWTH_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [HUB_CONTROL_KEY_HEADER]: controlKey },
        body: JSON.stringify({ provider }),
      }), '成长清扫')
    }

    /** 组合与模型目录（our-free-model 的同源 HTTP 接口）。
     *
     *  ⚠️ **本页不用它**：那份目录由上游 `src/catalog.js` 构建，只含 free / kilo / eac
     *  三条免费车道，账号渠道不在里面。账号渠道的模型目录走 channel-pack 的
     *  `model.list` RPC（见 `AccountModelTab`）。保留这两个函数只为「组合」这个
     *  上游功能本身仍可被别处复用，不代表本页依赖它。
     */
    async function readCombos() {
      return readJsonResponse(await fetch(COMBOS_PATH, { headers: { accept: 'application/json' } }), '组合列表')
    }

    async function postCombos(combos) {
      return readJsonResponse(await fetch(COMBOS_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ combos }),
      }), '保存组合')
    }

    /** 本插件自己的策略接口（**积分**上限）。 */
    async function readPolicy() {
      return readJsonResponse(await fetch(HUB_POLICY_PATH, { headers: { accept: 'application/json' } }), '积分策略')
    }

    async function postPolicy(controlKey, policy) {
      return readJsonResponse(await fetch(HUB_POLICY_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [HUB_CONTROL_KEY_HEADER]: controlKey },
        body: JSON.stringify(policy),
      }), '保存积分上限')
    }

    /**
     * 把一次余额快照回报给 Host 半身：它用「余额减少量」记成今日已用积分。
     * 这是**积分**口径的唯一数据来源（账号渠道按积分扣费，上游账本只记 token）。
     */
    async function postCreditSample(controlKey, provider, rows) {
      return readJsonResponse(await fetch(HUB_SAMPLE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [HUB_CONTROL_KEY_HEADER]: controlKey },
        body: JSON.stringify({ provider, rows }),
      }), '记录余额快照')
    }

    async function readHubStatus() {
      return readJsonResponse(await fetch(HUB_STATUS_PATH, { headers: { accept: 'application/json' } }), '插件状态')
    }

    /** 轮换组（一个模型名 → 多个账号渠道候选）。 */
    async function readRotations() {
      return readJsonResponse(await fetch(HUB_ROTATIONS_PATH, { headers: { accept: 'application/json' } }), '轮换组')
    }

    async function postRotations(controlKey, rotations) {
      return readJsonResponse(await fetch(HUB_ROTATIONS_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [HUB_CONTROL_KEY_HEADER]: controlKey },
        body: JSON.stringify({ rotations }),
      }), '保存轮换组')
    }
    //#endregion

    //#region 小工具
    function openExternal(url) {
      if (typeof url !== 'string' || url === '') return false
      try { window.open(url, '_blank', 'noopener'); return true } catch { return false }
    }

    function formatTime(value) {
      if (value === undefined || value === null || value === '') return ''
      const ms = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(ms) || ms <= 0) return String(value)
      try { return new Date(ms).toLocaleString() } catch { return String(ms) }
    }

    function errorText(error) {
      return error instanceof Error ? error.message : String(error ?? '未知错误')
    }

    function remainingText(startedAt) {
      const left = Math.max(0, LOGIN_TIMEOUT_MS - (Date.now() - startedAt))
      const pad = part => String(part).padStart(2, '0')
      return `${pad(Math.floor(left / 60_000))}:${pad(Math.floor((left % 60_000) / 1000))}`
    }

    function round2(value) {
      return Math.round(value * 100) / 100
    }

    /**
     * 把 `credits.balances` 的一个 `balance` 压成一行可读文本。
     *
     * 形状：`{ total, packages: [{ name, unit, remaining, ... }], expiredTotal }`。
     * 量纲各渠道不同（credits / token / USD），单位跟包打印，不硬编成「积分」。
     */
    function balanceText(balance) {
      if (balance === null || balance === undefined) return ''
      const total = Number.isFinite(balance.total) ? balance.total : undefined
      const packages = Array.isArray(balance.packages) ? balance.packages : []
      const detail = packages
        .filter(pkg => Number.isFinite(pkg?.remaining))
        .map(pkg => `${pkg.name ?? '额度'} ${pkg.remaining}${typeof pkg.unit === 'string' && pkg.unit !== '' && pkg.unit !== 'credits' ? ` ${pkg.unit}` : ''}`)
        .join(' · ')
      if (total !== undefined && detail !== '') return `${total}（${detail}）`
      if (total !== undefined) return String(total)
      return detail
    }

    /** 把一批 `credits.balances` 行折成一条汇总文本。 */
    function balancesSummary(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return { total: undefined, failed: 0, text: '' }
      let total = 0
      let known = false
      let failed = 0
      for (const row of rows) {
        if (Number.isFinite(row?.balance?.total)) { total += row.balance.total; known = true }
        else failed += 1
      }
      return { total: known ? round2(total) : undefined, failed, text: known ? String(round2(total)) : '' }
    }

    function ChevronDownOutline14(props) {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 14 14',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        style: { ...chevronStyle, transform: props.open ? 'rotate(180deg)' : 'none' },
      }, h('path', {
        d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
        fill: 'currentColor',
      }))
    }

    function ActionButton(props) {
      const { disabled, title, onClick, children, small } = props
      return h('button', {
        type: 'button',
        style: disabled ? (small ? smallDisabledButtonStyle : disabledButtonStyle) : (small ? smallButtonStyle : buttonStyle),
        disabled: disabled === true,
        title,
        onClick: disabled === true ? undefined : onClick,
      }, children)
    }

    function MetaLine(props) {
      return h('span', { style: accountMetaStyle }, props.children)
    }

    function Chip(props) {
      const style = props.tone === 'warn' ? warnChipStyle : (props.tone === 'muted' ? mutedChipStyle : chipStyle)
      return h('span', { style }, props.children)
    }
    //#endregion

    //#region 渠道账号：单个平台卡（数据由父级预加载，折叠即可见）
    /**
     * 一个渠道平台的卡片。
     *
     * 账号 / 签到状态 / 余额都由父级统一拉好（`entry`），所以**折叠状态**的标题行
     * 就能显示「N 个账号 · 余额 X · 今日已签」；展开只是看细节与做动作。
     * 登录仍是两阶段：`account.create` 立刻返回要打开的 URL（延迟打开会被浏览器
     * 拦截），随后每 3 秒 `login.poll`，凭据落盘即完成。
     */
    function ChannelPlatformCard(props) {
      const { platform, rpc, entry, onRefresh, onClaim, onError } = props
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [login, setLogin] = useState(null)
      const [tick, setTick] = useState(0)

      const accounts = entry?.accounts
      const status = entry?.status
      const balances = entry?.balances

      // 登录轮询：成功 → 让父级刷新该平台；失败/超时 → 报错收尾。
      useEffect(() => {
        if (login === null) return undefined
        let alive = true
        const timer = setInterval(async () => {
          if (Date.now() - login.startedAt > LOGIN_TIMEOUT_MS) {
            if (alive) { setLogin(null); setNotice('登录链接已过期，请重新发起登录') }
            return
          }
          setTick(value => value + 1)
          try {
            const value = await rpc('login.poll', { accountId: login.accountId, provider: platform.provider })
            if (!alive) return
            if (value?.done === true) {
              setLogin(null)
              if (value.success === false) setNotice(`登录失败：${value.error ?? '未知原因'}`)
              else {
                setNotice(value.login ? `已登录：${value.login}` : '登录完成')
                onRefresh(true)
              }
            } else if (typeof value?.error === 'string' && value.error !== '') {
              setLogin(null)
              setNotice(`登录失败：${value.error}`)
            }
          } catch { /* 链接可能仍在完成中，继续轮询 */ }
        }, CHANNEL_POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [login, rpc, platform.provider, onRefresh])

      const startLogin = async () => {
        setBusy('login'); setNotice('')
        try {
          const value = await rpc('account.create', { provider: platform.provider }, 90_000)
          const accountId = value?.accountId
          const url = value?.loginUrl
          if (typeof accountId !== 'string' || accountId === '') throw new Error('渠道未返回账号占位 id')
          if (typeof url === 'string' && url !== '') openExternal(url)
          setLogin({ accountId, url: typeof url === 'string' ? url : '', startedAt: Date.now() })
          setOpen(true)
          onRefresh(true)
        } catch (error) { onError(platform, error) } finally { setBusy('') }
      }

      const claim = async () => {
        setBusy('claim'); setNotice('')
        try {
          const text = await onClaim(platform.provider)
          setNotice(text)
        } catch (error) { onError(platform, error) } finally { setBusy('') }
      }

      const refreshAccount = async accountId => {
        setBusy(`refresh:${accountId}`); setNotice('')
        try {
          await rpc('account.refresh', { accountId }, 90_000)
          setNotice('凭据已续期')
          onRefresh(true)
        } catch (error) { onError(platform, error) } finally { setBusy('') }
      }

      const removeAccount = async accountId => {
        setBusy(`delete:${accountId}`); setNotice('')
        try {
          await rpc('account.delete', { accountId })
          setNotice('账号已删除')
          onRefresh(true)
        } catch (error) { onError(platform, error) } finally { setBusy('') }
      }

      const toggleAccount = async (accountId, enabled) => {
        setBusy(`toggle:${accountId}`); setNotice('')
        try {
          await rpc('account.update', { accountId, patch: { enabled } })
          onRefresh(true)
        } catch (error) { onError(platform, error) } finally { setBusy('') }
      }

      const summary = balancesSummary(balances)
      const chips = []
      if (entry?.loading === true && accounts === undefined) chips.push({ text: '读取中…', tone: 'muted' })
      if (Array.isArray(accounts)) chips.push({ text: `${accounts.length} 个账号`, tone: 'muted' })
      if (summary.total !== undefined) chips.push({ text: `余额 ${summary.text}`, tone: 'ok' })
      if (summary.failed > 0) chips.push({ text: `${summary.failed} 个余额查询失败`, tone: 'warn' })
      if (status?.active === true) chips.push({ text: status.todayCheckedIn === true ? '今日已签' : '今日可签', tone: status.todayCheckedIn === true ? 'ok' : 'warn' })
      else if (status?.active === false) chips.push({ text: '活动未开启', tone: 'muted' })
      if (entry?.error !== undefined) chips.push({ text: '出错', tone: 'warn' })

      const balanceRowOf = accountId => (Array.isArray(balances) ? balances.find(row => row?.accountId === accountId) : undefined)

      return h('div', { style: subCardStyle }, [
        h('button', {
          key: 'head',
          type: 'button',
          style: subHeaderStyle,
          onClick: () => setOpen(value => !value),
        }, [
          h('span', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
            h('span', { key: 'name', style: nameStyle }, platform.label),
            h('span', { key: 'hint', style: descriptionStyle }, platform.hint),
          ]),
          h('span', { key: 'chips', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            chips.map((chip, index) => h(Chip, { key: index, tone: chip.tone }, chip.text))),
          h(ChevronDownOutline14, { key: 'chev', open }),
        ]),
        open ? h('div', { style: subBodyStyle }, [
          login !== null ? h('div', { key: 'login', style: accountItemStyle }, [
            h('div', { style: rowStyle }, [
              h('span', { style: statusStyle }, '等待浏览器完成登录…'),
              h('span', { style: accountMetaStyle }, `剩余 ${remainingText(login.startedAt)}`),
            ]),
            h('div', { style: progressTrackStyle }, h('div', {
              style: { ...progressBarStyle, width: `${Math.min(100, ((Date.now() - login.startedAt) / LOGIN_TIMEOUT_MS) * 100)}%` },
            })),
            h('div', { style: accountActionsStyle }, [
              login.url !== '' ? h('button', { key: 'reopen', type: 'button', style: linkStyle, onClick: () => openExternal(login.url) }, '重新打开登录页') : null,
              h(ActionButton, { key: 'cancel', small: true, onClick: () => setLogin(null) }, '取消'),
            ]),
          ]) : null,
          h('div', { key: 'toolbar', style: toolbarStyle }, [
            h(ActionButton, { key: 'add', disabled: busy === 'login', onClick: startLogin }, busy === 'login' ? '正在发起…' : '+ 登录账号'),
            h(ActionButton, { key: 'claim', small: true, disabled: busy === 'claim', onClick: claim }, busy === 'claim' ? '领取中…' : '领取今日积分'),
            h(ActionButton, { key: 'balance', small: true, disabled: entry?.loading === true, onClick: () => onRefresh(true) }, entry?.loading === true ? '查询中…' : '刷新余额'),
            h('span', { key: 'spacer', style: spacerStyle }),
            entry?.updatedAt ? h('span', { key: 'at', style: accountMetaStyle }, formatTime(entry.updatedAt)) : null,
          ]),
          entry?.error !== undefined ? h('div', { key: 'err', style: errorStyle }, entry.error) : null,
          entry?.balanceError !== undefined ? h('div', { key: 'balerr', style: errorStyle }, `余额查询失败：${entry.balanceError}`) : null,
          notice !== '' ? h('div', { key: 'notice', style: bodyStyle }, notice) : null,
          accounts === undefined
            ? h('div', { key: 'loading', style: accountMetaStyle }, '读取账号…')
            : accounts.length === 0
              ? h('div', { key: 'empty', style: accountMetaStyle }, '还没有账号，点「+ 登录账号」开始登录。')
              : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, accounts.map(account => {
                const balanceRow = balanceRowOf(account.id)
                const balanceItemText = balanceRow === undefined
                  ? ''
                  : balanceRow.error !== undefined
                    ? `余额：${balanceRow.error}`
                    : balanceText(balanceRow.balance)
                return h('div', { key: account.id, style: accountItemStyle }, [
                  h('div', { key: 'row', style: accountRowStyle }, [
                    h('span', { key: 'text', style: accountTextStyle }, [
                      h('span', { style: { fontSize: 14, color: 'var(--dsw-alias-label-primary)' } }, account.nickname || account.id),
                      h(MetaLine, { key: 'meta' }, [
                        account.enabled === false ? '已停用' : '已启用',
                        account.expiresAt ? ` · 到期 ${formatTime(account.expiresAt)}` : '',
                        account.refreshable === true ? ' · 可续期' : '',
                        balanceItemText === '' ? '' : ` · ${balanceItemText}`,
                      ].join('')),
                    ]),
                    h('div', { key: 'actions', style: accountActionsStyle }, [
                      h(ActionButton, {
                        key: 'toggle',
                        small: true,
                        disabled: busy === `toggle:${account.id}`,
                        onClick: () => toggleAccount(account.id, account.enabled === false),
                      }, account.enabled === false ? '启用' : '停用'),
                      h(ActionButton, {
                        key: 'refresh',
                        small: true,
                        disabled: busy === `refresh:${account.id}` || account.refreshable !== true,
                        onClick: () => refreshAccount(account.id),
                      }, busy === `refresh:${account.id}` ? '续期中…' : '续期'),
                      h(ActionButton, {
                        key: 'delete',
                        small: true,
                        disabled: busy === `delete:${account.id}`,
                        onClick: () => removeAccount(account.id),
                      }, '删除'),
                    ]),
                  ]),
                ])
              })),
        ]) : null,
      ])
    }
    //#endregion

    //#region 按模型：账号渠道的模型 → 渠道 → 账号与余额
    /**
     * 「这个模型我有哪些账号、各剩多少余额」——**只看账号渠道**。
     *
     * 模型目录来自 channel-pack 的 `model.list` RPC（逐 provider 一次），这是账号
     * 渠道的权威目录。**不用** `/api/our-free-model/combos`：那份目录由上游
     * `src/catalog.js` 构建，只含 free / kilo / eac 三条免费车道，账号渠道根本不在
     * 里面（实测 26 个模型全是 free/kilo）——用它就会得出「账号渠道没有模型」的错结论。
     */
    function AccountModelTab(props) {
      const { rpc, platforms, providers, onError } = props
      const [modelsByProvider, setModelsByProvider] = useState({})
      const [loading, setLoading] = useState(true)
      const [query, setQuery] = useState('')
      const [expanded, setExpanded] = useState('')
      const [rotations, setRotations] = useState(undefined)
      const [router, setRouter] = useState(null)
      const [rotationDraft, setRotationDraft] = useState({ id: '', name: '', members: [], strategy: 'round-robin', stickyLimit: 4 })
      const [controlKey, setControlKey] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')

      const loadRotations = useCallback(async () => {
        try {
          const [hub, payload] = await Promise.all([readHubStatus(), readRotations()])
          setControlKey(typeof hub.controlKey === 'string' ? hub.controlKey : '')
          setRouter(hub?.router ?? null)
          setRotations(payload)
        } catch (error) { onError(error) }
      }, [onError])

      const loadAll = useCallback(async () => {
        setLoading(true)
        const out = {}
        let cursor = 0
        const list = platforms.map(platform => platform.provider)
        const workers = Array.from({ length: LOAD_CONCURRENCY }, async () => {
          while (cursor < list.length) {
            const provider = list[cursor]
            cursor += 1
            try {
              const value = await rpc('model.list', { provider })
              out[provider] = Array.isArray(value?.models) ? value.models : []
            } catch {
              out[provider] = []
            }
          }
        })
        await Promise.all(workers)
        setModelsByProvider(out)
        setLoading(false)
      }, [rpc, platforms])

      useEffect(() => { void loadAll() }, [loadAll])
      useEffect(() => { void loadRotations() }, [loadRotations])

      /** 保存轮换组：把当前草稿合并进去（按 id 覆盖或追加）。 */
      const saveRotation = async next => {
        setBusy('rot'); setNotice('')
        try {
          if (controlKey === '') throw new Error('拿不到 controlKey（Host 半身未加载）')
          const payload = await postRotations(controlKey, next)
          setRotations(payload)
          const routable = (payload?.groups ?? []).filter(group => group.routable !== false).length
          setNotice(`已保存 ${payload?.groups?.length ?? next.length} 个轮换组，其中 ${routable} 个已出现在 /model 的「${payload?.providerName ?? '账号中心轮换'}」分组下`)
        } catch (error) { onError(error) } finally { setBusy('') }
      }

      const addDraftMember = memberId => {
        setRotationDraft(current => current.members.includes(memberId)
          ? current
          : { ...current, members: [...current.members, memberId] })
      }

      /** 编辑已有组：把它的成员与策略装回草稿，保存时按 id 覆盖。 */
      const editRotation = group => {
        setRotationDraft({
          id: group.id,
          name: group.name ?? group.id,
          members: Array.isArray(group.members) ? [...group.members] : [],
          strategy: group.strategy ?? 'round-robin',
          stickyLimit: Number(group.stickyLimit) > 0 ? Number(group.stickyLimit) : 4,
        })
        setNotice(`正在编辑「${group.name ?? group.id}」：改完点「保存轮换组」覆盖它`)
      }

      const moveDraftMember = (memberId, delta) => {
        setRotationDraft(current => {
          const index = current.members.indexOf(memberId)
          if (index < 0) return current
          const target = index + delta
          if (target < 0 || target >= current.members.length) return current
          const members = [...current.members]
          members[index] = members[target]
          members[target] = memberId
          return { ...current, members }
        })
      }

      const dropDraftMember = memberId => {
        setRotationDraft(current => ({ ...current, members: current.members.filter(id => id !== memberId) }))
      }

      const commitDraft = async () => {
        if (rotationDraft.name.trim() === '' || rotationDraft.members.length === 0) {
          setNotice('轮换组需要名字和至少一个成员')
          return
        }
        const existing = Array.isArray(rotations?.groups) ? rotations.groups : []
        const next = [...existing.filter(group => group.id !== rotationDraft.id), {
          id: rotationDraft.id !== '' ? rotationDraft.id : rotationDraft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48),
          name: rotationDraft.name.trim(),
          members: rotationDraft.members,
          strategy: rotationDraft.strategy,
          stickyLimit: Number(rotationDraft.stickyLimit) > 0 ? Number(rotationDraft.stickyLimit) : 4,
          enabled: true,
        }]
        await saveRotation(next)
        setRotationDraft({ id: '', name: '', members: [], strategy: 'round-robin', stickyLimit: 4 })
      }

      const removeRotation = async group => {
        const existing = Array.isArray(rotations?.groups) ? rotations.groups : []
        await saveRotation(existing.filter(row => row.id !== group.id))
      }

      const toggleRotation = async group => {
        const existing = Array.isArray(rotations?.groups) ? rotations.groups : []
        await saveRotation(existing.map(row => row.id === group.id ? { ...row, enabled: row.enabled === false } : row))
      }

      const rows = useMemo(() => {
        const byModel = new Map()
        const needle = String(query ?? '').trim().toLowerCase()
        // 防御：`modelsByProvider` 一定是对象，但从错位的 state 里读到 undefined
        // 会让 Object.entries 抛错、整个分区白屏。宁可不显示也不要白屏。
        for (const [provider, models] of Object.entries(modelsByProvider ?? {})) {
          for (const model of Array.isArray(models) ? models : []) {
            const id = String(model?.id ?? '')
            if (id === '') continue
            if (needle !== '' && !id.toLowerCase().includes(needle) && !String(model.name ?? '').toLowerCase().includes(needle)) continue
            const row = byModel.get(id) ?? { id, name: model.name ?? id, lanes: [] }
            const accounts = Array.isArray(providers?.[provider]?.accounts) ? providers[provider].accounts : []
            const balanceOf = Array.isArray(providers?.[provider]?.balances) ? providers[provider].balances : []
            const summary = balancesSummary(balanceOf)
            row.lanes.push({ provider, accounts, balanceText: summary.text, failed: summary.failed })
            byModel.set(id, row)
          }
        }
        return [...byModel.values()].sort((a, b) => (b.lanes.length - a.lanes.length) || a.id.localeCompare(b.id))
      }, [modelsByProvider, providers, query])

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h('div', { key: 'bar', style: toolbarStyle }, [
          h('input', {
            key: 'q',
            style: { ...inputStyle, flex: '1 1 240px' },
            placeholder: '按模型名过滤（例如 deepseek-v4.1-flash / glm）',
            value: query,
            onChange: event => setQuery(event.target.value),
          }),
          h('span', { key: 'count', style: accountMetaStyle }, loading ? '读取账号渠道模型…' : `${rows.length} 个模型`),
          h('span', { key: 'spacer', style: spacerStyle }),
          h(ActionButton, { key: 'reload', small: true, onClick: () => { void loadAll() } }, '重读'),
        ]),
        h('div', { key: 'hint', style: accountMetaStyle },
          '只列账号渠道（CodeArts / Qoder / TRAE / MiniMax / CodeBuddy 等）的模型，不含免费车道。展开可见该模型落在哪些渠道、渠道下有哪些账号。'),
        rows.length === 0
          ? h('div', { key: 'empty', style: accountMetaStyle },
            loading ? '读取中…' : (query === '' ? '账号渠道没有已登录账号时，模型目录会是空的。' : '没有匹配的模型。'))
          : h('div', { key: 'list', style: listBoxStyle }, rows.flatMap(row => {
            const isOpen = expanded === row.id
            const head = h('button', {
              key: row.id,
              type: 'button',
              style: { ...listRowStyle, width: '100%', border: 0, background: 'transparent', cursor: 'pointer', justifyContent: 'space-between' },
              onClick: () => setExpanded(isOpen ? '' : row.id),
            }, [
              h('span', { key: 'name', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, textAlign: 'left' } }, [
                h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, row.name),
                h('span', { key: 'id', style: accountMetaStyle }, row.id),
              ]),
              h('span', { key: 'lanes', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
                ...row.lanes.map((lane, index) => h(Chip, {
                  key: `c${index}`,
                  tone: lane.accounts.length === 0 ? 'muted' : 'ok',
                }, `${lane.provider}·${lane.accounts.length}账号${lane.balanceText === '' ? '' : `·${lane.balanceText}`}`)),
                h('span', { key: 'chev', style: accountMetaStyle }, isOpen ? '▾' : '▸'),
              ]),
            ])
            if (!isOpen) return [head]
            const detail = h('div', {
              key: `${row.id}:detail`,
              style: { padding: '8px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
            }, row.lanes.map((lane, index) => h('div', { key: `lane${index}`, style: accountItemStyle }, [
              h('div', { key: 'top', style: rowStyle }, [
                h('span', { key: 'p', style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, lane.provider),
                h('span', { key: 'n', style: accountMetaStyle },
                  `${lane.accounts.length} 个账号${lane.balanceText === '' ? '' : ` · 合计余额 ${lane.balanceText}`}${lane.failed > 0 ? ` · ${lane.failed} 个查询失败` : ''}`),
              ]),
              lane.accounts.length === 0
                ? h('div', { key: 'none', style: accountMetaStyle }, '该渠道没有已登录账号')
                : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, lane.accounts.map(account =>
                  h('div', {
                    key: account.id,
                    style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
                  }, [
                    h('span', { key: 'n' }, account.nickname || account.id),
                    h('span', { key: 'b' }, account.enabled === false ? '已停用' : (account.expiresAt ? `到期 ${formatTime(account.expiresAt)}` : '')),
                  ]))),
              h('div', { key: 'actions', style: accountActionsStyle },
                h(ActionButton, {
                  key: 'add',
                  small: true,
                  onClick: () => addDraftMember(`${lane.provider}::${row.id}`),
                }, '加入轮换草稿')),
            ])))
            return [head, detail]
          })),
        // ── 轮换组：账号渠道的「一个模型名 → 多个候选轮流用」 ────────────────
        h('div', { key: 'rot', style: sectionStyle }, [
          h('h3', { key: 't', style: sectionTitleStyle }, '轮换使用（账号渠道）'),
          h('div', { key: 'hint', style: accountMetaStyle },
            `一个组 = 一个模型名 → 多个「渠道::模型」候选。round-robin 每次从下一个开始、连续用 stickyLimit 次再换；fallback 永远从第一个开始；least-used 今天用得最少的优先。达到积分上限的候选会被跳过。`),
          // 路由是否挂上，直接决定「能不能在 /model 里看到」——失败时必须显式说出来，
          // 否则用户只会看到「保存成功」但选择器里永远没有那一项。
          router !== null && router.state !== 'ready'
            ? h('div', { key: 'routerr', style: errorStyle },
              `轮换路由未就绪（${router.state}）：${router.error === '' ? 'Host 半身尚未注册 provider' : router.error}。重启 DSH 后仍失败请看日志。`)
            : null,
          router !== null && router.state === 'ready'
            ? h('div', { key: 'routerok', style: accountMetaStyle }, `轮换路由已就绪：provider「${router.provider ?? 'auth-hub'}」`)
            : null,
          // 最关键的一句：**轮换组在哪儿被选中**。以前只写好而没接进目录，
          // 用户在 /model 里根本找不到自己建的组（这就是报障的根因）。
          h('div', { key: 'where', style: { ...bodyStyle, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)' } }, [
            h('span', { key: 'a' }, '启用后，每个组会作为『'),
            h('strong', { key: 'p' }, rotations?.providerName ?? '账号中心轮换'),
            h('span', { key: 'b' }, '』分组下的一个模型出现在输入框的模型选择器（`/model`）里，名字是「组名（N 个候选）」。在那里选中它，请求就会按上面的策略回退。'),
            h('span', { key: 'c', style: accountMetaStyle }, '保存后目录会立即刷新；若选择器里还看不到，点一次「重读」或重开选择器。'),
          ]),
          (rotations?.groups ?? []).length === 0
            ? h('div', { key: 'none', style: accountMetaStyle }, '还没有轮换组。展开上面任一模型，用「加入轮换草稿」把候选加进来。')
            : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, (rotations?.groups ?? []).map(group => h('div', {
              key: group.id,
              style: { ...accountItemStyle, ...(rotationDraft.id === group.id ? accountItemSelectedStyle : {}) },
            }, [
              h('div', { key: 'row', style: accountRowStyle }, [
                h('span', { key: 'text', style: accountTextStyle }, [
                  h('span', { style: { fontSize: 14, color: 'var(--dsw-alias-label-primary)' } },
                    `${group.name}（${group.strategy === 'round-robin' ? `轮流 · 每 ${group.stickyLimit} 次` : group.strategy === 'fallback' ? '依次回退' : '用量最少优先'}）`),
                  h(MetaLine, { key: 'meta' }, (group.members_ ?? []).map(member =>
                    `${member.provider}${member.used > 0 ? `(${member.used}${member.cap !== null ? `/${member.cap}` : ''})` : ''}${member.exhausted ? '✕' : ''}`).join(' → ')),
                  h('span', { key: 'route', style: accountMetaStyle },
                    group.routable === false
                      ? '已停用 · 不会出现在模型选择器里'
                      : `模型选择器 ID：${rotations?.provider ?? 'auth-hub'} / ${group.id}${(group.order ?? []).length === 0 ? ' · 今天已无可用候选' : ''}`),
                ]),
                h('div', { key: 'actions', style: accountActionsStyle }, [
                  h(ActionButton, { key: 'edit', small: true, disabled: busy === 'rot', onClick: () => editRotation(group) }, '编辑'),
                  h(ActionButton, { key: 'toggle', small: true, disabled: busy === 'rot', onClick: () => toggleRotation(group) }, group.enabled === false ? '启用' : '停用'),
                  h(ActionButton, { key: 'del', small: true, disabled: busy === 'rot', onClick: () => removeRotation(group) }, '删除'),
                ]),
              ]),
            ]))),
          h('div', { key: 'new', style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 } }, [
            h('div', { key: 'title', style: sectionTitleStyle }, rotationDraft.id === '' ? '新建轮换组' : `编辑「${rotationDraft.name}」`),
            h('div', { key: 'r1', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
              h('input', {
                key: 'name',
                style: { ...inputStyle, flex: '1 1 180px' },
                placeholder: '组名（例如 DS V4.1 轮流）',
                value: rotationDraft.name,
                onChange: event => setRotationDraft(current => ({ ...current, name: event.target.value })),
              }),
              h('select', {
                key: 'strategy',
                style: selectStyle,
                value: rotationDraft.strategy,
                onChange: event => setRotationDraft(current => ({ ...current, strategy: event.target.value })),
              }, [
                h('option', { key: 'rr', value: 'round-robin' }, '轮流'),
                h('option', { key: 'fb', value: 'fallback' }, '依次回退'),
                h('option', { key: 'lu', value: 'least-used' }, '用量最少优先'),
              ]),
              h('input', {
                key: 'sticky',
                style: { ...inputStyle, width: 96 },
                type: 'number',
                min: 1,
                title: '连续使用同一个候选的次数',
                value: rotationDraft.stickyLimit,
                onChange: event => setRotationDraft(current => ({ ...current, stickyLimit: event.target.value })),
              }),
            ]),
            // 草稿成员要能**排序 / 删除**：fallback 与 round-robin 的顺序就是优先级，
            // 只能加不能改顺序等于没法调整策略。
            Array.isArray(rotationDraft?.members) && rotationDraft.members.length > 0
              ? h('div', { key: 'draft', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                rotationDraft.members.map((member, index) => h('div', {
                  key: member,
                  style: { ...listRowStyle, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, gap: 8 },
                }, [
                  h('span', { key: 'i', style: { ...accountMetaStyle, width: 18 } }, `${index + 1}`),
                  h('span', { key: 'm', style: { flex: '1 1 auto', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, member),
                  h(ActionButton, { key: 'up', small: true, disabled: index === 0, onClick: () => moveDraftMember(member, -1) }, '↑'),
                  h(ActionButton, { key: 'down', small: true, disabled: index === rotationDraft.members.length - 1, onClick: () => moveDraftMember(member, 1) }, '↓'),
                  h(ActionButton, { key: 'del', small: true, onClick: () => dropDraftMember(member) }, '移除'),
                ])))
              : h('div', { key: 'draft0', style: accountMetaStyle }, '草稿为空 —— 展开上面的模型行，点「加入轮换草稿」。'),
            h('div', { key: 'r2', style: toolbarStyle }, [
              h(ActionButton, {
                key: 'save',
                disabled: busy === 'rot' || rotationDraft.name.trim() === '' || rotationDraft.members.length === 0,
                onClick: commitDraft,
              }, busy === 'rot' ? '保存中…' : (rotationDraft.id === '' ? '保存轮换组' : '保存（覆盖）')),
              h(ActionButton, {
                key: 'clear',
                small: true,
                onClick: () => setRotationDraft({ id: '', name: '', members: [], strategy: 'round-robin', stickyLimit: 4 }),
              }, '清空草稿'),
            ]),
            notice !== '' ? h('div', { key: 'notice', style: bodyStyle }, notice) : null,
          ]),
        ]),
      ])
    }
    //#endregion

    //#region 积分上限：**每账号**每天最多消耗多少积分
    /**
     * 口径写清楚（界面上也要写）：
     *   1. 上限是**每账号**的（`usage-policy.json` 的 `accounts`），不是每渠道。
     *      一个渠道下多个账号各算各的；某个账号用满只是它自己不再被选中。
     *   2. 已用量靠「余额差分」推算（`POST /plugins/dsh-auth-hub/credit-sample`），
     *      **逐包**比较剩余量：签到/充值新建或加量的包、到期失效的包都贡献 0，
     *      所以签到带来的余额变化**不会**被算成消耗，也不会把已用量冲抵掉。
     *   3. 执行者是 channel-pack 的本地补丁 5（`getAvailableAccount` 逐候选剔除）。
     *
     * 仍然诚实的边界：只有查过余额的账号才有数据；两次查询之间的消耗会在下一次
     * 查询时一次性计入（按查询时刻归日）；渠道只返回总量且没记到领取量时会低估消耗。
     */
    function CreditCapTab(props) {
      const { platforms, providers, onError } = props
      const [view, setView] = useState(undefined)
      /** 账号级草稿：`{ [accountId]: 数字或空串 }`；渠道级用 `provider:<id>` 前缀。 */
      const [draft, setDraft] = useState({})
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [controlKey, setControlKey] = useState('')
      const [onlyCapped, setOnlyCapped] = useState(false)

      const load = useCallback(async () => {
        try {
          const [hub, payload] = await Promise.all([readHubStatus(), readPolicy()])
          setControlKey(typeof hub.controlKey === 'string' ? hub.controlKey : '')
          setView(payload)
          const next = {}
          for (const row of Array.isArray(payload.accounts) ? payload.accounts : []) next[row.accountId] = row.cap ?? ''
          for (const [id, row] of Object.entries(payload.providers ?? {})) next[`provider:${id}`] = row.cap ?? ''
          setDraft(next)
        } catch (error) { onError(error) }
      }, [onError])

      useEffect(() => { void load() }, [load])

      /** 把当前余额快照回报给 Host，让它把「余额减少量」记成今日已用积分。 */
      const sampleBalances = useCallback(async () => {
        if (controlKey === '') return
        let recorded = 0
        for (const platform of platforms) {
          const rows = providers?.[platform.provider]?.balances
          if (!Array.isArray(rows) || rows.length === 0) continue
          try {
            await postCreditSample(controlKey, platform.provider, rows)
            recorded += 1
          } catch { /* 单渠道失败不影响其它 */ }
        }
        setNotice(recorded === 0 ? '没有可回报的余额数据（先刷新余额）' : `已记录 ${recorded} 个渠道的余额快照（按账号记账）`)
        await load()
      }, [controlKey, platforms, providers, load])

      const save = async () => {
        setBusy('save'); setNotice('')
        try {
          if (controlKey === '') throw new Error('拿不到 controlKey（本插件 Host 半身可能未加载）')
          const accounts = {}
          const rows = {}
          for (const [key, value] of Object.entries(draft)) {
            const credits = Number(value)
            if (!Number.isFinite(credits) || credits <= 0) continue
            const rounded = Math.round(credits * 100) / 100
            if (key.startsWith('provider:')) rows[key.slice('provider:'.length)] = { maxCreditsPerDay: rounded }
            else accounts[key] = { maxCreditsPerDay: rounded }
          }
          const payload = await postPolicy(controlKey, { version: 3, accounts, providers: rows })
          setView(payload)
          setNotice(`已保存：${Object.keys(accounts).length} 个账号上限${Object.keys(rows).length > 0 ? `、${Object.keys(rows).length} 个整渠道上限` : ''}（channel-pack 5 秒内生效）`)
        } catch (error) { onError(error) } finally { setBusy('') }
      }

      // 按渠道分组渲染：账号是主体，整渠道上限放在组标题旁（大多数渠道一个账号，
      // 用渠道级更省事；多账号渠道才需要逐个设）。
      const rows = useMemo(() => {
        const byAccount = new Map()
        for (const row of Array.isArray(view?.accounts) ? view.accounts : []) byAccount.set(row.accountId, row)
        const groups = []
        for (const platform of platforms) {
          const accounts = Array.isArray(providers?.[platform.provider]?.accounts) ? providers[platform.provider].accounts : []
          const items = []
          for (const account of accounts) {
            const row = byAccount.get(account.id)
            items.push({
              accountId: account.id,
              provider: platform.provider,
              label: account.nickname || account.id,
              detail: account.enabled === false ? '已停用' : '已启用',
              cap: draft[account.id] ?? row?.cap ?? '',
              used: Number(row?.used) || 0,
              samples: Number(row?.samples) || 0,
              exhausted: row?.exhausted === true,
            })
          }
          // 台账里有、账号池里没有（被删了）的账号也要显示，否则数字对不上。
          for (const [accountId, row] of byAccount) {
            if (row.provider !== platform.provider) continue
            if (items.some(item => item.accountId === accountId)) continue
            items.push({
              accountId,
              provider: row.provider,
              label: accountId,
              detail: '账号已不在账号池',
              cap: draft[accountId] ?? row.cap ?? '',
              used: Number(row.used) || 0,
              samples: Number(row.samples) || 0,
              exhausted: false,
            })
          }
          if (items.length === 0) continue
          groups.push({
            provider: platform.provider,
            label: platform.label,
            cap: draft[`provider:${platform.provider}`] ?? view?.providers?.[platform.provider]?.cap ?? '',
            used: Number(view?.providers?.[platform.provider]?.used) || 0,
            items,
          })
        }
        return groups
      }, [platforms, providers, view, draft])

      const visible = onlyCapped
        ? rows.map(group => ({ ...group, items: group.items.filter(item => Number(item.cap) > 0 || item.used > 0) })).filter(group => group.items.length > 0)
        : rows

      const accountCapped = Object.entries(view?.policy?.accounts ?? {}).length
      const providerCapped = Object.entries(view?.policy?.providers ?? {}).length

      const renderAccountRow = item => {
        const cap = Number(item.cap)
        const ratio = cap > 0 ? Math.min(1, item.used / cap) : 0
        return h('div', {
          key: item.accountId,
          style: { ...listRowStyle, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, gap: 10, flexWrap: 'wrap' },
        }, [
          h('span', { key: 'name', style: { flex: '1 1 150px', minWidth: 0, color: 'var(--dsw-alias-label-primary)' } }, [
            h('span', { style: { fontSize: 13 } }, item.label),
            h('span', { key: 'meta', style: { ...accountMetaStyle, marginLeft: 6 } }, item.detail),
          ]),
          h('span', { key: 'used', style: { ...accountMetaStyle, flex: '1 1 150px' } },
            `今日已用 ${item.used} 积分${item.samples > 0 ? `（${item.samples} 次采样）` : '（尚无数据）'}${item.exhausted ? ' · 已达上限' : ''}`),
          h('input', {
            key: 'cap',
            style: { ...inputStyle, width: 150 },
            type: 'number',
            min: 0,
            step: 1,
            placeholder: '积分/日（不限留空）',
            value: item.cap,
            onChange: event => setDraft(current => ({ ...current, [item.accountId]: event.target.value })),
          }),
          h('span', { key: 'bar', style: { flex: '1 1 100px', minWidth: 70 } },
            ratio > 0 ? h('div', { style: progressTrackStyle }, h('div', { style: { ...progressBarStyle, width: `${Math.round(ratio * 100)}%` } })) : null),
        ])
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h('div', { key: 'hint', style: accountMetaStyle },
          `按 UTC+8 自然日、**每账号**统计（今日 ${view?.day ?? '—'}）。已用量 = 余额逐包减少量：签到 / 充值 / 到期都不计入，也不会冲抵已用量。某账号达到上限后，只有它自己不再被选中。`),
        h('div', { key: 'actions', style: toolbarStyle }, [
          h(ActionButton, { key: 'sample', small: true, disabled: controlKey === '', onClick: sampleBalances }, '记录当前余额（更新已用积分）'),
          h(ActionButton, { key: 'reload', small: true, onClick: () => { void load() } }, '重读'),
          h(ActionButton, { key: 'filter', small: true, onClick: () => setOnlyCapped(value => !value) }, onlyCapped ? '显示全部账号' : '只看已设上限'),
          h('span', { key: 'spacer', style: spacerStyle }),
          h('span', { key: 'file', style: accountMetaStyle }, view?.creditUsageFile ?? ''),
        ]),
        visible.length === 0
          ? h('div', { key: 'empty', style: accountMetaStyle },
            rows.length === 0 ? '还没有登录任何账号，先到「渠道账号」登录。' : '没有已设上限或今日有用量的账号。')
          : h('div', { key: 'groups', style: { display: 'flex', flexDirection: 'column', gap: 12 } }, visible.map(group => h('div', {
            key: group.provider,
            style: { display: 'flex', flexDirection: 'column', gap: 6 },
          }, [
            h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
              h('span', { key: 't', style: sectionTitleStyle }, group.label),
              h('span', { key: 'n', style: accountMetaStyle }, `${group.items.length} 个账号 · 今日合计 ${group.used} 积分`),
              h('span', { key: 'spacer', style: spacerStyle }),
              h('span', { key: 'pcap', style: accountMetaStyle }, '整渠道上限'),
              h('input', {
                key: 'cap',
                style: { ...inputStyle, width: 120 },
                type: 'number',
                min: 0,
                step: 1,
                title: '整渠道每天最多消耗多少积分（所有账号之和）；单账号限额用下面的输入框',
                placeholder: '不限',
                value: group.cap,
                onChange: event => setDraft(current => ({ ...current, [`provider:${group.provider}`]: event.target.value })),
              }),
            ]),
            ...group.items.map(renderAccountRow),
          ]))),
        h('div', { key: 'save', style: toolbarStyle }, [
          h(ActionButton, { key: 's', disabled: busy === 'save' || controlKey === '', onClick: save }, busy === 'save' ? '保存中…' : '保存积分上限'),
          h('span', { key: 'n', style: accountMetaStyle },
            accountCapped === 0 && providerCapped === 0 ? '当前没有任何上限' : `已设 ${accountCapped} 个账号${providerCapped > 0 ? ` · ${providerCapped} 个整渠道` : ''}`),
        ]),
        h('div', { key: 'limits', style: accountMetaStyle },
          '已知边界：没查过余额的账号没有数据；两次查询之间的消耗会在下一次查询时一次性计入；渠道只返回总量且没记到领取量时会低估消耗。'),
        notice !== '' ? h('div', { key: 'notice', style: bodyStyle }, notice) : null,
      ])
    }
    //#endregion

    //#region WorkBuddy：分区卡（登录/签到走内置 pack，成长中心走本插件）
    /**
     * 一个 WorkBuddy 形态的卡片。
     *
     * 与旧实现的区别：**不再依赖 dsh-workbuddy 的 control 路由**。
     * 登录 / 账号 / 签到走内置 channel-pack 的 RPC（`account.create`、`login.poll`、
     * `credits.claimAll`），成长中心（猫猫旅行 + 每日任务 + 连登）走本插件的
     * `/plugins/dsh-auth-hub/growth`。两者合起来覆盖了原来那套的全部能力。
     */
    function WorkBuddyChannelCard(props) {
      const { channel, rpc, entry, controlKey, onRefresh, onError } = props
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [login, setLogin] = useState(null)
      const [growth, setGrowth] = useState(undefined)
      const [growthError, setGrowthError] = useState('')

      const accounts = entry?.accounts
      const status = entry?.status
      const balances = entry?.balances

      // 登录轮询（与渠道账号卡同一套两阶段流程）
      useEffect(() => {
        if (login === null) return undefined
        let alive = true
        const timer = setInterval(async () => {
          if (Date.now() - login.startedAt > LOGIN_TIMEOUT_MS) {
            if (alive) { setLogin(null); setNotice('登录链接已过期，请重新发起登录') }
            return
          }
          try {
            const value = await rpc('login.poll', { accountId: login.accountId, provider: channel.provider })
            if (!alive) return
            if (value?.done === true) {
              setLogin(null)
              if (value.success === false) setNotice(`登录失败：${value.error ?? '未知原因'}`)
              else { setNotice(value.login ? `已登录：${value.login}` : '登录完成'); onRefresh(true) }
            } else if (typeof value?.error === 'string' && value.error !== '') {
              setLogin(null); setNotice(`登录失败：${value.error}`)
            }
          } catch { /* 继续轮询 */ }
        }, CHANNEL_POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [login, rpc, channel.provider, onRefresh])

      const loadGrowth = useCallback(async () => {
        setGrowthError('')
        try {
          const payload = await readGrowth(channel.provider)
          setGrowth(payload?.signedIn === true ? payload : null)
        } catch (error) { setGrowthError(errorText(error)) }
      }, [channel.provider])

      useEffect(() => {
        if (!open) return undefined
        void loadGrowth()
        return undefined
      }, [open, loadGrowth])

      const startLogin = async () => {
        setBusy('login'); setNotice('')
        try {
          const value = await rpc('account.create', { provider: channel.provider }, 90_000)
          const accountId = value?.accountId
          if (typeof accountId !== 'string' || accountId === '') throw new Error('渠道未返回账号占位 id')
          if (typeof value?.loginUrl === 'string' && value.loginUrl !== '') openExternal(value.loginUrl)
          setLogin({ accountId, url: typeof value?.loginUrl === 'string' ? value.loginUrl : '', startedAt: Date.now() })
          setOpen(true)
          onRefresh(true)
        } catch (error) { onError(channel, error) } finally { setBusy('') }
      }

      const sweep = async () => {
        setBusy('growth'); setNotice('')
        try {
          if (controlKey === '') throw new Error('拿不到 controlKey（Host 半身未加载）')
          const payload = await postGrowthSweep(controlKey, channel.provider)
          const result = payload?.result ?? {}
          const parts = []
          if (result.accepted > 0) parts.push(`接收 ${result.accepted} 个任务`)
          if (result.claimedTasks > 0) parts.push(`领取 ${result.claimedTasks} 个任务`)
          if (result.claimedCredits > 0) parts.push(`+${result.claimedCredits} 积分`)
          if (result.trip?.dispatched === true) parts.push('已派猫猫出门')
          if (result.trip?.reason === 'traveling') parts.push('猫猫还在路上')
          if (result.trip?.reason === 'daily-limit') parts.push('今日旅行已达上限')
          if (result.streakDays !== undefined) parts.push(`连登 ${result.streakDays} 天`)
          if (Array.isArray(result.errors) && result.errors.length > 0) parts.push(`${result.errors.length} 步失败`)
          setNotice(parts.length > 0 ? parts.join('，') : '没有可领取的')
          await loadGrowth()
          onRefresh(true)
        } catch (error) { onError(channel, error) } finally { setBusy('') }
      }

      const claim = async () => {
        setBusy('claim'); setNotice('')
        try {
          const value = await rpc('credits.claimAll', { provider: channel.provider }, 180_000)
          const summary = value?.summary
          if (summary === undefined) { setNotice('无可领取项'); return }
          const parts = []
          if (summary.claimed > 0) parts.push(`签到成功 ${summary.claimed} 个${summary.totalCredit > 0 ? `（+${summary.totalCredit}）` : ''}`)
          if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今日已签`)
          if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`)
          if (summary.failed > 0) parts.push(`${summary.failed} 个失败`)
          setNotice(parts.length > 0 ? parts.join('，') : '无可领取项')
          onRefresh(true)
        } catch (error) { onError(channel, error) } finally { setBusy('') }
      }

      const summary = balancesSummary(balances)
      const chips = []
      if (entry?.loading === true && accounts === undefined) chips.push({ text: '读取中…', tone: 'muted' })
      if (Array.isArray(accounts)) chips.push({ text: `${accounts.length} 个账号`, tone: 'muted' })
      if (summary.total !== undefined) chips.push({ text: `余额 ${summary.text}`, tone: 'ok' })
      if (status?.active === true) chips.push({ text: status.todayCheckedIn === true ? '今日已签' : '今日可签', tone: status.todayCheckedIn === true ? 'ok' : 'warn' })
      if (growth?.streakDays !== undefined) chips.push({ text: `连登 ${growth.streakDays} 天`, tone: 'muted' })

      return h('div', { style: subCardStyle }, [
        h('button', { key: 'head', type: 'button', style: subHeaderStyle, onClick: () => setOpen(value => !value) }, [
          h('span', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
            h('span', { key: 'name', style: nameStyle }, channel.label),
            h('span', { key: 'hint', style: descriptionStyle }, channel.hint),
          ]),
          h('span', { key: 'chips', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            chips.map((chip, index) => h(Chip, { key: index, tone: chip.tone }, chip.text))),
          h(ChevronDownOutline14, { key: 'chev', open }),
        ]),
        open ? h('div', { style: subBodyStyle }, [
          login !== null ? h('div', { key: 'login', style: accountItemStyle }, [
            h('div', { style: rowStyle }, [
              h('span', { style: statusStyle }, '等待浏览器完成登录…'),
              h('span', { style: accountMetaStyle }, `剩余 ${remainingText(login.startedAt)}`),
            ]),
            h('div', { style: accountActionsStyle }, h(ActionButton, { small: true, onClick: () => setLogin(null) }, '取消')),
          ]) : null,
          h('div', { key: 'toolbar', style: toolbarStyle }, [
            h(ActionButton, { key: 'login', disabled: busy === 'login', onClick: startLogin }, busy === 'login' ? '正在发起…' : '+ 登录账号'),
            h(ActionButton, { key: 'claim', small: true, disabled: busy === 'claim', onClick: claim }, busy === 'claim' ? '签到中…' : '每日签到'),
            h(ActionButton, { key: 'growth', small: true, disabled: busy === 'growth', onClick: sweep }, busy === 'growth' ? '清扫中…' : '成长中心一键'),
            h('span', { key: 'spacer', style: spacerStyle }),
            h(ActionButton, { key: 'reload', small: true, onClick: () => onRefresh(true) }, '刷新'),
          ]),
          notice !== '' ? h('div', { key: 'notice', style: bodyStyle }, notice) : null,
          entry?.error !== undefined ? h('div', { key: 'err', style: errorStyle }, entry.error) : null,
          growthError !== '' ? h('div', { key: 'gerr', style: errorStyle }, `成长中心：${growthError}`) : null,
          growth === null ? h('div', { key: 'gnone', style: accountMetaStyle }, '成长中心：未登录或无数据') : null,
          growth !== undefined && growth !== null ? h('div', { key: 'growth', style: accountItemStyle }, [
            h('div', { key: 'row', style: rowStyle }, [
              h('span', { key: 'state', style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
                growth.status?.state === 'traveling' ? `猫猫正在前往${growth.status.locationName ?? '目的地'}`
                  : growth.status?.state === 'arrived' ? `猫猫已从${growth.status.locationName ?? '目的地'}回来`
                    : growth.status?.dailyLimitReached === true ? '今日旅行已完成' : '猫猫在家'),
              h('span', { key: 'reward', style: accountMetaStyle },
                [growth.streakDays !== undefined ? `连登 ${growth.streakDays} 天` : '',
                 growth.rewardToday !== undefined ? `今日 +${growth.rewardToday}` : ''].filter(Boolean).join(' · ')),
            ]),
            Array.isArray(growth.tasks) && growth.tasks.length > 0
              ? h('div', { key: 'tasks', style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                growth.tasks.slice(0, 6).map(task => h('div', {
                  key: task.code,
                  style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
                }, [
                  h('span', { key: 't' }, task.title),
                  h('span', { key: 'p' }, `${task.current}/${task.target}${task.rewardCredit > 0 ? ` · +${task.rewardCredit}` : ''}`),
                ])))
              : h('div', { key: 'notasks', style: accountMetaStyle }, '没有成长任务'),
          ]) : null,
          accounts === undefined
            ? h('div', { key: 'loading', style: accountMetaStyle }, '读取账号…')
            : accounts.length === 0
              ? h('div', { key: 'empty', style: accountMetaStyle }, '还没有账号，点「+ 登录账号」用浏览器授权。')
              : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, accounts.map(account =>
                h('div', { key: account.id, style: accountItemStyle }, [
                  h('div', { key: 'row', style: accountRowStyle }, [
                    h('span', { key: 'text', style: accountTextStyle }, [
                      h('span', { style: { fontSize: 14, color: 'var(--dsw-alias-label-primary)' } }, account.nickname || account.id),
                      h(MetaLine, { key: 'meta' }, [
                        account.enabled === false ? '已停用' : '已启用',
                        account.expiresAt ? ` · 到期 ${formatTime(account.expiresAt)}` : '',
                        growth?.status?.state ? ` · 成长 ${growth.status.state}` : '',
                      ].join('')),
                    ]),
                    h('div', { key: 'actions', style: accountActionsStyle },
                      h(ActionButton, { small: true, disabled: busy === `del:${account.id}`, onClick: async () => {
                        setBusy(`del:${account.id}`)
                        try { await rpc('account.delete', { accountId: account.id }); onRefresh(true) } catch (error) { onError(channel, error) } finally { setBusy('') }
                      } }, '移除')),
                  ]),
                ]))),
        ]) : null,
      ])
    }
    //#endregion

    //#region 账号中心主体
    /**
     * 数据层：一次把 13 个渠道的「账号 / 签到状态 / 余额」拉回来。
     *
     * 不再等用户展开卡片 —— 折叠状态就要看到「N 个账号 · 余额 X · 今日已签」。
     * 并发上限 3：13 平台 × 3 接口 = 39 次调用，全并发会同时打出几十个上游请求
     * （余额接口每个账号一次网络请求），既慢又容易触发风控。
     */
    function AccountHubSection(props) {
      const { ctx } = props
      const rpc = useMemo(() => makeChannelRpc(ctx), [ctx])
      const channelAvailable = rpc !== undefined

      const [open, setOpen] = useState(true)
      const [tab, setTab] = useState('channels')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [updatedAt, setUpdatedAt] = useState(0)
      const [providers, setProviders] = useState({})
      const [autoCheckin, setAutoCheckin] = useState(undefined)
      const [autoClaim, setAutoClaim] = useState(() => {
        try { return window.localStorage.getItem(AUTO_CLAIM_STORAGE_KEY) !== '0' } catch { return true }
      })
      const [claimLog, setClaimLog] = useState('')
      /**
       * 父级也要 hold 一份 controlKey：WorkBuddy 卡的「成长中心一键」要它。
       * ⚠️ 子组件里各自的 `useState('')` 是**局部**的，读过这里会 ReferenceError
       *    —— 那个错误会让整个分区渲染失败、页面一片空白（实测踩过）。
       */
      const [controlKey, setControlKey] = useState('')
      const claimedRef = useRef(new Set())
      const claimQueueRef = useRef(Promise.resolve())

      /** 读一次宿主下发的 controlKey（写操作都要它）。 */
      useEffect(() => {
        let alive = true
        void readHubStatus()
          .then(hub => { if (alive && typeof hub?.controlKey === 'string') setControlKey(hub.controlKey) })
          .catch(() => { /* Host 半身没加载时保持空串，写操作会给出可读错误 */ })
        return () => { alive = false }
      }, [])

      const reportError = useCallback((scope, caught) => {
        const actual = caught === undefined ? scope : caught
        const label = typeof scope === 'string' ? scope : (typeof scope?.label === 'string' ? scope.label : '')
        setError(label !== '' ? `${label}：${errorText(actual)}` : errorText(actual))
      }, [])

      /** 领取某渠道今天能领的额度；返回给用户看的一句话。 */
      const claimProvider = useCallback(async provider => {
        const value = await rpc('credits.claimAll', { provider }, 180_000)
        const summary = value?.summary
        if (summary === undefined) return '无可领取项'
        const parts = []
        if (summary.claimed > 0) parts.push(`领取成功 ${summary.claimed} 个${summary.totalCredit > 0 ? `（+${summary.totalCredit}）` : ''}`)
        if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今日已领`)
        if (summary.pendingRefresh > 0) parts.push(`${summary.pendingRefresh} 个等 10:00 刷新`)
        if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`)
        if (summary.failed > 0) parts.push(`${summary.failed} 个失败`)
        return parts.length > 0 ? parts.join('，') : '无可领取项'
      }, [rpc])

      const loadProvider = useCallback(async (provider, force = false) => {
        setProviders(current => ({ ...current, [provider]: { ...(current[provider] ?? {}), loading: true } }))
        const entry = { loading: false, updatedAt: Date.now() }
        try {
          const value = await rpc('account.list', { provider })
          entry.accounts = Array.isArray(value?.accounts) ? value.accounts : []
        } catch (error) { entry.error = errorText(error) }
        try {
          const value = await rpc('credits.status', { provider })
          const rows = Array.isArray(value?.accounts) ? value.accounts : []
          entry.status = rows[0]?.status ?? null
        } catch { /* 该渠道没有签到能力 */ }
        try {
          const value = await rpc('credits.balances', { provider, ...(force ? { force: true } : {}) }, 90_000)
          entry.balances = Array.isArray(value?.accounts) ? value.accounts : []
        } catch (error) { entry.balanceError = errorText(error) }
        setProviders(current => ({ ...current, [provider]: entry }))
        return entry
      }, [rpc])

      /** 未签到就补签：串行排队（并发领取容易触发风控），每个渠道每次打开只试一次。 */
      const scheduleAutoClaim = useCallback((provider, entry) => {
        if (autoClaim !== true) return
        if (entry?.status?.active !== true || entry.status.todayCheckedIn === true) return
        if (claimedRef.current.has(provider)) return
        claimedRef.current.add(provider)
        claimQueueRef.current = claimQueueRef.current.then(async () => {
          try {
            const text = await claimProvider(provider)
            setClaimLog(current => `${current === '' ? '' : `${current}；`}${provider} ${text}`)
            await loadProvider(provider, false)
          } catch (error) {
            claimedRef.current.delete(provider)
            reportError(provider, error)
          }
        })
      }, [autoClaim, claimProvider, loadProvider, reportError])

      const refreshAll = useCallback(async force => {
        if (!channelAvailable) return
        setError('')
        const list = CHANNEL_PLATFORMS.map(platform => platform.provider)
        let cursor = 0
        const workers = Array.from({ length: Math.min(LOAD_CONCURRENCY, list.length) }, async () => {
          while (cursor < list.length) {
            const provider = list[cursor]
            cursor += 1
            try {
              const entry = await loadProvider(provider, force)
              scheduleAutoClaim(provider, entry)
            } catch (error) { reportError(provider, error) }
          }
        })
        await Promise.all(workers)
        setUpdatedAt(Date.now())
        // 账号渠道的模型目录随「全部刷新」一起重读（逐 provider 的 model.list）。
      }, [channelAvailable, loadProvider, scheduleAutoClaim, reportError])


      const loadAutoCheckin = useCallback(async () => {
        if (rpc === undefined) return
        try {
          const value = await rpc('usage.autoCheckin', {}, 30_000)
          setAutoCheckin(value?.autoCheckin ?? null)
        } catch { setAutoCheckin(null) }
      }, [rpc])

      useEffect(() => {
        if (!open) return undefined
        void refreshAll(false)
        void loadAutoCheckin()
        const timer = setInterval(() => { void refreshAll(false) }, DATA_HEARTBEAT_MS)
        return () => clearInterval(timer)
      }, [open, refreshAll, loadAutoCheckin])

      const toggleAutoClaim = () => {
        setAutoClaim(current => {
          const next = !current
          try { window.localStorage.setItem(AUTO_CLAIM_STORAGE_KEY, next ? '1' : '0') } catch { /* 私有模式 */ }
          if (next) claimedRef.current = new Set()
          return next
        })
      }

      const togglePluginAutoCheckin = async () => {
        if (rpc === undefined) return
        try {
          const value = await rpc('usage.autoCheckin', { enabled: autoCheckin?.enabled !== true }, 60_000)
          setAutoCheckin(value?.autoCheckin ?? null)
        } catch (error) { reportError('插件自动签到', error) }
      }

      const claimOne = useCallback(async provider => {
        const text = await claimProvider(provider)
        await loadProvider(provider, false)
        return text
      }, [claimProvider, loadProvider])

      const pendingClaims = CHANNEL_PLATFORMS
        .filter(platform => (providers ?? {})[platform.provider]?.status?.active === true && (providers ?? {})[platform.provider]?.status?.todayCheckedIn !== true)
        .map(platform => platform.label)

      const channelsBody = channelAvailable
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, CHANNEL_PLATFORMS.map(platform => h(ChannelPlatformCard, {
          key: platform.provider,
          platform,
          rpc,
          entry: providers[platform.provider],
          onRefresh: force => { void loadProvider(platform.provider, force !== false) },
          onClaim: () => claimOne(platform.provider),
          onError: reportError,
        })))
        : h('div', { key: 'noconn', style: errorStyle }, '当前 shell 未提供 connection 服务，渠道账号无法在此页读取（WorkBuddy 不受影响）。')

      const workBuddyBody = h('div', { key: 'wb', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        WORKBUDDY_CHANNELS.map(channel => h(WorkBuddyChannelCard, {
          key: channel.provider,
          channel,
          rpc,
          entry: providers[channel.provider],
          controlKey,
          onRefresh: force => { void loadProvider(channel.provider, force !== false) },
          onError: reportError,
        })))
      const tabs = [
        { id: 'channels', label: `渠道账号（${CHANNEL_PLATFORMS.length}）` },
        { id: 'models', label: '按模型' },
        { id: 'credits', label: '积分上限' },
        { id: 'workbuddy', label: 'WorkBuddy' },
      ]

      return h('section', { style: cardStyle }, [
        h('button', {
          key: 'head',
          type: 'button',
          style: headerStyle,
          onClick: () => setOpen(value => !value),
        }, [
          h('span', { key: 'text', style: headTextStyle }, [
            h('span', { key: 'name', style: nameStyle }, '账号中心'),
            h('span', { key: 'desc', style: descriptionStyle }, '13 个渠道账号 + WorkBuddy 的登录、余额、签到；按模型看账号；组合轮换与每日限量'),
          ]),
          h(ChevronDownOutline14, { key: 'chev', open }),
        ]),
        open ? h('div', { key: 'body', style: cardBodyStyle }, [
          h('div', { key: 'toolbar', style: toolbarStyle }, [
            h(ActionButton, { key: 'refresh', disabled: !channelAvailable, onClick: () => refreshAll(true) }, '全部刷新'),
            h(ActionButton, { key: 'autoclaim', small: true, onClick: toggleAutoClaim },
              autoClaim ? '自动补签：开' : '自动补签：关'),
            h(ActionButton, {
              key: 'auto',
              small: true,
              disabled: !channelAvailable,
              onClick: togglePluginAutoCheckin,
            }, autoCheckin === undefined ? '插件签到：未知' : (autoCheckin?.enabled === true ? '插件签到：开' : '插件签到：关')),
            h('span', { key: 'spacer', style: spacerStyle }),
            updatedAt > 0 ? h('span', { key: 'at', style: accountMetaStyle }, `更新于 ${formatTime(updatedAt)}`) : null,
          ]),
          claimLog !== '' ? h('div', { key: 'claims', style: bodyStyle }, `自动补签：${claimLog}`) : null,
          pendingClaims.length > 0 ? h('div', { key: 'pending', style: accountMetaStyle }, `今天还没签到的渠道：${pendingClaims.join('、')}`) : null,
          error !== '' ? h('div', { key: 'error', style: errorStyle }, error) : null,
          notice !== '' ? h('div', { key: 'notice', style: bodyStyle }, notice) : null,
          h('div', { key: 'tabs', style: tabBarStyle }, tabs.map(item =>
            h('button', {
              key: item.id,
              type: 'button',
              style: { ...tabStyle, ...(tab === item.id ? tabActiveStyle : {}) },
              onClick: () => setTab(item.id),
            }, item.label))),
          h('div', { key: 'panel', style: sectionStyle }, [
            tab === 'channels' ? channelsBody : null,
            tab === 'models' ? h(AccountModelTab, {
              rpc,
              platforms: CHANNEL_PLATFORMS,
              providers,
              onError: reportError,
            }) : null,
            tab === 'credits' ? h(CreditCapTab, {
              platforms: CHANNEL_PLATFORMS,
              providers,
              onError: reportError,
            }) : null,
            tab === 'workbuddy' ? workBuddyBody : null,
          ]),
        ]) : null,
      ])
    }
    //#endregion

    //#region 插件入口
    const NS = 'settings.auth-hub'
    const DICT = {
      zh: { nav: '账号中心' },
      en: { nav: 'Account Hub' },
    }
    const name = 'dsh-auth-hub-client'
    const inject = ['slots', 'locale']

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-auth-hub: settings copy')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'auth-hub',
          order: 17,
          label: () => t('nav'),
          locale: NS,
        }, props => h(AccountHubSection, { ...props, ctx })))
      } catch (caught) {
        // slot API 变动时降级为日志，不把 DSH 加载器打挂（两个后端插件不受影响）。
        console.error('[dsh-auth-hub] 账号中心设置页加载失败：', caught)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})