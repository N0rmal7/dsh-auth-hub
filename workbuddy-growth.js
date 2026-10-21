/**
 * WorkBuddy 成长中心（猫猫旅行 + 每日任务 + 连登）—— 从 `dsh-workbuddy` 迁移。
 *
 * 为什么搬过来：这两块功能 pack.js **没有**（pack 只管 13 个渠道的登录与每日签到），
 * 而它们是 `dsh-workbuddy` 独有的。为了让本插件能独立替代它，这里按原实现重写一遍。
 *
 * 原实现的几个「血泪教训」全部保留，因为它们决定了这套接口能否用对：
 *   1. `depart` 拒绝空 body（HTTP 400 `invalid request`），上游**不替你选目的地**，
 *      所以「没有偏好」也得从 `/config` 里挑第一个 id 传进去。
 *   2. `/status` 在猫猫回到 idle 后恒报 `reward_credit: 0`，无论是否真的派发过奖励；
 *      要拿「今天到底挣了多少」必须读 `/records`（按 `travel_date` 匹配、`claimed_at != 0`）。
 *   3. 连登天数的路径**没有** `/v2` 前缀：`/v2/activity/growth/streak` 会 404。
 *   4. `/v2/report` 的 body 必须是**数组**（单条也要包成数组）；传对象不会报错但不计数。
 *   5. 任务的 accept/claim 是**软失败**：未完成回 HTTP 400「错误的请求」、已领回非零业务码，
 *      两者都是正常状态，必须作为结果返回而不是抛异常 —— 否则整轮会死在最后一条已处理的
 *      任务上。
 *   6. 两个区（国际版 / 国内版）的 `Origin`/`Referer` 与 base 都不同，按凭据的 `domain`
 *      判定（空 domain 视为国际版）。
 *
 * 所有函数都接收 `credential`：`{ accessToken, domain }`（`accessToken` 是驼峰，
 * 与本插件其它地方用的 `access_token` 不同 —— 这里刻意沿用原实现的字段名，便于对照）。
 */

const JSON_TIMEOUT_MS = 30_000
const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'
const GROWTH_PREFIX = '/activity/growth/buddy/travel'
const GROWTH_TASKS_PREFIX = '/v2/activity/growth/tasks'

/** 域名 → 区：以 `.ai` 结尾（或空）算国际版，其余算国内版。 */
export function regionOf(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  if (lowered === '' || lowered.endsWith('workbuddy.ai') || lowered.endsWith('codebuddy.ai')) return 'global'
  return 'cn'
}

function originReferer(credential) {
  return regionOf(credential?.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** 上游信封：`{ code, msg, data }`，非 JSON 直接抛（那是真的坏了）。 */
async function readEnvelope(response) {
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  return {
    code: typeof parsed.code === 'number' ? parsed.code : 0,
    msg: typeof parsed.msg === 'string' ? parsed.msg : '',
    data: 'data' in parsed ? parsed.data : undefined,
  }
}

const HARD_CREDIT_MARKERS = ['insufficient', 'no credit', 'quota exceeded', '余额不足']
const SESSION_DEAD_MARKERS = ['登录已失效', 'token expired', 'invalid token', 'unauthorized']

/** 把上游错误归类成几个可判定的种类（与 `dsh-workbuddy` 同口径）。 */
export function classifyUpstreamError(status, body) {
  const text = String(body ?? '')
  if (status === 402) return 'hard_credit'
  const lower = text.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase())) return 'hard_credit'
  for (const marker of SESSION_DEAD_MARKERS) if (text.includes(marker)) return 'session_dead'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/** 成长中心要求的头：Origin/Referer 必须指向该区的 billing 站点。 */
function growthHeaders(credential) {
  const base = originReferer(credential)
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Codebuddy-Request': '1',
    'X-Client-Platform': 'web',
    Origin: base,
    Referer: `${base}/profile/growth-center`,
  }
}

async function growthRequest(credential, path, method, body) {
  const response = await fetch(`${originReferer(credential)}${GROWTH_PREFIX}${path}`, {
    method,
    headers: growthHeaders(credential),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) {
    const kind = classifyUpstreamError(response.status, envelope.msg)
    throw new Error(`workbuddy growth ${kind} (http ${response.status}): ${envelope.msg.slice(0, 160)}`)
  }
  return typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data) ? envelope.data : {}
}

