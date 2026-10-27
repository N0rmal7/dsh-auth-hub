/**
 * DSH 账号中心 —— Host 半身。
 *
 * 现在**自己就是账号渠道的宿主**：内置 `vendor/channel-pack/pack.js`（原属
 * `dsh-our-free-model`，13 个渠道的登录 / 账号池 / 积分领取），所以不再需要装
 * 那个插件。WorkBuddy 的双区登录也走内置 pack。
 *
 * v0.4.0 起还多了一层**自己加的签到渠道**（`checkin-channels.js` +
 * `checkin-runner.js`）：内置那 13 个渠道必须逆向登录协议才能加，而「每日签到」
 * 这件事只是一发 HTTP + JSON 判成败，所以它被做成了声明式配置——粘一条 cURL
 * 就能接一个新站点，每天自动签、奖励进同一个积分台账。
 *
 * 路由（都在本插件的 web 服务上，`/plugins/dsh-auth-hub/*`）：
 *   GET  status         内置 channel-pack 是否挂载 + controlKey + 文件路径 + 轮换路由状态
 *   GET  policy         每账号积分上限 + 今日已用积分 + 余额基线
 *   POST policy         写入积分上限（需 controlKey）
 *   POST credit-sample  记录一次余额快照（界面拉完余额后回报）
 *   POST credit-grant   记录一次「领取成功」的积分（签到已由 pack 自己记，这里是补录口）
 *   GET  rotations      轮换组 + 今日各候选用量 + 预览顺序
 *   POST rotations      写入轮换组（需 controlKey），并广播 `llm/adapters-updated`
 *   GET  checkin        签到渠道 + 今日状态 + 模板（密钥只给掩码）
 *   POST checkin        写入签到渠道（需 controlKey）
 *   POST checkin-run    立即签到（需 controlKey；`{ ids?, force? }`）
 *   POST checkin-parse  把一条 cURL 拆成渠道草稿（需 controlKey）
 *
 * 另有内置 channel-pack 自己挂的 `/api/channel-pack`（connection RPC，浏览器侧用）
 * 与 `/api/channel-pack/captcha-carrier`（ZCode 验证码载体页）。
 *
 * 为什么用量口径是**积分**而不是 token：账号渠道按积分扣费，上游的 token-ledger
 * 只记 token。积分消耗用「余额差分」推算，见 `credit-usage.js`（v2：按账号、逐包
 * 差分、签到不冲抵消耗）。
 *
 * 为什么还要轮换路由：`rotation.js` 只是纯逻辑，若没有任何 provider 用上它，
 * 用户存下来的轮换组在 `/model` 里**根本不存在**。`rotation-router.js` 把每个
 * 启用的轮换组注册成 `auth-hub` 这个 provider 的一个模型，于是它出现在模型
 * 选择器里、请求也从这里回退。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CREDIT_USAGE_FILE,
  readCreditUsage,
  recordBalanceSample,
  recordCreditGrant,
  todayAccountUsage,
  usedCreditsToday,
  usedCreditsTodayForAccount,
  utc8Day,
} from './credit-usage.js'
import { mountChannelPack } from './channel-pack.js'
import { normalizeRotations, parseMember, pruneRotationState, rotationOrder } from './rotation.js'
import { ROUTER_PROVIDER, ROUTER_PROVIDER_NAME, createRotationAdapter, previewRoute } from './rotation-router.js'
import { fetchGrowthStatus, fetchGrowthStreakDays, fetchGrowthTasks, fetchGrowthRewardToday, runGrowthSweep } from './workbuddy-growth.js'
import {
  CHECKIN_CHANNELS_FILE,
  CHECKIN_SECRETS_FILE,
  CHECKIN_SETTINGS_FILE,
  CHECKIN_STATE_FILE,
  channelView,
  draftFromTemplate,
  newApiDraft,
  parseCurl,
  parseSiteList,
  pickNewApiUser,
  templateView,
  utc8Clock,
} from './checkin-channels.js'
import { probeNewApiSite, readCheckinStore, runCheckinBatch, writeCheckinStore } from './checkin-runner.js'

export const name = 'auth-hub'
export const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SIBLINGS = path.resolve(HERE, '..')
/** 只有 WorkBuddy 仍是外部插件；账号渠道已内置。 */
const BACKENDS = [
  { id: 'channel-pack', package: 'dsh-our-free-model', label: '渠道账号（外部插件，已内置可不需要）' },
  { id: 'workbuddy', package: 'dsh-workbuddy', label: 'WorkBuddy（国内版 / 国际版）' },
]

export const STATUS_PATH = '/plugins/dsh-auth-hub/status'
export const POLICY_PATH = '/plugins/dsh-auth-hub/policy'
export const SAMPLE_PATH = '/plugins/dsh-auth-hub/credit-sample'
export const GRANT_PATH = '/plugins/dsh-auth-hub/credit-grant'
export const ROTATIONS_PATH = '/plugins/dsh-auth-hub/rotations'
export const GROWTH_PATH = '/plugins/dsh-auth-hub/growth'
export const CHECKIN_PATH = '/plugins/dsh-auth-hub/checkin'
export const CHECKIN_RUN_PATH = '/plugins/dsh-auth-hub/checkin-run'
export const CHECKIN_PARSE_PATH = '/plugins/dsh-auth-hub/checkin-parse'
export const CHECKIN_PROBE_PATH = '/plugins/dsh-auth-hub/checkin-probe'
export const CHECKIN_IMPORT_PATH = '/plugins/dsh-auth-hub/checkin-import'
const CONTROL_KEY_HEADER = 'x-auth-hub-control-key'
const controlKey = randomBytes(24).toString('hex')

/** 内置 channel-pack 的挂载状态（`/status` 与日志都读它）。 */
const channelPackState = { state: 'pending', error: '' }
/** 轮换游标（进程内；重启只是换一个起点，和上游 combos 的取舍一致）。 */
const rotationState = { cursors: {} }
/** 轮换路由的注册状态（`/status` 里显示，出问题时不用翻日志）。 */
export const routerState = { state: 'pending', error: '', provider: ROUTER_PROVIDER }

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
}

function stateDir() {
  return path.join(dshHome(), 'channel-pack')
}

export function policyFile() {
  return path.join(stateDir(), 'usage-policy.json')
}

export function creditUsageFile() {
  return path.join(stateDir(), CREDIT_USAGE_FILE)
}

export function rotationsFile() {
  return path.join(stateDir(), 'rotations.json')
}

