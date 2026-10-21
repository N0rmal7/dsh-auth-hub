/**
 * 账号渠道「积分用量」台账 —— 上限执行的数据来源。
 *
 * 为什么需要它：上游的 `token-ledger.json` 只记 token（免费车道的计费口径），
 * 而账号渠道是按**积分**扣费的，且上游从不记录每次请求扣了多少积分。因此这里
 * 用「余额快照取差分」来推算。
 *
 * ## 三条口径（v2，2026-10-21 重写）
 *
 * 1. **按账号记账**。上限是「每账号每天」的，所以 `used` 必须落到 `accountId` 上，
 *    渠道级数字只是账号的汇总。v1 只有渠道级，读旧文件时自动迁移。
 * 2. **签到/充值不冲抵消耗**。v1 用 `prev.total - total`，遇到「两次采样之间既
 *    消耗又领取」时会**低估**消耗（净变化掩盖），遇到「领取的积分到期失效」时
 *    又会**高估**消耗（把到期当成用完）。v2 优先用**逐包差分**：
 *
 *        consumed = Σ_包 max(0, prev.remaining - cur.remaining)
 *
 *    新出现的包（签到/充值新建的额度包）与余额增加的包都天然贡献 0，
 *    到期包在两组快照里 `remaining` 不变（只是 `active` 转 false），也贡献 0。
 * 3. **领取量与显式 grants 对账**。当渠道只给得出 `total`（没有 `packages`）时，
 *    退回总量差分，并把**已知的领取量**加回去：
 *
 *        consumed = max(0, prev.total + grantedSincePrev - cur.total)
 *
 *    `grantedSincePrev` 来自 `grants[]`：pack 在真正领取成功时写入
 *    （`本地补丁 5`），所以「既消耗又领取」也能算出真消耗。
 *    逐包差分与总量差分同时可用时取
 *
 *        consumed = byPackage + min(granted, max(0, byTotal - byPackage))
 *
 *    —— 上界被 `granted` 夹住，到期失效不会把消耗顶到天上。
 *
 * ## 仍然诚实的两条边界（界面上也要写）
 *
 * 1. 只有被**查询过余额**的账号才有数据；两次查询之间的消耗会在下一次查询时
 *    一次性计入（按查询时刻归日）。
 * 2. 渠道只返回 `total` 且我们没记录到领取量时，净变化仍会低估消耗（保守）。
 *
 * 台账文件：`$DSH_HOME/channel-pack/credit-usage.json`
 *
 *   {
 *     "schema": "dsh-auth-hub/credit-usage/v2",
 *     "days": {
 *       "2026-10-21": {
 *         "providers": { "codearts": { "used": 123.4, "samples": 5 } },
 *         "accounts":  { "codearts-a05559ed": { "provider": "codearts", "used": 100, "samples": 3 } }
 *       }
 *     },
 *     "baseline": {
 *       "codearts-a05559ed": { "provider": "codearts", "total": 800, "at": 1792..., "packages": { "包键": 300 } }
 *     },
 *     "grants": [ { "accountId": "…", "provider": "…", "amount": 100, "at": 1792... } ]
 *   }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const CREDIT_USAGE_FILE = 'credit-usage.json'
export const CREDIT_USAGE_SCHEMA = 'dsh-auth-hub/credit-usage/v2'
/** v1 只有 `days[day][provider]`，读到时按渠道级迁移。 */
export const LEGACY_SCHEMA = 'dsh-auth-hub/credit-usage/v1'

/** 只保留最近 N 天，避免文件无限增长（90 天与 token-ledger 的历史口径一致）。 */
const KEEP_DAYS = 90
/** grants 也是按天剪枝的；同一天内可能被反复读取，剪枝阈值与台账一致。 */
const KEEP_GRANTS_MS = KEEP_DAYS * 864e5

