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
/** claim 路径两区不同（2026-10-28 实测）：国内版无 `/v2`，国际版有。 */
const CN_TASK_CLAIM_PREFIX = '/activity/growth/tasks'
const GLOBAL_TASK_CLAIM_PREFIX = '/v2/activity/growth/tasks'

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
 * （回到 idle 后它恒报 0）。
 *
 * ⚠️ 不能用 `travel_date` 匹配（2026-10-28 实测纠正）：上游的 `travel_date`
 * 是**该地点首次打卡的日期**，不是本次旅行日期。实测 record_id=2167050 是
 * 当天刚领的旅行，`travel_date` 却写 `"2026-08-22"`，`claimed_at` 才是真时间戳。
 * 所以按 `claimed_at` 落在「指定日（UTC+8）」内来判定。
 *
 * 没有今日已完成的记录时返回 `undefined`，与「确实给了 0」区分开。
 */
export async function fetchGrowthRewardToday(credential, day) {
  const data = await growthRequest(credential, '/records', 'GET')
  const records = Array.isArray(data.records) ? data.records : []
  // day 是 UTC+8 自然日（'YYYY-MM-DD'）；claimed_at 是秒级时间戳。
  const dayStartMs = Date.parse(`${day}T00:00:00+08:00`)
  const dayEndMs = dayStartMs + 24 * 3600 * 1000
  let total
  for (const entry of records) {
    if (typeof entry !== 'object' || entry === null) continue
    if (typeof entry.claimed_at !== 'number' || entry.claimed_at === 0) continue
    const claimedMs = entry.claimed_at * 1e3
    if (!(claimedMs >= dayStartMs && claimedMs < dayEndMs)) continue
    if (typeof entry.reward_credit === 'number') {
      // 同一天可能有多条（先到站未领、后来补领），累加更接近「今天挣了多少」。
      total = (total ?? 0) + entry.reward_credit
    }
  }
  return total
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
  // 国际版**没有猫猫旅行**：`/status` 与 `/config` 实测都返回 `{}`（2026-10-28）。
  // 直接短路，连请求都不发 —— 否则会走到下面的 `unknown-state`，把一条
  // 本不存在的功能记成「失败」，污染 `errors`。
  if (regionOf(credential?.domain) === 'global') return { dispatched: false, reason: 'no-trip-in-region' }
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

/**
 * 成长中心当前列出的全部任务。空列表照实返回，让调用方能看见「读失败/无报名」。
 *
 * ⚠️ **两区 schema 不同**（2026-10-28 实测，见本地报告）：
 *
 * | 内部字段 | 国内版（codebuddy.cn） | 国际版（workbuddy.ai） |
 * | --- | --- | --- |
 * | code | `task_code` | `code` |
 * | status | `accept_status` | `status`（`available` 等**另一套取值**） |
 * | 进度 | `progress:{current,target}` | **无**（等级制，不分进度） |
 * | 金额 | `reward_credit` | **无**（激励在连登阶梯上） |
 *
 * 只读国内版字段会让国际版**整张表被静默过滤成空数组** —— 用户看到「没有成长任务」，
 * 分不清是「本来如此」还是「解析坏了」。所以这里双读，任一命中即收下。
 */
export async function fetchGrowthTasks(credential) {
  const result = await growthSoftRequest(credential, growthUrl(credential, GROWTH_TASKS_PREFIX), 'GET')
  if (!result.ok) {
    throw new Error(`workbuddy upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`)
  }
  const raw = Array.isArray(result.data.tasks) ? result.data.tasks : []
  const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const text = value => (typeof value === 'string' && value !== '' ? value : undefined)
  const tasks = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const code = text(entry.code) ?? text(entry.task_code)
    if (code === undefined) continue
    const progress = typeof entry.progress === 'object' && entry.progress !== null ? entry.progress : {}
    const levelName = text(entry.level_name)
    tasks.push({
      code,
      title: text(entry.title) ?? code,
      status: text(entry.status) ?? text(entry.accept_status) ?? '',
      // 国际版没有 progress：给 0/0，表示「不分进度」而不是「0/0 该跳过」。
      current: num(progress.current),
      target: num(progress.target),
      rewardCredit: num(entry.reward_credit),
      ...(levelName === undefined ? {} : { levelName }),
    })
  }
  return tasks
}

