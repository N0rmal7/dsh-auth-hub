/**
 * 轮换引擎：同一个模型名 → 多个**账号渠道**候选，按策略挑一个。
 *
 * 为什么自己实现：上游 combo（`src/combos.js`）的成员必须来自它自己的目录，而那份
 * 目录只含 free / kilo / eac 三条**免费**车道，账号渠道（codearts / qoder / trae /
 * minimax / codebuddy…）根本不在里面。所以账号渠道的轮换只能在账号渠道这一层做。
 *
 * 三个策略：
 *   - `fallback`    永远从第一个开始，失败才顺延（质量阶梯）
 *   - `round-robin` 每次从下一个开始，连续用 `stickyLimit` 次再换（摊负载）
 *   - `least-used`  今天用得最少的优先（按积分/次数，把配额匀开）
 *
 * 纯函数 + 显式状态，没有任何 I/O：轮换游标由调用方持有（见 `createRotationState`），
 * 这样单测可以完全确定性地验证，重进程也只是丢一个起点。
 */

export const ROTATION_STRATEGIES = ['fallback', 'round-robin', 'least-used']

/**
 * 一个轮换组。
 * @typedef {object} RotationGroup
 * @property {string} id           稳定 id（用于游标）
 * @property {string} name         显示名
 * @property {string[]} members    候选标识，按优先级排列；**账号渠道模型**形如 `provider::modelId`
 * @property {'fallback'|'round-robin'|'least-used'} strategy
 * @property {number} stickyLimit  连续使用同一个候选的次数（round-robin 用）
 * @property {boolean} enabled
 * @property {number} [maxCreditsPerDay] 组级每日积分上限（可选）
 */

const DEFAULT_STICKY = 4

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** `codearts::deepseek-v4.1-flash` → `{ provider, model }`；不合法的形态返回 undefined。 */
export function parseMember(member) {
  const raw = text(member)
  if (raw === '') return undefined
  const at = raw.indexOf('::')
  if (at <= 0) return undefined
  const provider = raw.slice(0, at).trim()
  const model = raw.slice(at + 2).trim()
  if (provider === '' || model === '') return undefined
  return { provider, model, id: `${provider}::${model}` }
}

/**
 * 宽松解析：用户的设置文件是「过了 JSON 的输入」，每个字段都当不可信。
 * 成员去重、非法成员丢弃；没有成员的组直接丢掉（一个不能出结果的组没有意义）。
 */
export function normalizeRotations(raw) {
  const rows = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const out = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = text(row.id) || text(row.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    if (id === '' || seen.has(id)) continue
    const members = []
    const memberSeen = new Set()
    for (const raw of Array.isArray(row.members) ? row.members : []) {
      const parsed = parseMember(raw)
      if (parsed === undefined || memberSeen.has(parsed.id)) continue
      memberSeen.add(parsed.id)
      members.push(parsed.id)
    }
    if (members.length === 0) continue
    seen.add(id)
    const sticky = Number(row.stickyLimit)
    const cap = Number(row.maxCreditsPerDay)
    out.push({
      id,
      name: text(row.name) || id,
      members,
      strategy: ROTATION_STRATEGIES.includes(row.strategy) ? row.strategy : 'round-robin',
      stickyLimit: Number.isFinite(sticky) && sticky > 0 ? Math.trunc(sticky) : DEFAULT_STICKY,
      enabled: row.enabled !== false,
      ...(Number.isFinite(cap) && cap > 0 ? { maxCreditsPerDay: Math.round(cap * 100) / 100 } : {}),
    })
  }
  return out
}

/** 轮换游标：**纯数据**，调用方持有/持久化。 */
export function createRotationState() {
  return { cursors: {} }
}

/**
 * 为一个轮换组挑出「本次该先试哪个」的完整顺序。
 *
 * @param {RotationGroup} group
 * @param {object} state        `createRotationState()` 的结果（会被就地推进）
 * @param {object} [options]
 * @param {(memberId: string) => number} [options.usageOf] - `least-used` 用：候选今日已用量
 * @param {boolean} [options.peek] - 只算不推进（预览 / 诊断用）
 * @returns {string[]} 成员顺序，第一个是首选
 */
export function rotationOrder(group, state, options = {}) {
  const members = Array.isArray(group?.members) ? group.members : []
  if (members.length <= 1) return [...members]
  const strategy = ROTATION_STRATEGIES.includes(group?.strategy) ? group.strategy : 'round-robin'

  if (strategy === 'fallback') return [...members]

  if (strategy === 'least-used') {
    const usageOf = typeof options.usageOf === 'function' ? options.usageOf : () => 0
    // 用量升序；用量相同则保持配置顺序（稳定排序，结果可复现）。
    const indexed = members.map((id, index) => ({ id, index, used: Number(usageOf(id)) || 0 }))
    indexed.sort((a, b) => (a.used - b.used) || (a.index - b.index))
    return indexed.map(row => row.id)
  }

  // round-robin：每 stickyLimit 次前进一格
  const limit = Number.isFinite(Number(group?.stickyLimit)) && Number(group.stickyLimit) > 0
    ? Math.trunc(Number(group.stickyLimit))
    : DEFAULT_STICKY
  const key = String(group?.id ?? 'default')
  const cursor = state?.cursors?.[key] ?? { index: 0, used: 0 }
  const index = Math.min(Math.max(Number(cursor.index) || 0, 0), members.length - 1)
  const ordered = [...members.slice(index), ...members.slice(0, index)]
  if (options.peek !== true && state !== undefined && state.cursors !== undefined) {
    const used = (Number(cursor.used) || 0) + 1
    state.cursors[key] = used >= limit
      ? { index: (index + 1) % members.length, used: 0 }
      : { index, used }
  }
  return ordered
}

/**
 * 从候选顺序里挑第一个「今天没用爆」的。
 *
 * `exhausted(memberId)` 由调用方提供（例如积分上限判定）。全部用爆时返回 `undefined`
 * —— 让调用方明确地「整组今天都别用了」，而不是偷偷用一个超额的。
 */
export function pickMember(group, state, { usageOf, exhausted, peek } = {}) {
  const order = rotationOrder(group, state, { usageOf, peek })
  const isOut = typeof exhausted === 'function' ? exhausted : () => false
  for (const member of order) {
    if (isOut(member) !== true) return member
  }
  return undefined
}

/** 删掉已不存在的组的游标，避免状态无限增长。 */
export function pruneRotationState(state, groups) {
  if (state === null || typeof state !== 'object' || state.cursors === null || typeof state.cursors !== 'object') return state
  const live = new Set((Array.isArray(groups) ? groups : []).map(group => String(group?.id ?? '')))
  for (const key of Object.keys(state.cursors)) if (!live.has(key)) delete state.cursors[key]
  return state
}