export function utc8Day(nowMs = Date.now()) {
  const shifted = new Date(nowMs + 8 * 3600e3)
  const pad = part => String(part).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function emptyDoc() {
  return { schema: CREDIT_USAGE_SCHEMA, days: {}, baseline: {}, grants: [], grantSeq: 0 }
}

function positiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * 包的稳定标识：名字 + 单位 + 本周期结束时间 + 失效时间。
 *
 * 为什么不用下标：`packages` 的顺序由各渠道自己决定，渠道换了排列就会让两组
 * 快照对不上、算出假的消耗。为什么带周期：同名包续期后是**新的一份额度**，
 * 不该把上一期的剩余算到这一期头上。
 */
function packageKey(pkg) {
  const name = typeof pkg?.name === 'string' ? pkg.name : ''
  const unit = typeof pkg?.unit === 'string' ? pkg.unit : ''
  const cycleEnd = typeof pkg?.cycleEndTime === 'string' ? pkg.cycleEndTime : ''
  const expired = typeof pkg?.expiredTime === 'string' ? pkg.expiredTime : ''
  return `${name}|${unit}|${cycleEnd}|${expired}`
}

/**
 * 把一次余额快照的 `packages` 压成 `{ 包键: 剩余 }`。
 *
 * 返回 `undefined` 表示「这个渠道没有可用包信息」，调用方退回总量差分。
 * 到期包**照样记入**（`remaining` 不变），这样它由 active 转 inactive 时
 * 逐包差分是 0，不会被当成消耗。
 */
export function packageSnapshot(balance) {
  const packages = Array.isArray(balance?.packages) ? balance.packages : []
  const out = {}
  let count = 0
  for (const pkg of packages) {
    const remaining = Number(pkg?.remaining)
    if (!Number.isFinite(remaining) || remaining < 0) continue
    let key = packageKey(pkg)
    if (out[key] !== undefined) {
      // 同名同周期同失效时间的多个包：加序号，避免互相覆盖。
      let index = 2
      while (out[`${key}#${index}`] !== undefined) index += 1
      key = `${key}#${index}`
    }
    out[key] = round2(remaining)
    count += 1
  }
  return count === 0 ? undefined : out
}

/** 宽松解析：任何不认识的形状都退回空台账，绝不因此让调用方失败。 */
export function normalizeCreditUsage(raw) {
  const doc = emptyDoc()
  if (raw === null || typeof raw !== 'object') return doc
  const days = raw.days !== null && typeof raw.days === 'object' ? raw.days : {}
  for (const [day, bucket] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || bucket === null || typeof bucket !== 'object') continue
    const row = {}
    // v2：{ providers, accounts }；v1：直接就是渠道表。
    const providersRaw = bucket.providers !== null && typeof bucket.providers === 'object'
      ? bucket.providers
      : (bucket.accounts === undefined ? bucket : {})
    const accountsRaw = bucket.accounts !== null && typeof bucket.accounts === 'object' ? bucket.accounts : {}
    const providers = {}
    for (const [provider, value] of Object.entries(providersRaw)) {
      if (typeof provider !== 'string' || provider === '' || value === null || typeof value !== 'object') continue
      const used = Number(value.used)
      const samples = Number(value.samples)
      if (!Number.isFinite(used) || used < 0) continue
      providers[provider] = { used: round2(used), samples: Number.isFinite(samples) && samples > 0 ? Math.trunc(samples) : 0 }
    }
    const accounts = {}
    for (const [accountId, value] of Object.entries(accountsRaw)) {
      if (typeof accountId !== 'string' || accountId === '' || value === null || typeof value !== 'object') continue
      const used = Number(value.used)
      const samples = Number(value.samples)
      if (!Number.isFinite(used) || used < 0) continue
      accounts[accountId] = {
        provider: typeof value.provider === 'string' ? value.provider : '',
        used: round2(used),
        samples: Number.isFinite(samples) && samples > 0 ? Math.trunc(samples) : 0,
      }
    }
    if (Object.keys(providers).length > 0 || Object.keys(accounts).length > 0) row.providers = providers
    if (Object.keys(accounts).length > 0) row.accounts = accounts
    if (Object.keys(row).length > 0) doc.days[day] = row
  }
  const baseline = raw.baseline !== null && typeof raw.baseline === 'object' ? raw.baseline : {}
  for (const [accountId, value] of Object.entries(baseline)) {
    if (typeof accountId !== 'string' || accountId === '' || value === null || typeof value !== 'object') continue
    const total = Number(value.total)
    if (!Number.isFinite(total)) continue
    const at = Number(value.at)
    const packages = {}
    if (value.packages !== null && typeof value.packages === 'object') {
      for (const [key, remaining] of Object.entries(value.packages)) {
        const n = Number(remaining)
        if (typeof key === 'string' && Number.isFinite(n) && n >= 0) packages[key] = round2(n)
      }
    }
    doc.baseline[accountId] = {
      provider: typeof value.provider === 'string' ? value.provider : '',
      total,
      at: Number.isFinite(at) && at > 0 ? at : 0,
      grantSeq: Number.isFinite(Number(value.grantSeq)) ? Math.trunc(Number(value.grantSeq)) : 0,
      ...Object.keys(packages).length > 0 ? { packages } : {},
    }
  }
  const grants = Array.isArray(raw.grants) ? raw.grants : []
  let maxSeq = 0
  for (const row of grants) {
    if (row === null || typeof row !== 'object') continue
    const amount = Number(row.amount)
    const at = Number(row.at)
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(at) || at <= 0) continue
    const seq = Number(row.seq)
    const normalized = {
      accountId: typeof row.accountId === 'string' ? row.accountId : '',
      provider: typeof row.provider === 'string' ? row.provider : '',
      amount: round2(amount),
      at,
      // 老台账没有 seq：按数组顺序补一个，保证「读到就能比较」。
      seq: Number.isFinite(seq) && seq > 0 ? Math.trunc(seq) : maxSeq + 1,
    }
    if (normalized.seq > maxSeq) maxSeq = normalized.seq
    doc.grants.push(normalized)
  }
  doc.grantSeq = maxSeq
  return doc
}

