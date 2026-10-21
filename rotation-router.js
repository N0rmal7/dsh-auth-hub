/**
 * 轮换路由 —— 把「轮换组」真正接进模型目录。
 *
 * ## 为什么需要它（用户报障的直接原因）
 *
 * `rotation.js` 只是**纯逻辑**：算顺序、算挑谁。在此之前它没有被任何人调用，
 * 所以界面上辛苦拼出来的轮换组在 `/model` 弹窗里**根本不存在**——用户能存组，
 * 却找不到能选的那个模型。本文件补上缺的那一段：把轮换组注册成一个真正的
 * LLM provider，于是它出现在模型选择器里，请求也从这里经过。
 *
 * ## 形状
 *
 * 一个 provider（`auth-hub`）→ 每个**启用的轮换组**是它的一个模型：
 *
 *   provider: auth-hub                     名字：账号中心轮换
 *   model:    deepseek-v4-1-flash          名字：deepseek-v4.1-flash（轮流 3 个候选）
 *
 * 这样 `/model` 里只多出一组，组名一目了然；想加组只需在账号中心再存一个，
 * 目录是**动态读**的，不用重挂适配器。
 *
 * ## 一次请求怎么走
 *
 * 1. 按策略算顺序（`rotationOrder`，游标在进程内推进）。
 * 2. 跳过「今天已用满」的候选（`exhausted` 由调用方给：见 index.js 的
 *    `memberExhausted`，它读每账号积分上限）。
 * 3. 依次尝试：把 `{ provider, model }` 换成成员自己的，直接调 `ctx.llm.stream`。
 * 4. **首个 chunk 是失败**（适配器在没产出任何内容就失败时只会吐一个
 *    `finish{reason:{kind:'error'}}`）→ 换下一个候选，失败不外泄。
 * 5. 一旦产出过任何内容就不再换人——半截的话不能拼两个模型的输出。
 *
 * ## 边界
 *
 * - 成员是 `auth-hub::…`（自己）时跳过，否则会无限递归。
 * - 游标在**请求开始时**推进（与上游 combos 一致）；失败重试也消耗一格。
 * - `usage` 与 `finish` 原样透传：token 记账读的是下游适配器报的数。
 */
import { parseMember, pickMember, rotationOrder } from './rotation.js'

/**
 * ⚠️ **故意不 import `@deepseek-ai/dsh-llm`**。
 *
 * `LlmRuntime.registerAdapter()` 对适配器只做**鸭子类型**调用
 * （`providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel` /
 * `prepareCall` / `stream` / `imageRequestPricing` / `imageRequestTarget`），
 * 没有任何 `instanceof LlmAdapter` 检查。少一个 import 换来两个实打实的好处：
 *
 * 1. 单测能在普通 Node 进程里直接跑（那个包里没有 dsh-llm，静态 import 会让
 *    整个模块 ERR_MODULE_NOT_FOUND）；动态 import 在 asar + 自定义 loader 下也未必
 *    解析得到 —— 与其赌解析，不如不依赖。
 * 2. 挂载路径上少一次模块解析，插件加载更快、失败面更小。
 *
 * 下面这个基类补齐「没重写时的默认行为」，语义与上游 `LlmAdapter` 一致。
 */
class AdapterBase {
  providerInfo(provider) { return { id: provider, name: provider } }
  /** 上游会**无条件调用**这三个（`??`/可选链之前就先 call），所以必须是函数。 */
  providerRetryPolicy() { return undefined }
  imageRequestPricing() { return undefined }
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }
  listModels() { return Promise.resolve([]) }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) }
  }
  stream() { throw new Error('rotation adapter: stream() 未实现') }
}

/** 轮换路由自己的 provider id（不要与任何账号渠道重名）。 */
export const ROUTER_PROVIDER = 'auth-hub'
/** 模型选择器里的分组名。 */
export const ROUTER_PROVIDER_NAME = '账号中心轮换'

/**
 * 轮换组 → 模型目录条目。
 *
 * `id` 用组 id（稳定、可持久化到会话里）；`name` 用组名 + 候选数，因为
 * 模型选择器只显示 `name`，光看组名看不出「这是个轮换入口」。
 */
export function buildRotationModels(groups) {
  const out = []
  for (const group of Array.isArray(groups) ? groups : []) {
    if (group === null || typeof group !== 'object') continue
    if (group.enabled === false) continue
    const id = typeof group.id === 'string' ? group.id.trim() : ''
    if (id === '') continue
    const name = typeof group.name === 'string' && group.name.trim() !== '' ? group.name.trim() : id
    const members = Array.isArray(group.members) ? group.members.length : 0
    // 没有成员的组不可能出结果，进目录只会让用户在 /model 里选中一个必失败的模型。
    if (members === 0) continue
    out.push({
      provider: ROUTER_PROVIDER,
      id,
      name: `${name}（${members} 个候选）`,
      description: strategyText(group),
    })
  }
  return out
}

