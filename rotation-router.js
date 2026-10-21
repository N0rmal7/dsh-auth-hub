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

/**
 * 语义档位：把各渠道五花八门的 effort id 归一到同一把尺子上。
 *
 * 为什么需要：账号渠道对「思考档位」的命名完全不统一——CodeArts 只有
 * `on` / `off` 两个开关，buddy / workbuddy 用的是 `low` / `medium` / `high` /
 * `xhigh` / `max`，还有的渠道用 `minimal`、`balanced`。轮换组把同一模型的多个
 * 渠道并在一起后，**会话里只存了一个 effort id**（由组的首选候选的能力表决定），
 * 转发给另一个候选时它未必认识——DSH 的 `resolveCallConfig` 明确写着
 * 「no clamping or aliasing is performed」，不认识的档位会在打上游之前直接抛
 * `provider "x" model "y" does not support reasoning effort "z"`。
 * 所以转发前必须自己把档位翻译成目标渠道认识的 id（见 `chooseEffort`）。
 */
const EFFORT_RANKS = [
  { rank: 0, ids: ['off', 'none', 'disabled', 'disable', 'no', 'closed'] },
  { rank: 1, ids: ['minimal', 'min', 'tiny'] },
  { rank: 2, ids: ['low', 'light'] },
  { rank: 3, ids: ['medium', 'mid', 'balanced', 'normal', 'standard'] },
  { rank: 4, ids: ['high', 'on', 'default', 'auto', 'enabled', 'open'] },
  { rank: 5, ids: ['xhigh', 'extra-high', 'very-high'] },
  { rank: 6, ids: ['max', 'maximum', 'ultra', 'highest'] },
]
const EFFORT_RANK_BY_ID = new Map()
for (const row of EFFORT_RANKS) for (const id of row.ids) EFFORT_RANK_BY_ID.set(id, row.rank)

/** effort id → 语义档位（0=关，6=最高）；未知 id 返回 undefined。 */
export function effortRank(id) {
  if (typeof id !== 'string') return undefined
  return EFFORT_RANK_BY_ID.get(id.trim().toLowerCase())
}

/** 候选模型能力表的缓存时长（登录 / 目录刷新后能力会变，不能永久缓存）。 */
const EFFORT_CACHE_TTL_MS = 5 * 60 * 1000

/** 整组能力并集的缓存时长（同上：账号登录状态变化会改变候选的模型能力）。 */
const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * 目标候选**声明**的 effort id 列表（`undefined` 表示未知 / 查询失败）。
 *
 * 用 `llm.resolveModelInfo`（与 `buildModelCatalog` 同一个入口），因此拿到的
 * 就是 DSH 校验时会用的那份能力表——两边绝不会各说各话。
 */
async function declaredEfforts(llm, parsed, cache, signal) {
  const key = `${parsed.provider}::${parsed.model}`
  const now = Date.now()
  const cached = cache.get(key)
  if (cached !== undefined && now - cached.at < EFFORT_CACHE_TTL_MS) return cached.meta
  if (typeof llm?.resolveModelInfo !== 'function') {
    cache.set(key, { at: now, meta: { ids: undefined, defaultEffort: undefined } })
    return cache.get(key).meta
  }
  let meta
  try {
    const info = await llm.resolveModelInfo(parsed.provider, parsed.model, signal)
    const ids = Array.isArray(info?.reasoning?.efforts)
      ? info.reasoning.efforts.map(effort => (typeof effort?.id === 'string' ? effort.id : '')).filter(id => id !== '')
      : []
    const defaultEffort = typeof info?.reasoning?.defaultEffort === 'string' ? info.reasoning.defaultEffort : undefined
    meta = { ids, defaultEffort }
  } catch {
    // 「候选暂时查不到能力」很常见（没登录 / 目录刚刷新）。不缓存失败：
    // 下次请求还有机会拿到真实能力，而本次按「未知」处理——见 chooseEffort。
    return { ids: undefined, defaultEffort: undefined }
  }
  cache.set(key, { at: now, meta })
  return meta
}

