/**
 * DSH 账号中心 —— Host 半身。
 *
 * 现在**自己就是账号渠道的宿主**：内置 `vendor/channel-pack/pack.js`（原属
 * `dsh-our-free-model`，13 个渠道的登录 / 账号池 / 积分领取），所以不再需要装
 * 那个插件。WorkBuddy 的双区登录也走内置 pack。
 *
 * 路由（都在本插件的 web 服务上，`/plugins/dsh-auth-hub/*`）：
 *   GET  status         内置 channel-pack 是否挂载 + controlKey + 文件路径 + 轮换路由状态
 *   GET  policy         每账号积分上限 + 今日已用积分 + 余额基线
 *   POST policy         写入积分上限（需 controlKey）
 *   POST credit-sample  记录一次余额快照（界面拉完余额后回报）
 *   POST credit-grant   记录一次「领取成功」的积分（签到已由 pack 自己记，这里是补录口）
 *   GET  rotations      轮换组 + 今日各候选用量 + 预览顺序
 *   POST rotations      写入轮换组（需 controlKey），并广播 `llm/adapters-updated`
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
  return { day, accounts, providers, policy, baseline: usage.baseline, grantsToday: grantsToday(usage, day) }
}

function grantsToday(usage, day) {
  const start = Date.parse(`${day}T00:00:00+08:00`)
  const rows = (usage.grants ?? []).filter(row => row.at >= start)
  return rows.reduce((sum, row) => sum + row.amount, 0)
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

function diagnostics() {
  return {
    plugin: 'dsh-auth-hub',
    controlKey,
    channelPack: { ...channelPackState },
    router: { ...routerState },
    policyFile: policyFile(),
    creditUsageFile: creditUsageFile(),
    rotationsFile: rotationsFile(),
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
  const state = readJsonFile(path.join(stateDir(), 'state.json'), { accounts: [] })
  const accounts = Array.isArray(state?.accounts) ? state.accounts : []
  const match = accounts.find(account => account?.provider === provider && account?.enabled !== false)
  if (match === undefined) return undefined
  const ref = typeof match.credentialRef === 'string' ? match.credentialRef : ''
  if (ref === '') return undefined
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
            const provider = String(req.method === 'GET' ? (new URL(req.url ?? '/', 'http://x').searchParams.get('provider') ?? 'workbuddy') : '')
            try {
              if (req.method === 'GET') {
                const credential = await resolveGrowthCredential(provider)
                if (credential === undefined) return send(res, 200, { provider, signedIn: false })
                const [status, tasks, streakDays, rewardToday] = await Promise.all([
                  fetchGrowthStatus(credential).catch(() => undefined),
                  fetchGrowthTasks(credential).catch(() => undefined),
                  fetchGrowthStreakDays(credential).catch(() => undefined),
                  fetchGrowthRewardToday(credential, utc8Day()).catch(() => undefined),
                ])
                return send(res, 200, { provider, signedIn: true, status, tasks, streakDays, rewardToday })
              }
              if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
              if (!keyMatches(req.headers[CONTROL_KEY_HEADER])) return send(res, 403, { error: 'invalid-control-key' })
              const body = await readJson(req)
              const target = typeof body?.provider === 'string' ? body.provider : 'workbuddy'
              const credential = await resolveGrowthCredential(target)
              if (credential === undefined) return send(res, 400, { error: `no signed-in account for ${target}` })
              const result = await runGrowthSweep(credential, { day: utc8Day() })
              // 成长奖励也是「领取」，必须记入 grants，否则会被当成消耗之外的净减少。
              if (Number(result.claimedCredits) > 0) {
                recordCreditGrant(creditUsageFile(), target, '', Number(result.claimedCredits))
              }
              info(`auth-hub: ${target} 成长清扫 任务+${result.claimedTasks} 积分+${result.claimedCredits}`)
              send(res, 200, { ok: true, provider: target, result })
            } catch (error) {
              send(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'auth-hub: account routes')
  })

  info(`auth-hub: 账号中心已挂载（账号渠道内置；积分台账 ${creditUsageFile()}；轮换 provider "${ROUTER_PROVIDER}"）`)
}

export { rotationOrder }