function strategyText(group) {
  const strategy = group?.strategy === 'fallback' ? '依次回退'
    : group?.strategy === 'least-used' ? '用量最少优先'
      : `轮流 · 每 ${Number(group?.stickyLimit) > 0 ? Math.trunc(Number(group.stickyLimit)) : 4} 次`
  const members = Array.isArray(group?.members) ? group.members.join(' → ') : ''
  return `${strategy}${members === '' ? '' : `：${members}`}`
}

/**
 * 为一次请求挑候选顺序（**会在请求开始时推进游标**）。
 *
 * @param {object} group
 * @param {object} state        `createRotationState()` 的结果
 * @param {object} [options]
 * @param {(memberId: string) => boolean} [options.exhausted]  今天已用满 → true
 * @returns {{ order: string[], skipped: string[] }}
 */
export function routerOrderFor(group, state, options = {}) {
  const order = rotationOrder(group, state, { usageOf: options.usageOf })
  const isOut = typeof options.exhausted === 'function' ? options.exhausted : () => false
  const skipped = []
  const usable = []
  for (const member of order) {
    const parsed = parseMember(member)
    // 指向自己的成员会让 stream 无限递归，直接当不可用。
    if (parsed === undefined || parsed.provider === ROUTER_PROVIDER) { skipped.push(member); continue }
    if (isOut(member) === true) { skipped.push(member); continue }
    usable.push(member)
  }
  return { order: usable, skipped }
}

/** 首个 chunk 就是失败终止 → 这个候选什么也没产出，可以换人。 */
export function isFailureFinish(chunk) {
  return chunk !== null
    && typeof chunk === 'object'
    && chunk.type === 'finish'
    && chunk.reason !== null
    && typeof chunk.reason === 'object'
    && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
}

/**
 * 轮换适配器。继承 `LlmAdapter` 只为拿到默认方法（`providerInfo` 等），
 * 真正被重写的是 `listModels` / `resolveModel` / `prepareCall` / `stream`。
 *
 * @param {object} deps
 * @param {object} deps.llm              `ctx.llm`（下游调用用）
 * @param {() => Array<object>} deps.groups      读当前轮换组
 * @param {object} deps.state           轮换游标（进程内）
 * @param {(memberId: string) => boolean} [deps.exhausted]
 * @param {(message: string) => void} [deps.warn]
 */
export function createRotationAdapter(deps) {
  const llm = deps.llm
  const groups = typeof deps.groups === 'function' ? deps.groups : () => []
  const state = deps.state ?? { cursors: {} }
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}
  const exhausted = typeof deps.exhausted === 'function' ? deps.exhausted : () => false
  /** 能力解析缓存：`buildModelCatalog` 每次刷新都会为每个模型查一次，别每次都打上游。 */
  const capabilityCache = new Map()

  function groupOf(model) {
    return groups().find(group => group?.id === model && group?.enabled !== false)
  }

  const adapter = new AdapterBase()
  adapter.providerInfo = provider => ({ id: provider, name: ROUTER_PROVIDER_NAME })

  adapter.listModels = () => Promise.resolve(buildRotationModels(groups()))

  adapter.resolveModel = async (provider, model, signal) => {
    const group = groupOf(model)
    if (group === undefined) {
      // 模型刚被删掉：目录已不列它，但旧会话仍可能带着它。给出一个可读条目，
      // 让请求走到 stream 里变成「没有可用候选」的明确失败，而不是 NO_ADAPTER。
      return { provider, id: model, name: model }
    }
    const base = { provider, id: model, name: `${group.name}（${group.members.length} 个候选）` }
    const capability = await describeGroup(group, { llm, warn, cache: capabilityCache, signal })
    return { ...base, ...capability }
  }

  adapter.prepareCall = async (provider, model, signal) => {
    const resolved = await adapter.resolveModel(provider, model, signal)
    return { model: resolved, stream: options => adapter.stream(options) }
  }

  adapter.stream = async function* stream(options) {
    const provider = String(options?.provider ?? ROUTER_PROVIDER)
    const model = String(options?.model ?? '')
    const group = groupOf(model)
    if (group === undefined) {
      yield failureChunk(`轮换组「${model}」不存在或已停用，请在账号中心重新选择`, options?.signal)
      return
    }
    const { order, skipped } = routerOrderFor(group, state, { exhausted })
    if (order.length === 0) {
      yield failureChunk(
        `轮换组「${group.name}」今天没有可用候选${skipped.length === 0 ? '' : `（${skipped.join('、')} 均已用满或不可用）`}`,
        options?.signal,
      )
      return
    }
    let last
    for (const member of order) {
      const parsed = parseMember(member)
      const downstream = { ...options, provider: parsed.provider, model: parsed.model }
      let produced = false
      try {
        for await (const chunk of llm.stream(downstream)) {
          if (!produced && isFailureFinish(chunk)) {
            last = chunk
            warn(`auth-hub: 轮换组「${group.name}」候选 ${member} 失败：${chunk.reason?.failure?.message ?? ''}`)
            break
          }
          produced = true
          yield chunk
        }
      } catch (error) {
        if (produced) throw error
        last = failureChunk(`${member}：${error instanceof Error ? error.message : String(error)}`, options?.signal)
        warn(`auth-hub: 轮换组「${group.name}」候选 ${member} 抛错：${String(error)}`)
        continue
      }
      if (produced) return
    }
    yield last ?? failureChunk(`轮换组「${group.name}」所有候选都失败`, options?.signal)
  }

  return adapter
}