/**
 * 把会话里的 effort 映射成目标候选能接受的 id。
 *
 * @param {string} requested            会话当前保存的 effort id
 * @param {{ids?: string[], defaultEffort?: string}} meta  目标候选声明的档位
 * @returns {string|undefined}  目标认识的 id；`undefined` = 目标不支持推理，
 *                              调用方应把 `reasoningEffort` 去掉（走它的默认）
 */
export function chooseEffort(requested, meta) {
  if (typeof requested !== 'string' || requested === '') return undefined
  const ids = Array.isArray(meta?.ids) ? meta.ids : []
  if (ids.length === 0) return undefined
  if (ids.includes(requested)) return requested
  const want = effortRank(requested)
  const ranked = ids.map(id => ({ id, rank: effortRank(id) })).filter(row => row.rank !== undefined)
  if (want === undefined || ranked.length === 0) {
    // id 不认识（渠道自定义方言）：退回目标自己的默认档，再不行取第一个。
    return meta.defaultEffort ?? ids[0]
  }
  // 距离最近者优先；同距离优先更低档（宁可少花推理预算，也不要报错）。
  ranked.sort((a, b) => (Math.abs(a.rank - want) - Math.abs(b.rank - want)) || (a.rank - b.rank))
  return ranked[0].id
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
  /** 每个候选各自声明的 effort 档位（转发前做档位翻译用，带 TTL）。 */
  const effortCache = new Map()

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
    const requestedEffort = typeof options?.reasoningEffort === 'string' && options.reasoningEffort !== ''
      ? options.reasoningEffort
      : undefined
    for (const member of order) {
      const parsed = parseMember(member)
      const downstream = { ...options, provider: parsed.provider, model: parsed.model }
      // 档位翻译：会话里存的 effort 来自**组的首选候选**，换到别的候选时它未必认识
      // （典型：组首是 buddy 的 high，轮到 CodeArts 只有 on/off → DSH 在打上游之前
      // 就抛 UNSUPPORTED_REASONING_EFFORT）。这里按目标候选的能力表翻译；
      // 目标不支持推理时直接去掉该字段，让下游走自己的默认。
      if (requestedEffort !== undefined) {
        const meta = await declaredEfforts(llm, parsed, effortCache, options?.signal)
        const adapted = chooseEffort(requestedEffort, meta)
        if (adapted === undefined) delete downstream.reasoningEffort
        else if (adapted !== requestedEffort) downstream.reasoningEffort = adapted
      }
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
 * 把**整组候选**的模型能力合并后转述给上层。
 *
 * 为什么必须转述：`buildModelCatalog` 会为目录里每个模型调
 * `ctx.llm.resolveModelInfo()`，而 `LlmRuntime.normalizeModelInfo()` 会**校验**
 * 返回的结构 —— 只要抛错，整个 provider 分组就变成失败行，用户又会在 /model 里
 * 看不到轮换组。所以这里只透传**形状合法**的字段（context / reasoning /
 * defaultMaxTokens / inputModalities / systemPromptUpdate / toolUpdate），
 * 任何异常都退化为「没有额外能力」，绝不让目录失败。
 *
 * 为什么是**并集**而不是「第一个候选」：DSH 会在**调用适配器之前**拿这份能力表
 * 校验会话里保存的 `reasoningEffort`，不匹配就抛 `UNSUPPORTED_REASONING_EFFORT`
 * （`provider "auth-hub" …`）——这时请求还没走到 `stream()`，转发前的档位翻译
 * 根本没机会执行。用户把组首从 buddy 改成 codearts 后，会话里存的 `high` 就会
 * 被路由层直接拒掉。所以这里对 effort 取**所有候选的并集**：只要有一个候选认识
 * 这个 id，它就继续合法；真正发出时再由 `chooseEffort` 翻译成目标候选的档位。
 */
async function describeGroup(group, { llm, warn, cache, signal }) {
  const members = Array.isArray(group?.members) ? group.members : []
  const parsed = members
    .map(parseMember)
    .filter(member => member !== undefined && member.provider !== ROUTER_PROVIDER)
  if (parsed.length === 0) return {}
  // 缓存键必须包含**全部成员**：组的成员一变（增删 / 调整顺序），能力并集就变了。
  const key = `${group?.id ?? ''}::${parsed.map(member => member.id).join('|')}`
  const now = Date.now()
  const cached = cache.get(key)
  if (cached !== undefined && now - cached.at < CAPABILITY_CACHE_TTL_MS) return cached.capability
  const infos = []
  // 上限只为防呆（组里塞几十个候选时别在启动目录上打几十次上游查询）。
  for (const member of parsed.slice(0, 8)) {
    try {
      infos.push(await llm.resolveModelInfo(member.provider, member.model, signal))
    } catch (error) {
      // 「某个候选暂时查不到」很常见（没登录 / 目录刚刷新）——只跳过它，
      // 其余候选的能力照样合并；一个都拿不到时**不缓存**，下次刷新还有机会。
      warn?.(`auth-hub: 取 ${member.id} 的模型能力失败（按无额外能力处理）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const capability = mergeCapabilities(infos)
  // 能力会随登录状态 / 远端目录变化（例如账号刚登录后模型才出现），
  // 所以缓存带 TTL，不做成永久的。
  if (infos.length > 0) cache.set(key, { at: now, capability })
  return capability
}

/**
 * 合并整组候选的能力，得到一份「不会误拒任何已保存配置」的对外声明。
 *
 * - 推理档位：**并集**（按候选顺序，id 完全相同的去重）。默认档取第一个
 *   候选声明且仍在并集里的那个。
 * - 上下文窗口 / 默认输出上限：取**最小**的已知值，不夸大任何一个候选。
 * - 输入模态：**并集**。某个候选不吃图时，发过去会由它自己报
 *   `UNSUPPORTED_CONTENT`，路由再回退下一个候选——不因为组里混进纯文本渠道
 *   就把整个组的看图能力关掉。
 * - `systemPromptUpdate` / `toolUpdate`：所有候选一致才透传，否则交给 DSH 默认。
 */
function mergeCapabilities(infos) {
  const caps = infos.map(sanitizeCapability)
  const out = {}
  const windows = caps.map(cap => cap.context?.contextWindow).filter(window => Number.isInteger(window) && window > 0)
  if (windows.length > 0) out.context = { contextWindow: Math.min(...windows) }
  const maxTokens = caps.map(cap => cap.defaultMaxTokens).filter(value => Number.isSafeInteger(value) && value > 0)
  if (maxTokens.length > 0) out.defaultMaxTokens = Math.min(...maxTokens)
  const modalities = []
  for (const cap of caps) {
    for (const modality of Array.isArray(cap.inputModalities) ? cap.inputModalities : []) {
      if (!modalities.includes(modality)) modalities.push(modality)
    }
  }
  if (modalities.length > 0) out.inputModalities = modalities
  for (const field of ['systemPromptUpdate', 'toolUpdate']) {
    const values = caps.map(cap => cap[field]).filter(value => typeof value === 'string')
    if (values.length > 0 && values.every(value => value === values[0])) out[field] = values[0]
  }
  const efforts = []
  const seen = new Set()
  let defaultEffort
  for (const cap of caps) {
    for (const effort of cap.reasoning?.efforts ?? []) {
      if (seen.has(effort.id)) continue
      seen.add(effort.id)
      efforts.push(effort)
    }
    if (defaultEffort === undefined && typeof cap.reasoning?.defaultEffort === 'string' && seen.has(cap.reasoning.defaultEffort)) {
      defaultEffort = cap.reasoning.defaultEffort
    }
  }
  if (efforts.length > 0) {
    out.reasoning = { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
  }
  return out
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