export function readCreditUsage(file) {
  if (!existsSync(file)) return emptyDoc()
  try {
    return normalizeCreditUsage(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyDoc()
  }
}

export function writeCreditUsage(file, doc) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  renameSync(tmp, file)
  return doc
}

function pruneDays(doc, nowMs) {
  const keep = new Set()
  for (let index = 0; index < KEEP_DAYS; index += 1) keep.add(utc8Day(nowMs - index * 864e5))
  for (const day of Object.keys(doc.days)) if (!keep.has(day)) delete doc.days[day]
  doc.grants = doc.grants.filter(row => nowMs - row.at <= KEEP_GRANTS_MS)
  return doc
}

/** 某账号自 `sinceSeq` 之后新增的领取量（签到 / 充值 / 成长奖励）。
 *
 * ⚠️ 用**序号**而不是时间戳：`recordCreditGrant` 与 `recordBalanceSample` 可能落在
 * 同一毫秒里（实测单测里就偶发），用 `at > baseline.at` 会把这次领取漏掉，于是
 * 「领了又用掉」被算成 0 消耗。序号严格递增，没有这种并列。 */
function grantedSince(doc, accountId, provider, sinceSeq) {
  let sum = 0
  for (const row of doc.grants) {
    if ((Number(row.seq) || 0) <= sinceSeq) continue
    // 账号级 grant 优先；没有账号（例如成长中心只报渠道）时按渠道匹配。
    if (row.accountId !== '' && row.accountId !== accountId) continue
    if (row.accountId === '' && row.provider !== '' && row.provider !== provider) continue
    sum += row.amount
  }
  return round2(sum)
}

/**
 * 逐包差分：两组快照共同持有的包里，剩余量**减少**的部分。
 *
 * 新包 / 加量的包 / 到期的包都不贡献消耗 —— 这正是「排除签到变化」的实现点。
 * 返回 `undefined` 表示无法逐包比较（没有包信息，或两边没有交集）。
 */
function consumedByPackage(previous, current) {
  if (previous === undefined || current === undefined) return undefined
  let sum = 0
  let matched = 0
  for (const [key, before] of Object.entries(previous)) {
    const after = current[key]
    if (after === undefined) continue
    matched += 1
    const delta = before - after
    if (delta > 0) sum += delta
  }
  if (matched === 0) return undefined
  return round2(sum)
}

/**
 * 把一次余额查询的结果并入台账。
 *
 * `rows` 是 `credits.balances` 的 `accounts` 数组：
 * `{ accountId, nickname, balance: { total, packages } | null, error? }`。
 *
 * @param {string} file - 台账文件路径
 * @param {string} provider - 渠道 id
 * @param {Array<object>} rows - `credits.balances` 的 accounts
 * @param {number} [nowMs]
 * @returns {{ deltas: Record<string, number>, accountDeltas: Record<string, number>, doc: object }}
 *   `deltas` 按渠道汇总，`accountDeltas` 按账号 —— 界面与日志两个粒度都要。
 */