/**
 * 接收仍处于 `not_accepted` 的任务（空列表不发：上游对空 `task_codes` 回无用的形状）。
 *
 * ⚠️ **外层 `code: 0` 不代表任务接上了**（2026-10-28 实测，这是「假装成功」的根源）：
 *
 * | 区 | 请求 | 外层 | `data.results` |
 * | --- | --- | --- | --- |
 * | 国内版 | 已 accepted 的两条再 accept | `200 code:0` | `[{task_code,status:"already_accepted"}, …]` |
 * | 国际版 | `first_chat` / `skill_installed` | `200 code:0` | `[{task_code,status:"error",message:"task not found"}, …]` |
 *
 * 也就是说国际版把「任务不存在」也包在 200 里，旧实现看到 `ok` 就把 `accepted` 记成 5，
 * 界面显示「接收 5 个任务」而实际一个都没接上。所以必须**逐项**读 `data.results`：
 * 带 `error` / `status === 'error'` 的算失败，`accepted` / `already_accepted` 算成功。
 *
 * 返回 `{ requested, accepted, failed, verified }`；`verified: false` 表示上游没给逐项结果，
 * 此时**保守**地把失败数留空（只在真凭实据下判失败），但不影响 `accepted` 的语义。
 */
export async function acceptGrowthTasks(credential, codes) {
  if (!Array.isArray(codes) || codes.length === 0) return { requested: 0, accepted: 0, failed: [], verified: false }
  const result = await growthSoftRequest(credential, growthUrl(credential, `${GROWTH_TASKS_PREFIX}/accept`), 'POST', { task_codes: [...codes] })
  if (!result.ok) {
    throw new Error(`workbuddy upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`)
  }
  const rows = Array.isArray(result.data.results) ? result.data.results : []
  if (rows.length === 0) {
    // 上游没回逐项结果（旧形状/被截断）：无法逐项判失败，按「请求被接受」计，
    // 但把 `verified: false` 传出去，让上层决定要不要在 UI 上标「未校验」。
    return { requested: codes.length, accepted: codes.length, failed: [], verified: false }
  }
  const failed = []
  let accepted = 0
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const code = typeof row.task_code === 'string' ? row.task_code : typeof row.code === 'string' ? row.code : ''
    const message = typeof row.message === 'string' ? row.message : ''
    const status = typeof row.status === 'string' ? row.status : ''
    if (status === 'error' || message !== '' || (typeof row.error === 'string' && row.error !== '')) {
      failed.push({ code, reason: message || (typeof row.error === 'string' ? row.error : '') || status || 'unknown' })
      continue
    }
    accepted += 1
  }
  // 上游只回了部分条目时，剩下的按「未知」处理，不计成功（宁可少报）。
  return { requested: codes.length, accepted, failed, verified: true }
}

/**
 * 上报活动事件。
 *
 * ⚠️⚠️ **实测结论：这个端点不推进任何任务进度**（2026-10-28 三段对照实验）：
 *
 * 1. 无操作对照组等 90s：19 个任务的 `progress.current` 全无变化（排除「上游自己会涨」）；
 * 2. 上报 10 个候选 eventCode（含 `Expert_lighthouse` / `task_complete` 等）后再等 90s：
 *    仍然是全 0，`controlDiff` 与 `reportDiff` 都是空数组；
 * 3. 抓 `growth-center` 的 web 客户端 chunk 后确认：`/v2/report` 属于 UserCenter 的
 *    **analytics 埋点**（`product:"UserCenter"`、`reportDelay:0`、`sendBeacon` 批量 flush），
 *    和成长任务无关；换任意不存在的 eventCode 也回 200 正是「埋点不校验语义」的表现；
 * 4. 成长客户端 chunk（`growthSpace-*.js`）里列的**全部** API 只有 profile / tasks /
 *    tasks/accept / tasks/{code}/claim / badges / streak / lottery / buddy/travel…，
 *    **没有任何写入任务进度的通道**；`tasks/{code}/progress|complete|sync` 等 8 个猜测路径
 *    实测全是 `404 page not found`。
 *
 * 所以任务进度**由服务端按真实客户端行为计算**，协议层不可达。本函数保留仅为向后兼容
 * 与「确实存在有效埋点场景」时的工具性用途，`runGrowthSweep` **不会**调用它 —— 调了只会
 * 白白污染埋点、并让调用方误以为进度被推进了。
 */