/**
 * 积分上限策略（v3）。
 *
 * ```json
 * {
 *   "version": 3,
 *   "accounts":  { "codearts-a05559ed": { "maxCreditsPerDay": 300 } },
 *   "providers": { "qodercn": { "maxCreditsPerDay": 100 } }
 * }
 * ```
 *
 * - `accounts` 是**主口径**：每账号每天最多消耗多少积分，由 pack 的
 *   `getAvailableAccount()` 在候选里逐个剔除。
 * - `providers` 保留兼容：整渠道上限（一些渠道只有一个账号，用渠道级更省事）。
 * - 两者是「且」的关系，任一达到即不再使用该账号 / 渠道。
 */
export function normalizePolicy(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const providers = {}
  const rows = source.providers !== null && typeof source.providers === 'object' ? source.providers : {}
  for (const [id, value] of Object.entries(rows)) {
    if (typeof id !== 'string' || id === '' || value === null || typeof value !== 'object') continue
    const cap = {}
    const credits = Number(value.maxCreditsPerDay)
    if (Number.isFinite(credits) && credits > 0) cap.maxCreditsPerDay = Math.round(credits * 100) / 100
    for (const legacy of ['maxRequestsPerDay', 'maxTokensPerDay']) {
      const n = Number(value[legacy])
      if (Number.isFinite(n) && n > 0) cap[legacy] = Math.trunc(n)
    }
    if (Object.keys(cap).length > 0) providers[id] = cap
  }
  const accounts = {}
  const accountRows = source.accounts !== null && typeof source.accounts === 'object' ? source.accounts : {}
  for (const [accountId, value] of Object.entries(accountRows)) {
    if (typeof accountId !== 'string' || accountId === '' || value === null || typeof value !== 'object') continue
    const credits = Number(value.maxCreditsPerDay)
    if (Number.isFinite(credits) && credits > 0) accounts[accountId] = { maxCreditsPerDay: Math.round(credits * 100) / 100 }
  }
  return { version: 3, accounts, providers }
}

function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonFile(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
  return value
}

function readPolicy() {
  return normalizePolicy(readJsonFile(policyFile(), { version: 3, accounts: {}, providers: {} }))
}

export function readRotations() {
  return normalizeRotations(readJsonFile(rotationsFile(), []))
}

/** 某账号 today 是否已达上限（轮换路由的 `exhausted` 判据）。 */
function accountExhausted(accountId, policy) {
  const limit = policy.accounts?.[accountId]?.maxCreditsPerDay
  if (limit === undefined || !(Number(limit) > 0)) return false
  const usage = readCreditUsage(creditUsageFile())
  return usedCreditsTodayForAccount(usage, accountId) >= Number(limit)
}

/**
 * 今日每个账号的上限与已用量，附余额基线。
 *
 * `accounts` 是扁平数组（界面按渠道分组渲染），`providers` 是渠道汇总（兼容旧界面
 * 与「整渠道上限」那条链路）。账号的上限来自 policy，没设就是 null。
 */
function policyView() {
  const policy = readPolicy()
  const usage = readCreditUsage(creditUsageFile())
  const day = utc8Day()
  const usedByAccount = todayAccountUsage(usage)
  const accounts = []
  for (const account of readAccounts()) {
    const limit = policy.accounts?.[account.id]?.maxCreditsPerDay ?? null
    const used = usedByAccount[account.id]?.used ?? usedCreditsTodayForAccount(usage, account.id)
    accounts.push({
      accountId: account.id,
      provider: account.provider,
      nickname: account.nickname ?? '',
      enabled: account.enabled !== false,
      cap: limit,
      used,
      samples: usedByAccount[account.id]?.samples ?? 0,
      exhausted: limit !== null && Number(limit) > 0 && used >= Number(limit),
    })
  }
  // 台账里有、账号池里已经没有的账号（被删了）也列出来，否则数字对不上。
  for (const [accountId, row] of Object.entries(usedByAccount)) {
    if (accounts.some(account => account.accountId === accountId)) continue
    accounts.push({
      accountId,
      provider: row.provider,
      nickname: '',
      enabled: false,
      cap: policy.accounts?.[accountId]?.maxCreditsPerDay ?? null,
      used: row.used,
      samples: row.samples,
      exhausted: false,
    })
  }
  const providers = {}
  for (const id of new Set([
    ...Object.keys(policy.providers ?? {}),
    ...Object.keys(usage.days?.[day]?.providers ?? {}),
    ...accounts.map(account => account.provider),
  ])) {
    providers[id] = {
      cap: policy.providers?.[id]?.maxCreditsPerDay ?? null,
      used: usedCreditsToday(usage, id),
      samples: usage.days?.[day]?.providers?.[id]?.samples ?? 0,
    }
  }
  return {
    day,
    accounts,
    providers,
    policy,
    baseline: usage.baseline,
    grantsToday: grantsToday(usage, day),
    // 签到渠道的奖励也走同一个 grants 台账，所以这里要单独列出来：用户看到
    // 「今日领取」这个数字时，才知道它包含了哪些来源（内置签到 + 自己加的渠道）。
    grants: grantsTodayDetail(usage, day),
  }
}

function grantsToday(usage, day) {
  const start = Date.parse(`${day}T00:00:00+08:00`)
  const rows = (usage.grants ?? []).filter(row => row.at >= start)
  return rows.reduce((sum, row) => sum + row.amount, 0)
}

/** 今日领取流水（按渠道汇总），给「积分上限」页显示「这些数字是怎么来的」。 */
function grantsTodayDetail(usage, day) {
  const start = Date.parse(`${day}T00:00:00+08:00`)
  const rows = (usage.grants ?? []).filter(row => row.at >= start)
  const byProvider = new Map()
  for (const row of rows) {
    const key = row.provider === '' ? '(unknown)' : row.provider
    const row2 = byProvider.get(key) ?? { provider: key, amount: 0, count: 0 }
    row2.amount = Math.round((row2.amount + row.amount) * 100) / 100
    row2.count += 1
    byProvider.set(key, row2)
  }
  return [...byProvider.values()].sort((a, b) => b.amount - a.amount)
}

/** 账号池（`state.json`）里的账号：登录态、昵称、启停。 */
function readAccounts() {
  const state = readJsonFile(path.join(stateDir(), 'state.json'), { accounts: [] })
  const rows = Array.isArray(state?.accounts) ? state.accounts : []
  return rows
    .filter(row => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '')
    .map(row => ({
      id: row.id,
      provider: typeof row.provider === 'string' ? row.provider : '',
      nickname: typeof row.nickname === 'string' ? row.nickname : '',
      enabled: row.enabled !== false,
    }))
}