export function recordBalanceSample(file, provider, rows, nowMs = Date.now()) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { deltas: {}, accountDeltas: {}, doc: readCreditUsage(file) }
  }
  const doc = pruneDays(readCreditUsage(file), nowMs)
  const day = utc8Day(nowMs)
  const deltas = {}
  const accountDeltas = {}
  let changed = false
  for (const row of rows) {
    const accountId = typeof row?.accountId === 'string' ? row.accountId : ''
    const total = Number(row?.balance?.total)
    if (accountId === '' || !Number.isFinite(total)) continue
    const previous = doc.baseline[accountId]
    const currentPackages = packageSnapshot(row.balance)
    let consumed = 0
    const previousSeq = previous === undefined ? 0 : (Number(previous.grantSeq) || 0)
    if (previous !== undefined && previous.provider === provider) {
      // 账号被重建（provider 变了）时旧基线不可比，直接重置、不记消耗。
      const granted = grantedSince(doc, accountId, provider, previousSeq)
      const byPackage = consumedByPackage(previous.packages, currentPackages)
      const byTotalRaw = round2(previous.total + granted - total)
      const byTotal = byTotalRaw > 0 ? byTotalRaw : 0
      if (byPackage !== undefined) {
        // 逐包差分不含「领了又用掉」的那部分，用被 granted 夹住的超出量补回来。
        const extra = granted > 0 ? Math.min(granted, Math.max(0, byTotal - byPackage)) : 0
        consumed = round2(byPackage + extra)
      } else {
        consumed = byTotal
      }
    }
    if (consumed > 0) {
      const bucket = doc.days[day] ?? {}
      const providers = bucket.providers ?? {}
      const strip = providers[provider] ?? { used: 0, samples: 0 }
      providers[provider] = { used: round2(strip.used + consumed), samples: strip.samples + 1 }
      const accounts = bucket.accounts ?? {}
      const current = accounts[accountId] ?? { provider, used: 0, samples: 0 }
      accounts[accountId] = { provider, used: round2(current.used + consumed), samples: current.samples + 1 }
      bucket.providers = providers
      bucket.accounts = accounts
      doc.days[day] = bucket
      deltas[provider] = round2((deltas[provider] ?? 0) + consumed)
      accountDeltas[accountId] = round2((accountDeltas[accountId] ?? 0) + consumed)
    }
    doc.baseline[accountId] = {
      provider,
      total,
      at: nowMs,
      // 记录「这次采样时已经能看到多少条 grant」：下次差分只把之后新增的加回去。
      grantSeq: Number(doc.grantSeq) || 0,
      ...currentPackages === undefined ? {} : { packages: currentPackages },
    }
    changed = true
  }
  if (changed) writeCreditUsage(file, doc)
  return { deltas, accountDeltas, doc }
}

/**
 * 记录一次「领取成功」（签到 / 成长奖励 / 充值）。
 *
 * 只在渠道**只给得出总量**时才需要它——逐包差分本身就能把新包与加量排除掉。
 * `accountId` 允许为空串：成长中心只知道渠道、不知道具体账号。
 */
export function recordCreditGrant(file, provider, accountId, amount, nowMs = Date.now()) {
  const value = Number(amount)
  if (!Number.isFinite(value) || value <= 0) return readCreditUsage(file)
  const doc = pruneDays(readCreditUsage(file), nowMs)
  const seq = (Number(doc.grantSeq) || 0) + 1
  doc.grantSeq = seq
  doc.grants.push({
    accountId: typeof accountId === 'string' ? accountId : '',
    provider: typeof provider === 'string' ? provider : '',
    amount: round2(value),
    at: nowMs,
    seq,
  })
  return writeCreditUsage(file, doc)
}

/** 今日某渠道已用积分（无记录 = 0）。渠道级 = 该渠道下账号之和。 */
export function usedCreditsToday(doc, provider, nowMs = Date.now()) {
  const row = doc?.days?.[utc8Day(nowMs)]?.providers?.[provider]
  const used = Number(row?.used)
  return Number.isFinite(used) && used > 0 ? used : 0
}

/** 今日某**账号**已用积分（无记录 = 0）。上限判定用这个。 */
export function usedCreditsTodayForAccount(doc, accountId, nowMs = Date.now()) {
  const row = doc?.days?.[utc8Day(nowMs)]?.accounts?.[accountId]
  const used = Number(row?.used)
  return Number.isFinite(used) && used > 0 ? used : 0
}

/** 今日所有账号的用量：`{ [accountId]: { provider, used, samples } }`。 */
export function todayAccountUsage(doc, nowMs = Date.now()) {
  const rows = doc?.days?.[utc8Day(nowMs)]?.accounts
  if (rows === null || typeof rows !== 'object') return {}
  const out = {}
  for (const [accountId, value] of Object.entries(rows)) {
    out[accountId] = {
      provider: typeof value.provider === 'string' ? value.provider : '',
      used: positiveNumber(value.used) ?? 0,
      samples: Number(value.samples) || 0,
    }
  }
  return out
}