/** 软请求：业务失败作为结果返回，不抛。 */
async function growthSoftRequest(credential, url, method, body) {
  const response = await fetch(url, {
    method,
    headers: growthHeaders(credential),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  const data = typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data) ? envelope.data : {}
  return { ok: response.ok && envelope.code === 0, code: envelope.code, msg: envelope.msg, data }
}

const growthUrl = (credential, path) => `${originReferer(credential)}${path}`

/**
 * 读成长计划状态（**只读**：GET 是卡片轮询用的，绝不能是派发旅行的调用）。
 */
export async function fetchGrowthStatus(credential) {
  const data = await growthRequest(credential, '/status', 'GET')
  const number = (...keys) => {
    for (const key of keys) {
      const value = data[key]
      if (typeof value === 'number') return value
    }
    return undefined
  }
  const location = typeof data.location === 'object' && data.location !== null ? data.location : undefined
  const recordId = number('record_id', 'recordId')
  const rewardCredit = number('reward_credit', 'rewardCredit')
  const arriveAt = number('arrive_at', 'arriveAt')
  return {
    state: typeof data.state === 'string' ? data.state : '',
    dailyLimitReached: data.daily_limit_reached === true,
    ...(recordId === undefined || recordId === 0 ? {} : { recordId }),
    ...(rewardCredit === undefined || rewardCredit === 0 ? {} : { rewardCredit }),
    ...(arriveAt === undefined || arriveAt === 0 ? {} : { arriveAt: arriveAt * 1e3 }),
    ...(typeof location?.name === 'string' ? { locationName: location.name } : {}),
  }
}

/** `/config` 公布可去的目的地 id —— 空 body 派发会被上游拒，只能从这里拿。 */
export async function fetchGrowthLocations(credential) {
  const data = await growthRequest(credential, '/config', 'GET')
  const locations = Array.isArray(data.locations) ? data.locations : []
  const ids = []
  for (const location of locations) {
    if (typeof location !== 'object' || location === null) continue
    const id = location.id
    if (typeof id === 'number' && id !== 0) ids.push(id)
  }
  return ids
}

/**
 * 今天这次旅行到底给了多少积分 —— 从 `/records` 读，`/status` 答不了
 * （回到 idle 后它恒报 0）。没有今日已完成的记录时返回 `undefined`，
 * 与「确实给了 0」区分开。
 */
export async function fetchGrowthRewardToday(credential, day) {
  const data = await growthRequest(credential, '/records', 'GET')
  const records = Array.isArray(data.records) ? data.records : []
  for (const entry of records) {
    if (typeof entry !== 'object' || entry === null) continue
    if (entry.travel_date !== day) continue
    if (typeof entry.claimed_at !== 'number' || entry.claimed_at === 0) continue
    if (typeof entry.reward_credit === 'number') return entry.reward_credit
  }
  return undefined
}

/** 领取已完成旅行的积分（`claim` 上游幂等，先领再派发是安全的）。 */
export async function claimGrowth(credential, recordId) {
  try {
    const reward = (await growthRequest(credential, '/claim', 'POST', recordId === undefined ? {} : { record_id: recordId })).reward_credit
    return typeof reward === 'number' && reward > 0 ? { claimed: reward } : { reason: 'nothing-to-claim' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/no unclaimed|not arrived|already[\s_-]?claim/i.test(message)) return { reason: 'nothing-to-claim' }
    throw error
  }
}

/**
 * 派发一次旅行，并顺手领取已经可领的。
 *
 * 两半绑在一起：先 claim 再 depart，这样「DSH 关着的时候猫猫到站了」也能在下一次
 * 轮询时拿到积分。`locationId = 0` 表示「没偏好」→ 取 `/config` 的第一个；
 * 它**不能**表示「不传目的地」（上游会回 400）。
 */
export async function runGrowthTrip(credential, locationId = 0) {
  const before = await fetchGrowthStatus(credential)
  if (before.state === 'arrived') return { dispatched: false, ...(await claimGrowth(credential, before.recordId)) }
  if (before.dailyLimitReached) return { dispatched: false, reason: 'daily-limit' }
  if (before.state === 'traveling') return { dispatched: false, reason: 'traveling' }
  if (before.state !== 'idle') return { dispatched: false, reason: 'unknown-state' }
  let target = locationId
  if (target === 0) {
    const [first] = await fetchGrowthLocations(credential)
    if (first === undefined) return { dispatched: false, reason: 'no-destination' }
    target = first
  }
  try {
    await growthRequest(credential, '/depart', 'POST', { location_id: target })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/already[\s_-]?traveling/i.test(message) || /already[\s_-]?dispatched/i.test(message)) return { dispatched: false, reason: 'traveling' }
    if (/daily[\s_-]?limit/i.test(message)) return { dispatched: false, reason: 'daily-limit' }
    throw error
  }
  return { dispatched: true }
}