/**
 * 轮换组 + 每个成员的今日用量 + **预览顺序**。
 *
 * `order` 是预览（`peek: true`，不推进游标）——GET 不应该改变路由行为。
 * `routable` 说的是这个组会不会出现在 `/model` 里：停用的组不会。
 */
function rotationsView() {
  const groups = readRotations()
  const usage = readCreditUsage(creditUsageFile())
  const policy = readPolicy()
  const rows = groups.map(group => {
    const preview = previewRoute(group, rotationState, {
      usageOf: member => usedCreditsToday(usage, parseMember(member)?.provider ?? ''),
      exhausted: member => memberExhausted(member, policy),
    })
    return {
      ...group,
      routable: group.enabled !== false,
      order: preview.filter(row => row.usable).map(row => row.member),
      members_: preview.map(row => {
        const used = usedCreditsToday(usage, row.provider)
        const cap = policy.providers?.[row.provider]?.maxCreditsPerDay ?? null
        return {
          id: row.member,
          provider: row.provider,
          model: row.model,
          used,
          cap,
          exhausted: row.usable !== true,
        }
      }),
    }
  })
  pruneRotationState(rotationState, groups)
  return { day: utc8Day(), provider: ROUTER_PROVIDER, providerName: ROUTER_PROVIDER_NAME, groups: rows }
}

/**
 * 成员「今天还能不能用」。
 *
 * 三件事同时判：成员指向自己（会递归）、该渠道整渠道超限、成员所在渠道下
 * **每个账号**都超限。渠道下只要还有账号没超限就算可用——真正的账号级剔除
 * 由 pack 的 `getAvailableAccount()` 完成。
 */
function memberExhausted(member, policy = readPolicy()) {
  const parsed = parseMember(member)
  if (parsed === undefined || parsed.provider === ROUTER_PROVIDER) return true
  const providerCap = policy.providers?.[parsed.provider]?.maxCreditsPerDay
  if (providerCap !== undefined && Number(providerCap) > 0) {
    const usage = readCreditUsage(creditUsageFile())
    if (usedCreditsToday(usage, parsed.provider) >= Number(providerCap)) return true
  }
  const accounts = readAccounts().filter(account => account.provider === parsed.provider && account.enabled !== false)
  if (accounts.length === 0) return false
  return accounts.every(account => accountExhausted(account.id, policy))
}

/**
 * 签到渠道视图。
 *
 * 只给**掩码**：`headers` 里的 Cookie / Authorization 是登录态，`/checkin` 的
 * 响应会进浏览器内存与 DevTools，回显原文等于把它交给每一个能开这个页面的人。
 * 界面按 `headerHints` 显示「已配置 Cookie: abc…xyz」，保存时只提交用户**改过**
 * 的头（`undefined` = 保持原值，`''` = 删除）。
 */
function checkinView() {
  const store = readCheckinStore(stateDir())
  return {
    day: utc8Day(),
    clock: utc8Clock(),
    settings: store.settings,
    templates: templateView(),
    channels: store.channels.map(channel => channelView(channel, store.secrets[channel.id], store.state[channel.id])),
    files: {
      channels: path.join(stateDir(), CHECKIN_CHANNELS_FILE),
      secrets: path.join(stateDir(), CHECKIN_SECRETS_FILE),
      state: path.join(stateDir(), CHECKIN_STATE_FILE),
      settings: path.join(stateDir(), CHECKIN_SETTINGS_FILE),
    },
  }
}

/**
 * 把界面提交的渠道合并进现有配置。
 *
 * 密钥的处理是这个函数唯一有坑的地方，而且**不能靠「空串」表达两种意思**：
 * 界面拿不到原文（Host 只回掩码），所以「没改动」和「要删除」必须用两种形状区分：
 *
 *   - `headers[name]` 是**非空字符串** → 覆盖成这个新值；
 *   - `headers` 里**没有这个键**           → 保持原值（用户压根没碰）；
 *   - 名字出现在 `removeHeaders[]` 里      → 删除。
 *
 * 早先版本用「空串 = 保持」，结果用户真的想清掉一个头时永远清不掉；反过来用
 * 「空串 = 删除」，改个 Referer 就会把 Cookie 一起洗掉、第二天全挂。两种都试过，
 * 显式的 `removeHeaders` 才没有歧义。
 */
function mergeCheckinChannels(incoming) {
  const store = readCheckinStore(stateDir())
  const rows = []
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (raw === null || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const old = store.secrets[id] ?? {}
    const headers = { ...old }
    const incomingHeaders = raw.headers !== null && typeof raw.headers === 'object' ? raw.headers : {}
    for (const [name, value] of Object.entries(incomingHeaders)) {
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (trimmed !== '') headers[name] = trimmed
    }
    for (const name of Array.isArray(raw.removeHeaders) ? raw.removeHeaders : []) {
      if (typeof name === 'string') delete headers[name]
    }
    rows.push({ ...raw, headers })
  }
  const written = writeCheckinStore(stateDir(), {
    channels: rows,
    secrets: Object.fromEntries(rows.map(row => [row.id, row.headers ?? {}])),
  })
  // 渠道被删掉时，它的签到状态也要一起清 —— 否则同名渠道重建后会「继承」上一次
  // 的 lastDay，导致今天永远不再自动签。
  pruneCheckinState(written.channels)
  return written
}

/** 状态文件剪枝：只保留仍然存在的渠道。 */
function pruneCheckinState(channels) {
  const file = path.join(stateDir(), CHECKIN_STATE_FILE)
  const raw = readJsonFile(file, { channels: {} })
  const rows = raw !== null && typeof raw === 'object' && raw.channels !== null && typeof raw.channels === 'object' ? raw.channels : {}
  const live = new Set((Array.isArray(channels) ? channels : []).map(channel => channel.id))
  const next = {}
  for (const [id, value] of Object.entries(rows)) if (live.has(id)) next[id] = value
  if (Object.keys(next).length !== Object.keys(rows).length) writeJsonFile(file, { version: 1, channels: next })
  return next
}

