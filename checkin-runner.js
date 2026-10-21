/**
 * 签到执行器：把一条声明式渠道真的打出去，并把结果落账。
 *
 * 这里是「配置」与「效果」之间唯一的桥：
 *
 *   渠道配置 + 密钥  →  HTTP 请求  →  evaluateResponse()  →  credit-usage 台账 + 状态
 *
 * 三条刻意的设计：
 *
 * 1. **不重试**。签到接口几乎都是「成功一次就没了」，重试要么是白打一发，要么
 *    会被站点当成刷单。失败就把原因原样记进状态给人看。
 * 2. **超时短**（默认 20 秒）。签到接口都是轻量 JSON，慢就是坏了；长超时只会让
 *    一轮自动签到卡住后面的渠道。
 * 3. **奖励落 grants**。这样「领了又用掉」不会被余额差分算成 0 消耗——口径与
 *    channel-pack 的签到完全一致（见 credit-usage.js 的 v2 说明）。
 */
import {
  CHECKIN_CHANNELS_FILE,
  CHECKIN_SECRETS_FILE,
  CHECKIN_SETTINGS_FILE,
  CHECKIN_STATE_FILE,
  NEWAPI_PROBE_PATHS,
  NEWAPI_SIGN_PATHS,
  evaluateResponse,
  isDue,
  looksLikeNewApiCheckin,
  looksLikeNewApiSite,
  nextState,
  normalizeChannels,
  normalizeOrigin,
  normalizeSecrets,
  normalizeSettings,
  readJsonFile,
  utc8Day,
  writeJsonFile,
} from './checkin-channels.js'

const DEFAULT_TIMEOUT_MS = 20_000