export async function reportGrowthEvents(credential, events) {
  if (!Array.isArray(events) || events.length === 0) return
  const result = await growthSoftRequest(credential, growthUrl(credential, '/v2/report'), 'POST', [...events])
  if (!result.ok) {
    throw new Error(`workbuddy upstream ${classifyUpstreamError(200, result.msg)}: ${result.msg.slice(0, 160)}`)
  }
}

/**
 * 任务「到底要做什么」的判定表 —— 全部来自上游 `description` / `task_desc` 实测 dump。
 * 用途：当清扫收尾仍有任务没完成时，把**真实原因**
 * 告诉用户，而不是让界面显示「清扫成功」却一无所获。
 *
 * 右侧一律是「需要真实使用产品」的动作；协议层没有对应写接口（见 reportGrowthEvents 注释）。
 */
const GROWTH_TASK_REQUIREMENTS = [
  ['Expert_lighthouse', '召唤「腾讯轻量云」专家、授权连接器后对话一次（限量名额）'],
  ['wb_wechat_oa_subscribe_task', '关注「腾讯 WorkBuddy」官方公众号并满 24 小时'],
  ['WorkBuddy_Valorant', '在专家页搜索并召唤「无畏契约拼豆专家」并完成一次对话'],
  ['expert_use_maidehao', '召唤「中国电商运营专家」并对话一次'],
  ['expert_use_douyinyin', '召唤「抖音策略师」并对话一次'],
  ['expert_use_shangjia_xuanchuan', '召唤「商家宣传页与海报设计师」并对话一次'],
  ['expert_use_bowangwang', '召唤「直播电商教练」并对话一次'],
  ['expert_5', '召唤 5 位不同的专家并向每位发起对话'],
  ['Expert_team_use_3', '切换「专家团」并使用 3 个不同的专家团队'],
  ['template_5', '「新建任务」时选用 5 个不同的模板并发起对话'],
  ['automation_1', '在「自动化」里设置 1 个定时任务（如每周五生成周报）'],
  ['chat_5', '和 AI 完成累计 5 次对话（真实用产品对话即可，不需要脚本）'],
  ['playbook_prompt', '「灵感」界面选取 1 款案例，点「+ 做同款」并完成 1 次对话'],
  ['Library_read', '在「资料库」里读完《WorkBuddy 资料库介绍》'],
  ['first_buddy', '新建 1 个任务并发起对话'],
  ['skill_1', '安装 1 个技能并在对话中实际使用'],
  ['RichMeow_Chat', '下载桌面端并用它对话一次'],
  ['Hp_Appearance', '客户端 5.5.3+「菜单-外观」启用「和平精英」主题'],
  ['Buddy_App', '点击左上角「发现应用」进入任意 Buddy 应用'],
  // 国际版（等级制）
  ['first_chat', '完成一次对话'],
  ['skill_installed', '安装一个技能'],
  ['wechat_linked', '绑定微信'],
  ['expert_summoned', '召唤一次专家'],
  ['template_used', '使用一次模板'],
]

const FALLBACK_REQUIREMENT = '需要真实使用产品完成（上游未提供可编程的完成通道）'

/** 某个任务需要用户做什么。`task.code` 未收录时给通用兜底文案。 */
export function describeGrowthTaskRequirement(task) {
  const code = typeof task === 'string' ? task : typeof task?.code === 'string' ? task.code : ''
  for (const [key, text] of GROWTH_TASK_REQUIREMENTS) if (key === code) return text
  // `expert_use_*` 之类同族任务用前缀兜底，避免新上架的专家任务直接掉进「未知」。
  if (/^expert_use_/.test(code)) return '在专家页召唤对应专家并发起一次对话'
  return FALLBACK_REQUIREMENT
}

/**
 * 本轮结束后**仍然没完成**的任务清单 —— 这就是「协议层做不到」的那部分。
 *
 * 判定：`status === 'claimed'`、或本轮刚领到、或 `current >= target`（且 target > 0）都算完成；
 * 其余都算未完成，并附上真实原因。**不进入 `errors`** —— 这不是失败，是事实。
 */