function diagnostics() {
  const store = readCheckinStore(stateDir())
  return {
    plugin: 'dsh-auth-hub',
    controlKey,
    channelPack: { ...channelPackState },
    router: { ...routerState },
    checkin: {
      channels: store.channels.length,
      enabled: store.channels.filter(channel => channel.enabled !== false).length,
      auto: store.settings.auto,
      at: store.settings.at,
      dueNow: store.channels.filter(channel => channel.enabled !== false && store.state[channel.id]?.lastDay !== utc8Day()).length,
    },
    policyFile: policyFile(),
    creditUsageFile: creditUsageFile(),
    rotationsFile: rotationsFile(),
    checkinFile: path.join(stateDir(), CHECKIN_CHANNELS_FILE),
    backends: BACKENDS.map(backend => ({
      id: backend.id,
      label: backend.label,
      installed: existsSync(path.join(SIBLINGS, backend.package, 'package.json')),
    })),
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readJson(req, limit = 256 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function keyMatches(presented) {
  if (typeof presented !== 'string' || presented.length !== controlKey.length) return false
  try {
    return timingSafeEqual(Buffer.from(controlKey), Buffer.from(presented))
  } catch {
    return false
  }
}

/**
 * 给成长中心用的凭据：`{ accessToken, domain }`。
 *
 * 内置 channel-pack 把 WorkBuddy/CodeBuddy 的凭据写在 `channel-pack/state.json` 的
 * `credentialRef` 指向的条目里（实际值在 `$DSH_HOME/.credentials.yaml`）。Host 半身
 * 拿不到 `credentials` 服务（那要 inject），所以这里直接从 credentials 文件读——
 * **只读、不写、不复制**，且只取 `access_token` 与 `domain` 两个字段。
 *
 * 找不到时返回 undefined，界面据此显示「未登录」。
 */
async function resolveGrowthCredential(provider) {
  // 向后兼容：单账号形态（只返回凭据本体）。多账号请用 resolveGrowthAccounts()。
  const first = resolveGrowthAccounts(provider)[0]
  return first?.credential
}

/**
 * 定位某个 credentialRef 在 `.credentials.yaml` 里的凭据块，解析成
 * `{ accessToken, domain }`。解析不出来返回 undefined。
 */
function parseGrowthCredentialRef(ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  const raw = readCredentialsFile()
  const block = new RegExp(`${ref}\\s*:\\s*'([\\s\\S]*?)'(?=\\s*\\n|$)`).exec(raw) ?? new RegExp(`${ref}\\s*:\\s*"([\\s\\S]*?)"(?=\\s*\\n|$)`).exec(raw)
  if (block === null) return undefined
  const text = block[1]
  const pick = key => {
    const found = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text)
    return found === null ? undefined : found[1]
  }
  const accessToken = pick('access_token') ?? pick('accessToken')
  if (typeof accessToken !== 'string' || accessToken === '') return undefined
  return { accessToken, domain: pick('domain') ?? pick('api_domain') ?? '' }
}

/**
 * **该 provider 下所有启用账号**的成长凭据（按 `state.json` 顺序）。
 *
 * 为什么必须遍历而不是 `.find()`：一个渠道下常有多个账号（实测本机 `buddy` 与
 * `workbuddy` 各 2 个启用账号），原先的 `.find()` 只清扫了**第一个**，其余账号
 * 的每日任务/旅行奖励永远不会被领——而这些都是「送钱」操作，漏一个就是净损失。
 *
 * @returns {Array<{ accountId: string, nickname: string, ref: string, credential: { accessToken: string, domain: string } }>}
 *   只包含**凭据可解析**的账号；解析失败的账号会被跳过（记进 skipped 由调用方决定是否提示）。
 */
export function resolveGrowthAccounts(provider, options = {}) {
  const state = readJsonFile(path.join(stateDir(), 'state.json'), { accounts: [] })
  const accounts = Array.isArray(state?.accounts) ? state.accounts : []
  const wanted = options.ids === undefined ? undefined : new Set(options.ids)
  const out = []
  for (const account of accounts) {
    if (account === null || typeof account !== 'object') continue
    if (account.provider !== provider) continue
    if (account.enabled === false) continue
    if (typeof account.id !== 'string' || account.id === '') continue
    if (wanted !== undefined && !wanted.has(account.id)) continue
    const ref = typeof account.credentialRef === 'string' ? account.credentialRef : ''
    const credential = parseGrowthCredentialRef(ref)
    if (credential === undefined) continue
    out.push({
      accountId: account.id,
      nickname: typeof account.nickname === 'string' ? account.nickname : '',
      ref,
      credential,
    })
  }
  return out
}

/**
 * 逐个清扫某 provider 下**全部启用账号**，每个账号独立 try/catch。
 *
 * 失败隔离：一个账号的 401 / 网络错误不影响其它账号；每个账号的错误各自收集到
 * 自己的 `error` 里，整体仍返回 200（UI 要展示「谁成功、谁失败、为什么」）。
 *
 * @param {(credential: object, options: { day: string }) => Promise<object>} deps.sweep
 *   实际清扫函数（默认 `runGrowthSweep`，测试可 mock）。
 * @param {(provider: string, accountId: string, amount: number) => void} [deps.recordGrant]
 *   台账写入钩子（默认写 `creditUsageFile()`），每个账号**各自**记一条。
 * @returns {Promise<{ provider: string, accounts: Array<{accountId, nickname, result?, error?}>, totals: object }>}
 */
export async function runGrowthSweepForProvider(deps) {
  const provider = deps.provider
  const day = deps.day ?? utc8Day()
  const sweep = deps.sweep ?? runGrowthSweep
  const recordGrant = deps.recordGrant
  const accounts = resolveGrowthAccounts(provider)
  const rows = []
  const totals = { accounts: accounts.length, swept: 0, failed: 0, claimedTasks: 0, claimedCredits: 0, streakDays: undefined, unfinishableCount: 0, unfinishableCredits: 0 }

  for (const account of accounts) {
    try {
      const result = await sweep(account.credential, { day })
      const credits = Number(result?.claimedCredits) > 0 ? Number(result.claimedCredits) : 0
      // 台账：**按真实 accountId** 记，不再是空串。
      // 原先传 `''` 会让 `grantedSince()` 退化成「按 provider 匹配」，
      // 多账号时会把 A 账号的奖励算到 B 账号头上（credit-usage.js:245-246）。
      if (credits > 0) recordGrant?.(provider, account.accountId, credits, Date.now())
      totals.swept += 1
      totals.claimedTasks += Number(result?.claimedTasks) > 0 ? Number(result.claimedTasks) : 0
      totals.claimedCredits += credits
      // 成长任务绝大多数必须真实使用产品（参数见 workbuddy-growth.js 的
      // unfinishable 注释）。把它汇总上去，UI 才能如实告诉用户「不是没跑，
      // 是这些任务协议层做不到」—— 否则用户只看到「0 个任务」。
      if (Array.isArray(result?.unfinishable)) totals.unfinishableCount += result.unfinishable.length
      totals.unfinishableCredits += Number(result?.unfinishableCredits) > 0 ? Number(result.unfinishableCredits) : 0
      if (typeof result?.streakDays === 'number') {
        totals.streakDays = Math.max(totals.streakDays ?? 0, result.streakDays)
      }
      rows.push({ accountId: account.accountId, nickname: account.nickname, result })
      deps.info?.(`auth-hub: ${provider}/${account.nickname || account.accountId} 成长清扫 任务+${result?.claimedTasks ?? 0} 积分+${credits}${Number(result?.unfinishableCredits) > 0 ? `（另有 ${result.unfinishable?.length ?? 0} 个任务需真实使用产品，+${result.unfinishableCredits} 积分）` : ''}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      totals.failed += 1
      rows.push({ accountId: account.accountId, nickname: account.nickname, error: message })
      deps.warn?.(`auth-hub: ${provider}/${account.nickname || account.accountId} 成长清扫失败：${message}`)
    }
  }
  return { provider, day, accounts: rows, totals }
}

/** `$DSH_HOME/channel-pack/growth-settings.json`：成长清扫的自动化配置。 */
export function growthSettingsFile() {
  return path.join(stateDir(), 'growth-settings.json')
}

/** `$DSH_HOME/channel-pack/growth-auto-state.json`：幂等判据（lastDay / attempts）。 */
export function growthAutoStateFile() {
  return path.join(stateDir(), 'growth-auto-state.json')
}

/**
 * 自动成长清扫设置。
 *
 * ```json
 * { "auto": true, "providers": ["workbuddy", "buddy"], "maxAttemptsPerDay": 2, "retryMinutes": 20 }
 * ```
 *
 * 默认 `auto: false`（不替用户做决定）；`DSH_GROWTH_AUTO=1` 可强制开启，便于验证。
 */
export function readGrowthSettings(env = process.env) {
  const raw = readJsonFile(growthSettingsFile(), {})
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const forced = String(env.DSH_GROWTH_AUTO ?? '') === '1'
  const providers = Array.isArray(source.providers)
    ? source.providers.filter(p => typeof p === 'string' && p !== '')
    : ['workbuddy', 'buddy']
  const attempts = Number(source.maxAttemptsPerDay)
  const retry = Number(source.retryMinutes)
  return {
    auto: forced || source.auto === true,
    providers: providers.length > 0 ? providers : ['workbuddy', 'buddy'],
    maxAttemptsPerDay: Number.isFinite(attempts) && attempts > 0 ? Math.min(Math.trunc(attempts), 10) : 2,
    retryMinutes: Number.isFinite(retry) && retry >= 0 ? Math.min(Math.trunc(retry), 360) : 20,
  }
}

export function readGrowthAutoState() {
  const raw = readJsonFile(growthAutoStateFile(), { version: 1, providers: {} })
  const providers = raw !== null && typeof raw === 'object' && raw.providers !== null && typeof raw.providers === 'object' ? raw.providers : {}
  return { version: 1, providers }
}

export function writeGrowthAutoState(next) {
  try {
    writeJsonFile(growthAutoStateFile(), next)
    return next
  } catch {
    return next
  }
}

/** `$DSH_HOME/.credentials.yaml`（不存在时返回空串，调用方按「未登录」处理）。 */
function readCredentialsFile() {
  const file = path.join(dshHome(), '.credentials.yaml')
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function apply(ctx) {
  const logger = ctx.logger ?? console
  const info = message => logger.info?.(message)
  const warn = message => logger.warn?.(message)

  // 内置 channel-pack：它自己要 credentials / commands / llm，缺一个就只少这一块。
  ctx.inject(['credentials', 'commands', 'llm'], scoped => {
    let stopped = false
    scoped.effect(() => () => { stopped = true }, 'auth-hub: channel pack')
    void mountChannelPack(scoped, { info, warn }).then(result => {
      if (stopped) return
      channelPackState.state = result.ok ? 'ready' : 'failed'
      channelPackState.error = result.ok ? '' : String(result.error ?? '').slice(0, 300)
    })
  })

  // 轮换路由：把每个启用的轮换组注册成 `auth-hub` 这个 provider 的一个模型。
  //
  // 这一步是「我在 /model 里找不到自己创建的轮换模型」的修复点：在这之前
  // rotation.js 只被单测调用，没有任何 provider 用它，所以组存了也不会出现在目录里。
  ctx.inject(['llm'], scoped => {
    scoped.effect(() => {
      const adapter = createRotationAdapter({
        llm: scoped.llm,
        groups: () => readRotations(),
        state: rotationState,
        exhausted: member => memberExhausted(member),
        warn,
      })
      let handle
      try {
        handle = scoped.llm.registerAdapter([ROUTER_PROVIDER], adapter)
        routerState.state = 'ready'
        routerState.error = ''
        info(`auth-hub: 轮换路由已注册（provider "${ROUTER_PROVIDER}"，模型 = 每个启用的轮换组）`)
      } catch (error) {
        routerState.state = 'failed'
        routerState.error = error instanceof Error ? error.message : String(error)
        warn(`auth-hub: 轮换路由注册失败：${routerState.error}`)
        return () => {}
      }
      return () => {
        routerState.state = 'disposed'
        try { handle() } catch { /* fiber 已释放 */ }
      }
    }, 'auth-hub: rotation router')
  })

  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => {
      const disposers = [
        scoped.webServer.register({
          kind: 'exact',
          path: STATUS_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
            send(res, 200, diagnostics())
          },
        }),
        scoped.webServer.register({
          kind: 'exact',
          path: POLICY_PATH,
          handler: async (req, res) => {
            if (req.method === 'GET') return send(res, 200, { ...policyView(), policyFile: policyFile(), creditUsageFile: creditUsageFile() })
            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
            if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
            const body = await readJson(req)
            if (body === undefined) return send(res, 400, { error: 'body is not JSON' })
            try {
              const next = writeJsonFile(policyFile(), normalizePolicy(body))
              info(`auth-hub: 已写入积分上限（${Object.keys(next.accounts).length} 个账号 / ${Object.keys(next.providers).length} 个渠道）`)
              send(res, 200, { ok: true, ...policyView(), policyFile: policyFile(), creditUsageFile: creditUsageFile() })
            } catch (error) {
              send(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
        scoped.webServer.register({
          kind: 'exact',
          path: SAMPLE_PATH,
          handler: async (req, res) => {
            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
            if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
            const body = await readJson(req)
            const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
            if (provider === '' || !Array.isArray(body?.rows)) return send(res, 400, { error: 'provider and rows are required' })
            try {
              const result = recordBalanceSample(creditUsageFile(), provider, body.rows)
              if (Object.keys(result.deltas).length > 0) {
                info(`auth-hub: 记录 ${provider} 今日已用积分 ${result.deltas[provider]}（${Object.keys(result.accountDeltas).length} 个账号）`)
              }
              send(res, 200, { ok: true, deltas: result.deltas, accountDeltas: result.accountDeltas, ...policyView() })
            } catch (error) {
              send(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
        scoped.webServer.register({
          kind: 'exact',
          path: GRANT_PATH,
          handler: async (req, res) => {
            // 补录口：签到由 pack 的 `recordCreditGrants` 自己记，这里给界面（或
            // 以后别的来源）一个显式入口，也让「排除签到变化」这条口径可测。
            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
            if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
            const body = await readJson(req)
            const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
            const amount = Number(body?.amount)
            if (provider === '' || !Number.isFinite(amount) || amount <= 0) return send(res, 400, { error: 'provider and a positive amount are required' })
            try {
              recordCreditGrant(creditUsageFile(), provider, typeof body?.accountId === 'string' ? body.accountId : '', amount)
              send(res, 200, { ok: true, ...policyView() })
            } catch (error) {
              send(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
        scoped.webServer.register({
          kind: 'exact',
          path: ROTATIONS_PATH,
          handler: async (req, res) => {
            if (req.method === 'GET') return send(res, 200, rotationsView())
            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
            if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
            const body = await readJson(req)
            if (body === undefined) return send(res, 400, { error: 'body is not JSON' })
            try {
              const groups = normalizeRotations(body?.rotations)
              writeJsonFile(rotationsFile(), groups)
              pruneRotationState(rotationState, groups)
              // 目录是动态读的，但模型选择器只在下一次刷新时重读 —— 广播一次，
              // 用户存完组马上就能在 /model 里看到它（否则要等重连）。
              try { ctx.emit('llm/adapters-updated') } catch { /* 老宿主没有这个事件 */ }
              info(`auth-hub: 已写入 ${groups.length} 个轮换组（provider "${ROUTER_PROVIDER}" 的模型目录已更新）`)
              send(res, 200, { ok: true, ...rotationsView() })
            } catch (error) {
              send(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
        scoped.webServer.register({
          kind: 'exact',
          path: GROWTH_PATH,
          handler: async (req, res) => {
            // 成长中心：`GET ?provider=workbuddy|buddy` 读状态；`POST` 跑一轮清扫。
            //
            // 凭据从 `state.json` 的 credentialRef 定位到 `.credentials.yaml` 里的条目，
            // 所以这里不额外存一份 token。
            //
            // ⚠️ v0.5.3 起 **POST 会遍历该 provider 下全部启用账号**（原先只扫第一个）。
            // 返回结构对齐多账号：`{ accounts: [...], totals: {...}, result }`。
            // `result` 保留为「第一个账号的原始结果」，让只读 `payload.result` 的旧
            // 客户端在单账号场景下行为不变（向后兼容）。
            const provider = String(req.method === 'GET' ? (new URL(req.url ?? '/', 'http://x').searchParams.get('provider') ?? 'workbuddy') : '')
            try {
              if (req.method === 'GET') {
                const accounts = resolveGrowthAccounts(provider)
                if (accounts.length === 0) return send(res, 200, { provider, signedIn: false })
                const first = accounts[0]
                const [status, tasks, streakDays, rewardToday] = await Promise.all([
                  fetchGrowthStatus(first.credential).catch(() => undefined),
                  fetchGrowthTasks(first.credential).catch(() => undefined),
                  fetchGrowthStreakDays(first.credential).catch(() => undefined),
                  fetchGrowthRewardToday(first.credential, utc8Day()).catch(() => undefined),
                ])
                return send(res, 200, {
                  provider,
                  signedIn: true,
                  status,
                  tasks,
                  streakDays,
                  rewardToday,
                  // 多账号提示：UI 用它显示「共 N 个账号，当前展示第一个」
                  accountId: first.accountId,
                  nickname: first.nickname,
                  accountCount: accounts.length,
                })
              }
              if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
              if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
              const body = await readJson(req)
              const target = typeof body?.provider === 'string' ? body.provider : 'workbuddy'
              // `ids` 可选：只清扫指定账号（UI 单账号重试 / 自动化定点补跑）。
              const ids = Array.isArray(body?.ids) ? body.ids.filter(id => typeof id === 'string') : undefined
              const accounts = resolveGrowthAccounts(target, { ids })
              if (accounts.length === 0) return send(res, 400, { error: `no signed-in account for ${target}` })
              const sweepResult = await runGrowthSweepForProvider({
                provider: target,
                day: utc8Day(),
                ids,
                // 台账：每个账号**各自**记一条，accountId 用真实 id。
                recordGrant: (p, accountId, amount, at) => recordCreditGrant(creditUsageFile(), p, accountId, amount, at),
                info,
                warn,
              })
              const firstOk = sweepResult.accounts.find(row => row.result !== undefined)
              info(`auth-hub: ${target} 成长清扫 ${sweepResult.totals.swept}/${sweepResult.totals.accounts} 个账号成功，任务+${sweepResult.totals.claimedTasks} 积分+${sweepResult.totals.claimedCredits}`)
              send(res, 200, {
                ok: true,
                provider: target,
                ...sweepResult,
                // 向后兼容：单账号（且成功）时 `result` 就是那一份原始结果。
                result: firstOk?.result,
              })
            } catch (error) {
              send(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
        scoped.webServer.register({
          kind: 'exact',
          path: CHECKIN_PATH,
          handler: async (req, res) => {
            // 签到渠道：`GET` 读全量（密钥只给掩码），`POST` 写全量。
            if (req.method === 'GET') return send(res, 200, checkinView())
            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
            if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
            const body = await readJson(req)
            if (body === undefined) return send(res, 400, { error: 'body is not JSON' })
            try {
              const written = mergeCheckinChannels(body?.channels)
              if (body?.settings !== undefined) {
                writeCheckinStore(stateDir(), { channels: written.channels, secrets: written.secrets, settings: body.settings })
              }
              if (written.problems.length > 0) {
                warn(`auth-hub: 签到渠道有 ${written.problems.length} 条被丢弃：${written.problems.join('；')}`)
              }
              info(`auth-hub: 已保存 ${written.channels.length} 个签到渠道`)
              send(res, 200, { ok: true, problems: written.problems, ...checkinView() })
            } catch (error) {
              send(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
        scoped.webServer.register({
          kind: 'exact',
          path: CHECKIN_RUN_PATH,
          handler: async (req, res) => {
            // 立即签到：`{ ids?: string[], force?: boolean }`。
            //
            // `force` 让手动执行无视「今天已签」——用户刚换了 Cookie 时想看新配置
            // 是不是通的，这时候跳过反而是坏体验。
            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
            if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
            const body = await readJson(req)
            try {
              const ids = Array.isArray(body?.ids) ? body.ids.filter(id => typeof id === 'string') : undefined
              const result = await runCheckinBatch({
                dir: stateDir(),
                ids,
                force: body?.force === true,
                recordGrant: (provider, accountId, amount, at) => recordCreditGrant(creditUsageFile(), provider, accountId, amount, at),
                info,
                warn,
              })
              send(res, 200, { ok: true, ...result, ...checkinView() })
            } catch (error) {
              send(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
        scoped.webServer.register({
          kind: 'exact',
          path: CHECKIN_PARSE_PATH,
          handler: async (req, res) => {
            // 「粘贴一条 cURL」→ 草稿。手抄 Cookie 与 body 太容易错，而浏览器
            // 右键「Copy as cURL」是一键的；这一步把那份文本拆成表单字段。
            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
            if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
            const body = await readJson(req)
            if (typeof body?.curl !== 'string') return send(res, 400, { error: 'curl is required' })
            const parsed = parseCurl(body.curl)
            if (parsed.draft === undefined) return send(res, 400, { error: parsed.problem ?? 'cURL 无法解析' })
            const taken = new Set(readCheckinStore(stateDir()).channels.map(channel => channel.id))
            // 顺手把 cURL 里的 New-Api-User 摘出来：用户手抄到表单里最容易漏的就是
            // 这个头，而漏了它每个接口都 401、报错还完全不提。
            const userId = pickNewApiUser(parsed.draft.headers)
            if (userId !== '') {
              const match = /^(https?:\/\/[^/]+)/i.exec(parsed.draft.url ?? '')
              const generated = match === null ? undefined : newApiDraft(match[1], { userId, takenIds: taken })
              if (generated !== undefined) {
                // 只借用生成的判定规则与奖励路径，URL/方法/body 仍用 cURL 里的真值。
                return send(res, 200, {
                  ok: true,
                  draft: {
                    ...generated,
                    ...parsed.draft,
                    id: generated.id,
                    label: generated.label,
                    siteOrigin: generated.siteOrigin,
                    template: 'newapi',
                    success: generated.success,
                    already: generated.already,
                    reward: generated.reward,
                    rewardUnit: generated.rewardUnit,
                    note: '',
                  },
                  detected: 'newapi',
                  templates: templateView(),
                })
              }
            }
            const slug = parsed.draft.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
            const draft = { ...draftFromTemplate('cookie-get', taken), ...parsed.draft, id: slug === '' ? 'checkin' : slug }
            send(res, 200, { ok: true, draft, templates: templateView() })
          },
        }),
        scoped.webServer.register({
          kind: 'exact',
          path: CHECKIN_PROBE_PATH,
          handler: async (req, res) => {
            // 「一键识别中转站」：给个域名，探出它是哪家的、签到端点在哪、规则怎么写。
            //
            // ⚠️ 这一步**可能真的把今天的签到用掉**（New API 的成功/已签只能由签到
            // 接口本身给出）。所以界面上必须写明这一句，不能偷偷跑。
            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
            if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
            const body = await readJson(req)
            if (typeof body?.origin !== 'string' || body.origin.trim() === '') return send(res, 400, { error: 'origin is required' })
            try {
              const probe = await probeNewApiSite(body.origin.trim(), {
                cookie: typeof body?.cookie === 'string' ? body.cookie : '',
                userId: typeof body?.userId === 'string' ? body.userId : '',
              })
              const taken = new Set(readCheckinStore(stateDir()).channels.map(channel => channel.id))
              const draft = probe.isNewApi
                ? newApiDraft(probe.origin, {
                  userId: typeof body?.userId === 'string' ? body.userId : '',
                  cookie: typeof body?.cookie === 'string' ? body.cookie : '',
                  takenIds: taken,
                  ...(probe.signPath === undefined ? {} : { signPath: probe.signPath }),
                })
                : undefined
              if (probe.isNewApi) info(`auth-hub: 识别到 New API 站点 ${probe.origin}（${probe.message}）`)
              send(res, 200, {
                ok: true,
                probe,
                ...(draft === undefined ? {} : { draft }),
                templates: templateView(),
              })
            } catch (error) {
              send(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
        scoped.webServer.register({
          kind: 'exact',
          path: CHECKIN_IMPORT_PATH,
          handler: async (req, res) => {
            // 批量加中转站：一行一个域名，共用一份 Cookie / 用户 ID，返回草稿数组。
            //
            // 这里**不写盘**：导出的草稿交给界面，用户看过、改过、确认后才走 POST
            // /checkin 保存。批量导入最怕的就是「一按就把 20 个没验证的渠道写进去」。
            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
            if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
            const body = await readJson(req)
            if (typeof body?.sites !== 'string') return send(res, 400, { error: 'sites is required' })
            const store = readCheckinStore(stateDir())
            const taken = new Set(store.channels.map(channel => channel.id))
            const userId = typeof body?.userId === 'string' ? body.userId.trim() : ''
            // 用户 ID 允许从粘进来的一小段请求头里自动认（`New-Api-User: 12345`）。
            const resolvedUserId = userId !== '' ? userId : pickNewApiUser({ 'New-Api-User': String(body?.userId ?? '') })
            const parsed = parseSiteList(body.sites, {
              cookie: typeof body?.cookie === 'string' ? body.cookie : '',
              userId: resolvedUserId,
              takenIds: taken,
            })
            if (parsed.drafts.length > 0) info(`auth-hub: 批量生成 ${parsed.drafts.length} 个中转站草稿`)
            send(res, 200, { ok: true, ...parsed, count: parsed.drafts.length, templates: templateView() })
          },
        }),
        // ── 签到渠道的自动执行 ──────────────────────────────────────────────
        //
        // 60 秒一次的定时器 + 幂等判据（`isDue`：日期、钟点、重试间隔、当天尝试
        // 次数都在里面）。为什么不用 setTimeout 算到下一个整点：机器休眠/唤醒后
        // 定时器会漂，而「每轮比较一次」的幂等判据怎么漂都不会漏签或重签。
        //
        // ⚠️ 这里**不要**再自己判一遍「到点没」：早期版本在这里另写了一份
        // `clock >= scheduleAt` 的判断，结果绕过了 `isDue` 里的失败重试——
        // 一次网络抖动把 lastDay 写成今天后，调度器永远认为「今天处理过了」。
        scoped.effect(() => {
          let stopped = false
          const tick = async () => {
            if (stopped) return
            try {
              const store = readCheckinStore(stateDir())
              if (store.settings.auto !== true) return
              const nowMs = Date.now()
              const day = utc8Day(nowMs)
              const clock = utc8Clock(nowMs)
              const settings = store.settings
              const catchUp = settings.catchUpOnStart === true
              // 到点（含失败后到重试间隔的）：isDue 是唯一判据，别在这里再抄一份
              // 「clock >= scheduleAt」——早期版本抄过，结果绕过了失败重试。
              const targets = store.channels.filter(channel => isDue(channel, store.state[channel.id], nowMs, settings))
                .filter(channel => {
                  if (catchUp) return true
                  // 关掉开机补签：只签「恰好到这个钟点」的，避免启动瞬间连打十几个站。
                  if ((channel.scheduleAt ?? '00:00') === clock) return true
                  // 但**今天已经失败过**的照跑：那是「找回今天的额度」，不是「提前签」。
                  const state = store.state[channel.id]
                  return state?.lastDay === day && state?.lastStatus === 'error'
                })
              if (targets.length === 0) return
              const result = await runCheckinBatch({
                dir: stateDir(),
                ids: targets.map(channel => channel.id),
                recordGrant: (provider, accountId, amount, at) => recordCreditGrant(creditUsageFile(), provider, accountId, amount, at),
                info,
                warn,
              })
              if (result.ran > 0) info(`auth-hub: 自动签到 ${result.ran} 个渠道（${day}）`)
            } catch (error) {
              warn(`auth-hub: 自动签到扫描失败：${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const timer = setInterval(() => { void tick() }, 60_000)
          // 挂载后 20 秒补一次（避开启动高峰）；这就是「开机 30 秒内自动签到」。
          const boot = setTimeout(() => { void tick() }, 20_000)
          return () => {
            stopped = true
            clearInterval(timer)
            clearTimeout(boot)
          }
        }, 'auth-hub: checkin scheduler'),
        // ── 成长清扫的自动执行（本地补丁 9）──────────────────────────────────
        //
        // 与签到调度器同款思路：**幂等判据比较日期**，不用 setTimeout 算到下一个
        // 整点（机器休眠/唤醒会让定时器漂，日期判据怎么漂都不会漏跑或重跑）。
        //
        // 默认**关闭**（`auto: false`）：成长清扫是「帮用户领钱」，但用户可能想
        // 自己控制时机；而且它会在上游产生真实请求，不能默认替用户决定。
        // 开启方式：`$DSH_HOME/channel-pack/growth-settings.json` 写
        //   `{ "auto": true, "providers": ["workbuddy","buddy"] }`
        // 或环境变量 `DSH_GROWTH_AUTO=1`。
        //
        // 失败策略：**不重试到天荒地老**。成长中心是送钱操作，不是关键路径；
        // 一天最多跑 `maxAttemptsPerDay`（默认 2）次，每次之间至少间隔 20 分钟。
        scoped.effect(() => {
          let stopped = false
          const tick = async () => {
            if (stopped) return
            try {
              const settings = readGrowthSettings()
              if (settings.auto !== true) return
              const state = readGrowthAutoState()
              const day = utc8Day()
              const nowMs = Date.now()
              const providers = settings.providers.filter(p => {
                const row = state.providers?.[p]
                if (row === undefined) return true
                if (row.lastDay !== day) return true
                // 今天跑过：只有失败的才按间隔重试，成功的当天不再动（防重复领取）
                if (row.lastStatus === 'ok') return false
                if ((row.attempts ?? 0) >= settings.maxAttemptsPerDay) return false
                return nowMs - (row.lastAt ?? 0) >= settings.retryMinutes * 60_000
              })
              if (providers.length === 0) return
              const nextState = { version: 1, providers: { ...(state.providers ?? {}) } }
              for (const provider of providers) {
                const prev = nextState.providers[provider] ?? { attempts: 0, lastDay: '' }
                const attempts = prev.lastDay === day ? (prev.attempts ?? 0) + 1 : 1
                try {
                  const swept = await runGrowthSweepForProvider({
                    provider,
                    day,
                    recordGrant: (p, accountId, amount, at) => recordCreditGrant(creditUsageFile(), p, accountId, at),
                    info,
                    warn,
                  })
                  nextState.providers[provider] = {
                    lastDay: day,
                    lastAt: Date.now(),
                    attempts,
                    // 只要有账号成功就算 ok；全部失败才算 error（触发下次重试）
                    lastStatus: swept.totals.swept > 0 ? 'ok' : 'error',
                    lastError: swept.totals.failed > 0
                      ? swept.accounts.filter(row => row.error !== undefined).map(row => `${row.nickname || row.accountId}: ${row.error}`).join('; ').slice(0, 400)
                      : '',
                  }
                  if (swept.totals.swept > 0) {
                    info(`auth-hub: 自动成长清扫 ${provider} ${swept.totals.swept}/${swept.totals.accounts} 个账号，积分+${swept.totals.claimedCredits}（${day}）`)
                  }
                } catch (error) {
                  nextState.providers[provider] = {
                    lastDay: day,
                    lastAt: Date.now(),
                    attempts,
                    lastStatus: 'error',
                    lastError: (error instanceof Error ? error.message : String(error)).slice(0, 400),
                  }
                }
              }
              writeGrowthAutoState(nextState)
            } catch (error) {
              warn(`auth-hub: 自动成长清扫扫描失败：${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const timer = setInterval(() => { void tick() }, 15 * 60_000)
          // 挂载后 90 秒补一次：成长清扫不是关键路径，避开启动高峰（签到先跑）。
          const boot = setTimeout(() => { void tick() }, 90_000)
          return () => {
            stopped = true
            clearInterval(timer)
            clearTimeout(boot)
          }
        }, 'auth-hub: growth scheduler'),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'auth-hub: account routes')
  })

  info(`auth-hub: 账号中心已挂载（账号渠道内置；积分台账 ${creditUsageFile()}；轮换 provider "${ROUTER_PROVIDER}"）`)
}

export { rotationOrder }