/** 成长中心当前列出的全部任务。空列表照实返回，让调用方能看见「读失败/无报名」。 */
export async function fetchGrowthTasks(credential) {
  const result = await growthSoftRequest(credential, growthUrl(credential, GROWTH_TASKS_PREFIX), 'GET')
  if (!result.ok) {
    throw new Error(`workbuddy upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`)
  }
  const raw = Array.isArray(result.data.tasks) ? result.data.tasks : []
  const tasks = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const code = entry.task_code
    if (typeof code !== 'string' || code === '') continue
    const progress = typeof entry.progress === 'object' && entry.progress !== null ? entry.progress : {}
    const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    tasks.push({
      code,
      title: typeof entry.title === 'string' ? entry.title : code,
      status: typeof entry.accept_status === 'string' ? entry.accept_status : '',
      current: num(progress.current),
      target: num(progress.target),
      rewardCredit: num(entry.reward_credit),
    })
  }
  return tasks
}

/** 接收仍处于 `not_accepted` 的任务（空列表不发：上游对空 `task_codes` 回无用的形状）。 */
export async function acceptGrowthTasks(credential, codes) {
  if (!Array.isArray(codes) || codes.length === 0) return
  const result = await growthSoftRequest(credential, growthUrl(credential, `${GROWTH_TASKS_PREFIX}/accept`), 'POST', { task_codes: [...codes] })
  if (!result.ok) {
    throw new Error(`workbuddy upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`)
  }
}

/** 上报活动事件 —— 这才是推动任务进度的东西。body 必须是**数组**。 */
export async function reportGrowthEvents(credential, events) {
  if (!Array.isArray(events) || events.length === 0) return
  const result = await growthSoftRequest(credential, growthUrl(credential, '/v2/report'), 'POST', [...events])
  if (!result.ok) {
    throw new Error(`workbuddy upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`)
  }
}

/** 领取已完成任务的积分；未完成/已领都是 `ok: false`，属于正常状态。 */
export async function claimGrowthTask(credential, code) {
  const result = await growthSoftRequest(credential, growthUrl(credential, `/activity/growth/tasks/${encodeURIComponent(code)}/claim`), 'POST', {})
  if (!result.ok) return { ok: false, reason: result.msg === '' ? `http ${result.code}` : result.msg }
  const credit = result.data.credit
  return typeof credit === 'number' && credit > 0 ? { ok: true, credit } : { ok: true }
}

/** 连登天数。路径**没有** `/v2` 前缀（`/v2/activity/growth/streak` 会 404）。 */
export async function fetchGrowthStreakDays(credential) {
  const result = await growthSoftRequest(credential, growthUrl(credential, '/activity/growth/streak'), 'GET')
  if (!result.ok) return undefined
  const streak = result.data.streak
  if (typeof streak !== 'object' || streak === null) return undefined
  return typeof streak.days === 'number' ? streak.days : undefined
}

/**
 * 一键：接任务 → 领已完成任务 → 派发旅行 → 领旅行奖励 → 读连登。
 *
 * 返回每一步的结果而不是「成功/失败」：某一步失败不该让整轮无声无息地死掉，
 * 界面要能说清「哪一步没成」。
 */
export async function runGrowthSweep(credential, { day = new Date().toISOString().slice(0, 10) } = {}) {
  const result = { accepted: 0, claimedTasks: 0, claimedCredits: 0, trip: undefined, streakDays: undefined, errors: [] }
  try {
    const tasks = await fetchGrowthTasks(credential)
    const pending = tasks.filter(task => task.status === 'not_accepted').map(task => task.code)
    if (pending.length > 0) {
      await acceptGrowthTasks(credential, pending)
      result.accepted = pending.length
    }
    for (const task of tasks) {
      // 只领「进度已完成」的；未完成领了也只会拿到软失败。
      if (task.target > 0 && task.current < task.target) continue
      try {
        const claimed = await claimGrowthTask(credential, task.code)
        if (claimed.ok === true) {
          result.claimedTasks += 1
          if (typeof claimed.credit === 'number') result.claimedCredits += claimed.credit
        }
      } catch (error) {
        result.errors.push(`task ${task.code}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } catch (error) {
    result.errors.push(`tasks: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    result.trip = await runGrowthTrip(credential)
    if (result.trip?.claimed !== undefined) result.claimedCredits += result.trip.claimed
    else {
      const reward = await fetchGrowthRewardToday(credential, day)
      if (reward !== undefined) result.claimedCredits += reward
    }
  } catch (error) {
    result.errors.push(`trip: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    result.streakDays = await fetchGrowthStreakDays(credential)
  } catch { /* 连登读不到不影响本轮 */ }
  return result
}