/** 一次签到的最长时间；环境变量可调（弱网 / 境外站点）。 */
function timeoutMs() {
  const raw = Number(process.env.DSH_CHECKIN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 1000 ? Math.min(raw, 120_000) : DEFAULT_TIMEOUT_MS
}

function files(dir) {
  return {
    channels: `${dir}/${CHECKIN_CHANNELS_FILE}`,
    secrets: `${dir}/${CHECKIN_SECRETS_FILE}`,
    state: `${dir}/${CHECKIN_STATE_FILE}`,
    settings: `${dir}/${CHECKIN_SETTINGS_FILE}`,
  }
}

/** 读全量：配置、密钥、状态、设置。 */
export function readCheckinStore(dir) {
  const path = files(dir)
  const raw = readJsonFile(path.channels, { channels: [] })
  const { channels } = normalizeChannels(raw)
  const secrets = normalizeSecrets(readJsonFile(path.secrets, {}), channels)
  const stateRaw = readJsonFile(path.state, { channels: {} })
  const state = stateRaw !== null && typeof stateRaw === 'object' && stateRaw.channels !== null && typeof stateRaw.channels === 'object'
    ? stateRaw.channels
    : {}
  return { channels, secrets, state, settings: normalizeSettings(readJsonFile(path.settings, {})) }
}

/**
 * 写入配置 + 密钥。
 *
 * 密钥按渠道**整体替换**（不是逐头合并）：用户删掉一个头，就得真的消失，否则
 * 界面上删掉的 `Cookie` 下次还会被发出去。调用方（`mergeCheckinChannels`）负责
 * 先把「旧值 + 用户改动」合成完整的一份再交进来。
 */
export function writeCheckinStore(dir, { channels, secrets, settings }) {
  const path = files(dir)
  const normalized = normalizeChannels(channels)
  writeJsonFile(path.channels, { version: 1, channels: normalized.channels })
  const live = new Set(normalized.channels.map(channel => channel.id))
  const cleaned = {}
  for (const [id, headers] of Object.entries(normalizeSecrets(secrets ?? {}, normalized.channels))) {
    if (live.has(id)) cleaned[id] = headers
  }
  writeJsonFile(path.secrets, cleaned)
  if (settings !== undefined) writeJsonFile(path.settings, normalizeSettings(settings))
  return { channels: normalized.channels, secrets: cleaned, problems: normalized.problems }
}

function writeState(dir, channels, state) {
  const live = new Set(channels.map(channel => channel.id))
  const pruned = {}
  for (const [id, value] of Object.entries(state)) if (live.has(id)) pruned[id] = value
  writeJsonFile(`${dir}/${CHECKIN_STATE_FILE}`, { version: 1, channels: pruned })
  return pruned
}

/**
 * 打一发签到。
 *
 * 返回里**不抛异常**：签到失败是常态（Cookie 过期、站点改版），调用方要的是
 * 「哪些成功、哪些为什么失败」这一份可展示的结果，而不是一个 throw。
 *
 * @returns {Promise<{ ok: boolean, alreadyDone: boolean, reward?: number, message: string, status: number, durationMs: number }>}
 */
export async function runCheckin(channel, headers, options = {}) {
  const startedAt = Date.now()
  const url = channel?.url ?? ''
  if (url === '') return { ok: false, alreadyDone: false, message: '缺少签到 URL', status: 0, durationMs: 0 }
  const method = channel.method ?? 'POST'
  const requestHeaders = { Accept: 'application/json, text/plain, */*', ...(headers ?? {}) }
  if (channel.contentType !== '' && channel.contentType !== undefined) requestHeaders['Content-Type'] = channel.contentType
  const init = { method, headers: requestHeaders, signal: AbortSignal.timeout(options.timeoutMs ?? timeoutMs()) }
  if (method !== 'GET' && method !== 'DELETE' && typeof channel.body === 'string' && channel.body !== '') init.body = channel.body
  try {
    const response = await fetch(url, init)
    // 有些站点签到成功会 302 到首页：`redirect: 'follow'`（默认）会把最终页面当
    // 响应体，判定规则里写的「已签到」正则因此仍然有效。
    const bodyText = await response.text()
    const verdict = evaluateResponse(channel, { status: response.status, text: bodyText })
    return { ...verdict, status: response.status, durationMs: Date.now() - startedAt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = error?.name === 'TimeoutError' || /abort/i.test(message)
    return {
      ok: false,
      alreadyDone: false,
      message: aborted ? `请求超时（${(options.timeoutMs ?? timeoutMs()) / 1000}s）` : `请求失败：${message}`,
      status: 0,
      durationMs: Date.now() - startedAt,
    }
  }
}

/**
 * 跑一批渠道。
 *
 * `ids` 为空时跑「到点且今天没签过」的那些；给了 `ids` 就跑这些（界面上的
 * 「立即签到」按钮）。`force` 让手动执行无视「今天已签」——用户可能刚换了
 * Cookie，想看新配置是不是通的。
 *
 * @param {object} deps
 * @param {string} deps.dir              `$DSH_HOME/channel-pack`
 * @param {(provider: string, accountId: string, amount: number, at: number) => void} [deps.recordGrant]
 * @param {string[]} [deps.ids]
 * @param {boolean} [deps.force]
 * @param {number} [deps.nowMs]
 * @param {(message: string) => void} [deps.info]
 * @param {(message: string) => void} [deps.warn]
 */
export async function runCheckinBatch(deps) {
  const nowMs = deps.nowMs ?? Date.now()
  const day = utc8Day(nowMs)
  const store = readCheckinStore(deps.dir)
  const all = store.channels
  const wanted = Array.isArray(deps.ids) && deps.ids.length > 0
    ? all.filter(channel => deps.ids.includes(channel.id))
    : all.filter(channel => (deps.force === true
      ? channel.enabled !== false
      : isDue(channel, store.state[channel.id], nowMs, store.settings)))
  const results = []
  for (const channel of wanted) {
    const headers = store.secrets[channel.id] ?? {}
    const previous = store.state[channel.id]
    const alreadyCountedToday = previous?.lastDay === day
    const outcome = await runCheckin(channel, headers)
    const state = nextState(previous, outcome, { day, nowMs: Date.now() })
    store.state[channel.id] = state
    // 奖励只在「今天第一次真正签成功」时入账。
    //
    // 手动 `force` 重签（用户换完 Cookie 想验证）会再打一发；如果这次站点仍然
    // 返回一个 reward 数值，那不是新领取的额度，重复入账会把「今天已用」算低
    // ——台账是拿 grants 反推消耗的（见 credit-usage.js 的 v2 说明）。
    const shouldRecord = outcome.ok === true
      && outcome.alreadyDone !== true
      && Number(outcome.reward) > 0
      && alreadyCountedToday !== true
      && typeof deps.recordGrant === 'function'
    if (shouldRecord) {
      try {
        deps.recordGrant(channel.id, channel.id, Number(outcome.reward), Date.now())
      } catch (error) {
        deps.warn?.(`checkin: 记录奖励失败（${channel.id}）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (outcome.ok === true) {
      const suffix = outcome.alreadyDone === true
        ? '今天已签'
        : `签到成功${Number(outcome.reward) > 0 ? ` +${outcome.reward}${channel.rewardUnit}` : ''}`
      deps.info?.(`checkin: ${channel.label} ${suffix}${shouldRecord ? '' : (alreadyCountedToday && outcome.alreadyDone !== true ? '（今天已记过，不重复入账）' : '')}`)
    } else {
      deps.warn?.(`checkin: ${channel.label} 失败：${outcome.message}`)
    }
    results.push({ id: channel.id, label: channel.label, ...outcome, counted: shouldRecord, state })
  }
  writeState(deps.dir, all, store.state)
  return { day, ran: results.length, results }
}

/** 界面上「签一下试试」用的单发（不落状态、不记奖励，只回判定结果）。 */
export async function probeCheckin(channel, headers) {
  return runCheckin(channel, headers)
}

/**
 * 探测一个站点是不是 New API 系，并试出它真正可用的签到端点。
 *
 * 三步，全部**只读**（不会替用户签一次）：
 *   1. `GET /api/status`（或 `/api/about`）→ 看是不是 New API / One API 系；
 *   2. `POST` 候选签到端点，带用户给的 Cookie / New-Api-User → 看返回体形状；
 *   3. 用一个不存在的端点确认「404 与签到响应的区别」，避免把「通配 200」误判。
 *
 * 第 2 步**可能真的触发签到**——这不可避：New API 的成功响应与「今天已签」都只能
 * 由签到接口本身给出。所以调用方必须在界面上说清楚「这一步可能直接签掉今天的」，
 * 而不是偷偷跑。
 *
 * @returns {Promise<{ ok: boolean, origin: string, isNewApi: boolean, signPath?: string,
 *   checkinLike?: boolean, alreadyDone?: boolean, reward?: number, message: string,
 *   needsTurnstile?: boolean, siteName?: string }>}
 */
export async function probeNewApiSite(origin, options = {}) {
  const timeout = options.timeoutMs ?? timeoutMs()
  const base = normalizeOrigin(origin)
  if (base === undefined) return { ok: false, origin: '', isNewApi: false, message: '域名不合法' }
  const headers = { Accept: 'application/json, text/plain, */*' }
  if (typeof options.cookie === 'string' && options.cookie !== '') headers.Cookie = options.cookie
  if (typeof options.userId === 'string' && options.userId !== '') headers['New-Api-User'] = options.userId

  // ① 站点身份
  let isNewApi = false
  let siteName = ''
  for (const path of NEWAPI_PROBE_PATHS) {
    try {
      const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeout) })
      if (!response.ok) continue
      const text = await response.text()
      let json
      try { json = JSON.parse(text) } catch { continue }
      if (looksLikeNewApiSite(json)) {
        isNewApi = true
        const data = json.data !== null && typeof json.data === 'object' ? json.data : json
        siteName = String(data.system_name ?? data.name ?? '')
        break
      }
    } catch { /* 该路径不通，试下一个 */ }
  }

  // ② 签到端点：逐个试，第一个「像签到响应」的胜出
  let signPath
  let checkinLike = false
  let alreadyDone = false
  let reward
  let message = ''
  let needsTurnstile = false
  let lastError = ''
  for (const path of NEWAPI_SIGN_PATHS) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(timeout),
      })
      // Turnstile 拦截的典型形态：200 + HTML（挑战页），或 403 + cf 相关文案。
      const bodyText = await response.text()
      if (/turnstile|cf-chl|just a moment|challenge-platform/i.test(bodyText)) {
        needsTurnstile = true
        message = '站点开启了 Cloudflare Turnstile 人机校验，纯协议签到会被拦'
        continue
      }
      let json
      try { json = JSON.parse(bodyText) } catch {
        lastError = `HTTP ${response.status}（响应不是 JSON）`
        continue
      }
      // ⚠️ 这里有个必须守住的边界：**非 2xx 的响应不能当签到结果**。
      // New API 的 404 处理也会回 `{"success":false,"message":"not found"}`，
      // 与「今日已签到」形状完全一样（都是 success:false + message）。若不看状态码，
      // 就会把「这个端点根本不存在」误判成「今天已经签过了」，于是永远不试下一个
      // 候选端点（AnyRouter 系的 /api/user/sign_in 就这么被跳过了），也会把一台
      // 完全不是 New API 的站点误认成认得出签到协议。
      if (!response.ok) {
        // 401/403 但带“未登录/无效令牌”这类业务文案，说明端点是对的、凭据不对——
        // 这种要记下来当结论，而不是静默跳到下一个端点。
        const why = String(json?.message ?? '')
        if ((response.status === 401 || response.status === 403) && why !== '') {
          signPath = path
          checkinLike = true
          message = `端点存在但凭据被拒（HTTP ${response.status}）：${why.slice(0, 120)}`
          break
        }
        lastError = `HTTP ${response.status}：${why.slice(0, 80)}`
        continue
      }
      if (!looksLikeNewApiCheckin(json)) {
        if (typeof json?.message === 'string' && /turnstile|人机|验证/i.test(json.message)) needsTurnstile = true
        lastError = `响应不像签到结果：${bodyText.slice(0, 100)}`
        continue
      }
      signPath = path
      checkinLike = true
      if (json.success === true) {
        const value = Number(json.data?.quota_awarded)
        if (Number.isFinite(value) && value >= 0) reward = value
        message = reward === undefined ? '签到成功' : `签到成功，+${reward}`
      } else {
        const why = String(json.message ?? '')
        // 只有「已签到」才是正常的重复态；其余（未登录 / 未启用）都算失败。
        alreadyDone = /已签|已经签|重复|already/i.test(why)
        message = why === '' ? '签到接口有响应但未给出原因' : why
      }
      break
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  if (signPath === undefined && message === '' && lastError !== '') message = lastError

  return {
    ok: checkinLike,
    origin: base,
    isNewApi,
    ...(signPath === undefined ? {} : { signPath }),
    checkinLike,
    ...(alreadyDone ? { alreadyDone } : {}),
    ...(reward === undefined ? {} : { reward }),
    ...(needsTurnstile ? { needsTurnstile } : {}),
    ...(siteName === '' ? {} : { siteName }),
    message: message === '' ? (isNewApi ? '是 New API 站点，但没试出可用的签到端点' : '没认出是 New API 站点（可能不是这套系统，或域名填错）') : message,
  }
}