/**
 * 把「组里第一个可用候选」的模型能力转述给上层。
 *
 * 为什么必须转述：`buildModelCatalog` 会为目录里每个模型调
 * `ctx.llm.resolveModelInfo()`，而 `LlmRuntime.normalizeModelInfo()` 会**校验**
 * 返回的结构 —— 只要抛错，整个 provider 分组就变成失败行，用户又会在 /model 里
 * 看不到轮换组。所以这里只透传**形状合法**的字段（context / reasoning /
 * defaultMaxTokens / inputModalities / systemPromptUpdate / toolUpdate），
 * 任何异常都退化为「没有额外能力」，绝不让目录失败。
 *
 * 为什么要转述而不是写死：轮换的候选通常是同一个模型的不同渠道，推断预算与
 * 推理档位应当与它们一致，否则选择器里会少一档 effort、或者被误判成纯文本。
 */
async function describeGroup(group, { llm, warn, cache, signal }) {
  const members = Array.isArray(group?.members) ? group.members : []
  const first = members.map(parseMember).find(parsed => parsed !== undefined && parsed.provider !== ROUTER_PROVIDER)
  if (first === undefined) return {}
  const key = `${first.provider}::${first.model}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  let capability = {}
  try {
    const info = await llm.resolveModelInfo(first.provider, first.model, signal)
    capability = sanitizeCapability(info)
  } catch (error) {
    // 「第一个候选暂时查不到」很常见（没登录 / 目录刚刷新）。不缓存失败：
    // 下次刷新还有机会拿到真实能力。
    warn?.(`auth-hub: 取 ${key} 的模型能力失败（按无额外能力处理）：${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
  cache.set(key, capability)
  return capability
}

/** 只保留 `normalizeModelInfo` 会校验的字段，并逐项兜住形状。 */
function sanitizeCapability(info) {
  const out = {}
  if (info === null || typeof info !== 'object') return out
  const window = Number(info.context?.contextWindow)
  if (Number.isInteger(window) && window > 0) out.context = { contextWindow: window }
  const maxTokens = Number(info.defaultMaxTokens)
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) out.defaultMaxTokens = maxTokens
  if (Array.isArray(info.inputModalities) && info.inputModalities.length > 0) {
    out.inputModalities = [...info.inputModalities]
  }
  if (info.systemPromptUpdate === 'in-history') out.systemPromptUpdate = 'in-history'
  if (info.toolUpdate === 'in-history' || info.toolUpdate === 'addition-only') out.toolUpdate = info.toolUpdate
  const efforts = Array.isArray(info.reasoning?.efforts) ? info.reasoning.efforts : []
  const valid = efforts.filter(effort => typeof effort?.id === 'string' && effort.id !== '' && typeof effort?.name === 'string' && effort.name !== '')
  if (valid.length > 0) {
    const ids = new Set(valid.map(effort => effort.id))
    const fallback = typeof info.reasoning.defaultEffort === 'string' && ids.has(info.reasoning.defaultEffort)
      ? info.reasoning.defaultEffort
      : undefined
    out.reasoning = {
      efforts: valid.map(effort => ({
        id: effort.id,
        name: effort.name,
        ...typeof effort.description === 'string' ? { description: effort.description } : {},
      })),
      ...fallback === undefined ? {} : { defaultEffort: fallback },
    }
  }
  return out
}

function failureChunk(message, signal) {
  return {
    type: 'finish',
    reason: signal?.aborted === true
      ? { kind: 'aborted', failure: { code: 'ABORTED', message } }
      : { kind: 'error', failure: { code: 'ROTATION_EXHAUSTED', message } },
  }
}

/** 供诊断用：把「这次会怎么走」算出来而不推进游标。 */
export function previewRoute(group, state, options = {}) {
  const order = rotationOrder(group, state, { peek: true, usageOf: options.usageOf })
  const isOut = typeof options.exhausted === 'function' ? options.exhausted : () => false
  return order.map(member => {
    const parsed = parseMember(member)
    return {
      member,
      provider: parsed?.provider ?? '',
      model: parsed?.model ?? '',
      usable: parsed !== undefined && parsed.provider !== ROUTER_PROVIDER && isOut(member) !== true,
    }
  })
}

export { pickMember }