function collectUnfinishable(tasks, claimedCodes) {
  const rows = []
  let credits = 0
  for (const task of tasks) {
    if (!task || typeof task.code !== 'string') continue
    if (task.status === 'claimed') continue
    if (claimedCodes.has(task.code)) continue
    const byProgress = typeof task.target === 'number' && task.target > 0 && task.current >= task.target
    const byStatus = GROWTH_DONE_STATUSES.has(task.status)
    if (byProgress || byStatus) continue
    const rewardCredit = typeof task.rewardCredit === 'number' ? task.rewardCredit : 0
    credits += rewardCredit
    rows.push({
      code: task.code,
      title: typeof task.title === 'string' ? task.title : task.code,
      current: typeof task.current === 'number' ? task.current : 0,
      target: typeof task.target === 'number' ? task.target : 0,
      rewardCredit,
      requires: describeGrowthTaskRequirement(task),
    })
  }
  return { rows, credits }
}

/** 领取已完成任务的积分；未完成/已领都是 `ok: false`，属于正常状态。 */
/**
 * 领取已完成任务的积分；未完成/已领都是 `ok: false`，属于正常状态。
 *
 * ⚠️ `credit` 只在**本次真的发放**时非零。实测（2026-10-28）对已领任务再调一次，
 * 上游回 `{"already_claimed":true,"credit":0}` —— 所以不能用 `credit>0` 判断
 * 「这次领到了没有」，那会把「刚领成功但上游没回数额」误判成没领到。
 * 判定依据改为 `already_claimed !== true`。
 *
 * ⚠️ **claim 路径两区不同**（实测）：国内版 `POST /activity/growth/tasks/{code}/claim`，
 * 国际版 `POST /v2/activity/growth/tasks/{code}/claim`。国际版打国内版路径会 404。
 */
export function growthTaskClaimPath(credential, code) {
  const prefix = regionOf(credential?.domain) === 'global' ? GLOBAL_TASK_CLAIM_PREFIX : CN_TASK_CLAIM_PREFIX
  return `${prefix}/${encodeURIComponent(code)}/claim`
}

export async function claimGrowthTask(credential, code) {
  const result = await growthSoftRequest(credential, growthUrl(credential, growthTaskClaimPath(credential, code)), 'POST', {})
  if (!result.ok) return { ok: false, reason: result.msg === '' ? `http ${result.code}` : result.msg }
  if (result.data.already_claimed === true) return { ok: false, reason: 'already-claimed' }
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
 *
 * `day` 是 **UTC+8 自然日**（'YYYY-MM-DD'）。初版用
 * `new Date().toISOString()` 取日 —— 那是 UTC 日，在东八区 00:00–08:00 之间
 * 会比本地日期早一天，导致「今天挣了多少」跨日时算到昨天头上。
 */
export function growthDay(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600e3).toISOString().slice(0, 10)
}

/**
 * 任务能不能现在去领。
 *
 * 国内版靠 `progress` 判定；国际版**没有 progress**（`target === 0`），只能看
 * `status` 词汇表。国际版实测只有 `available`（= 尚未完成，claim 会回
 * `400 task not completed`），所以对它采取「只有明确完成态才发 claim」的保守策略 ——
 * 否则每轮清扫会为 5 个没完成的任务各发一次注定失败的请求。
 */
const GROWTH_DONE_STATUSES = new Set(['completed', 'complete', 'done', 'finished', 'claimable', 'claim_pending'])

export function isGrowthTaskClaimable(task) {
  if (!task || typeof task !== 'object') return false
  if (task.status === 'claimed') return false
  if (typeof task.target === 'number' && task.target > 0) {
    return typeof task.current === 'number' && task.current >= task.target
  }
  // 无普通进度信息（国际版等级制）：只在明确完成态才尝试。
  return GROWTH_DONE_STATUSES.has(task.status)
}

/**
 * 一键：接任务 → 领已完成任务 → 派发旅行 → 领旅行奖励 → 读连登 → **如实交代做不到的**。
 *
 * ⚠️ 关于「推进任务进度」（2026-10-28 实测结论，别再试了）：
 * 任务进度由服务端按真实客户端行为计算，**协议层没有写入口**。
 * `/v2/report` 是 UserCenter analytics 埋点，上报任意 eventCode 都回 200 但进度不动
 * （90s 无操作对照组 vs 90s 上报组，`progress.current` 完全一致）；
 * `tasks/{code}/progress|complete|sync|collect|finish` 等 8 个猜测路径实测全 404。
 * 所以本函数**不调用** `reportGrowthEvents`，改为把未完成的任务装进
 * `unfinishable`（含中文 `requires` 文案与积分合计）交还给 UI —— 让用户知道
 * 「这些要你自己去客户端点一下」，而不是以为清扫成功却什么都没拿到。
 *
 * 返回 `{ region, creditKind, accepted, acceptedFailed, claimedTasks, claimedCredits,
 * trip, streakDays, errors, unfinishable, unfinishableCredits }`。
 * 前四个旧字段（claimedCredits / claimedTasks / errors / streakDays）语义与类型不变。
 */
export async function runGrowthSweep(credential, { day = growthDay() } = {}) {
  const region = regionOf(credential?.domain)
  const result = {
    // 两区语义不同（国内版积分制 / 国际版等级制），调用方要靠 region + creditKind
    // 决定 UI 文案，别把国际版的 0 积分渲染成「+0 积分」。
    region,
    creditKind: region === 'global' ? 'streak-tier' : 'task-credit',
    accepted: 0,
    acceptedFailed: [],
    claimedTasks: 0,
    claimedCredits: 0,
    trip: undefined,
    streakDays: undefined,
    errors: [],
    // ⚠️ 关键字段：本轮**做不到**的任务。协议层没有任何写进度的通道
    // （实测见 reportGrowthEvents 的注释），这些任务只能靠用户真实使用产品完成。
    // 界面必须显示它们，而不是因为 claimedTasks 为 0 就沉默。
    unfinishable: [],
    unfinishableCredits: 0,
  }
  /** 任务快照：收尾时用它算「还剩哪些做不到」 */
  let snapshot = []
  const claimedCodes = new Set()
  try {
    const tasks = await fetchGrowthTasks(credential)
    snapshot = tasks
    const pending = tasks.filter(task => task.status === 'not_accepted').map(task => task.code)
    if (pending.length > 0) {
      // ⚠️ 用**逐项结果**统计，不再 `= pending.length`。
      // 上游对「任务不存在」也回 200 code:0（国际版实测 `status:"error"`+`message:"task not found"`），
      // 无条件赋值会把 5 个都失败的请求报成「接收 5 个任务」——那就是用户说的「假装完成」。
      const acked = await acceptGrowthTasks(credential, pending)
      result.accepted = acked?.accepted ?? 0
      for (const failure of acked?.failed ?? []) {
        result.acceptedFailed.push(`${failure.code || '?'}: ${failure.reason}`)
      }
    }
    for (const task of tasks) {
      // 只领「已完成」的；未完成领了也只会拿到软失败（并白烧一次请求）。
      if (!isGrowthTaskClaimable(task)) continue
      try {
        const claimed = await claimGrowthTask(credential, task.code)
        if (claimed.ok === true) {
          result.claimedTasks += 1
          claimedCodes.add(task.code)
          // 上游不是每次都回 `credit`（实测已领任务回 credit:0）。
          // 金额优先用 claim 返回值，缺失时退回任务条目自己声明的 rewardCredit。
          if (typeof claimed.credit === 'number') result.claimedCredits += claimed.credit
          else if (typeof task.rewardCredit === 'number') result.claimedCredits += task.rewardCredit
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
    else if (region !== 'global') {
      // 国际版没有猫猫旅行，也就没有 `/records` 可读 —— 别去讨一个必然空的接口。
      const reward = await fetchGrowthRewardToday(credential, day)
      if (reward !== undefined) result.claimedCredits += reward
    }
  } catch (error) {
    result.errors.push(`trip: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    result.streakDays = await fetchGrowthStreakDays(credential)
  } catch { /* 连登读不到不影响本轮 */ }
  // 收尾：把「本轮确实推进不了」的任务如实交出去。
  // 注意这里用的是**本轮开始时的快照** —— 不再多打一次任务列表接口，
  // 因为任务进度只由真实产品行为推进（report 实测无效），一轮清扫内不会自己变。
  const unfinishable = collectUnfinishable(snapshot, claimedCodes)
  result.unfinishable = unfinishable.rows
  result.unfinishableCredits = unfinishable.credits
  return result
}