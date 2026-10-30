/**
 * 签到渠道：**每天点一下就能领积分（或额度）的站点**，声明式配置。
 *
 * ## 为什么不直接往 pack.js 里加渠道
 *
 * 内置 channel-pack 的渠道全是「官方客户端」形态：浏览器授权 / 扫码 /
 * 设备码，拿 OAuth 令牌，协议各自定制（CodeBuddy 的 X-Conversation 头、ZCode
 * 的验证码、CodeArts 的 AK/SK…）。每加一个都要先逆向它的登录与请求，是以周计
 * 的活，而且逆向结果随时会随上游改版失效。
 *
 * 但「每日签到」这件事本身极其同质：
 *
 *     POST/GET  某个 URL（带 Cookie 或 Bearer）
 *     → 返回 JSON { code: 0, data: { reward: 20 } }
 *
 * 所以这里把它抽象成**一条 HTTP 模板 + 一组判定规则**：
 *
 *   - `url` / `method` / `body`：要打哪一发
 *   - `headers`：Cookie、Authorization、Referer 等（**单独存密钥文件**，不回显原文）
 *   - `success`：怎么算成功（`code` 等于 0 / 命中正则）
 *   - `already`：怎么算「今天已经签过」（多数站点返回 1001 / "已签到"）
 *   - `reward`：从哪个字段抠出奖励数额（记进积分台账）
 *
 * 于是「加一个新渠道」= 在设置页粘一条 cURL（浏览器开发者工具「Copy as cURL」），
 * 或者填四五个字段，**不需要改代码、不需要重启**。
 *
 * ## 与本插件其它部分的关系
 *
 * - 签到成功 → `recordCreditGrant()` 记进 `credit-usage.json` 的 `grants[]`，
 *   所以「领了又用掉」不会被算成 0 消耗（口径与渠道账号一致）。
 * - 这些渠道**不提供模型**，不进「按模型 / 轮换」目录——它们只负责领额度。
 *   模型侧请用内置账号渠道或 `drivers` 里那种 API Key 驱动。
 *
 * ## 密钥怎么存
 *
 * `headers` 全部当密钥：Cookie / Authorization / X-CSRF-Token 都算。配置里只留
 * **头的名字**（`headerNames`），值单独落 `checkin-secrets.json`。回显给界面时
 * 只给 `Cookie: a1b2…z9` 这种掩码——`/checkin` 的响应会进浏览器内存与 DevTools，
 * 回显原文等于把登录态交给每一个能开这个页面的人。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
export const CHECKIN_CHANNELS_FILE = 'checkin-channels.json'
export const CHECKIN_SECRETS_FILE = 'checkin-secrets.json'
export const CHECKIN_STATE_FILE = 'checkin-state.json'
export const CHECKIN_SETTINGS_FILE = 'checkin-settings.json'

/** 这些头的值永远不回显原文。 */
const SENSITIVE_HEADER = /^(cookie|authorization|proxy-authorization|x-api-key|api-key|x-csrf-token|x-xsrf-token|x-auth-token|token)$/i

const MAX_CHANNELS = 40
const MAX_BODY = 64 * 1024
const ID_PATTERN = /^[a-z][a-z0-9][a-z0-9-]{0,31}$/

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 渠道模板（「添加渠道」时选一个作为起点）。
 *
 * 这些**不是厂商预置**，而是四种最常见的签到形态。真正的 URL 与 Cookie 由用户
 * 从自己的浏览器里粘，因为每个站的接口路径都不一样，硬编码等于制造一堆坏掉的
 * 「预置」。
 *
 * 唯一的例外是 `newapi`：New API / One API 系（大量 AI 中转站）是**同一份开源
 * 代码**，签到端点固定在 `/api/user/checkin`，且要求 `New-Api-User` 头，所以
 * 这类站点可以只填域名。
 */
export const TEMPLATES = [
  {
    id: 'newapi',
    label: 'New API 系站点（AI 中转站 · 签到送额度）',
    hint: '**白嫖主力**：大量 AI 中转站用 New API / One API 部署，签到端点固定 POST {站点}/api/user/checkin，'
      + '成功返回 {success:true, data:{quota_awarded:N}}，已签到返回 {success:false, message:"今日已签到"}。'
      + '只需填域名，端点与判定规则自动生成（见「一键识别中转站」）。'
      + 'Cookie 从 F12 → Network 里任意 /api/ 请求的 Cookie 头复制；用户 ID 填站点账号设置里的数字（New-Api-User 头）。'
      + '⚠️ 新版 New API 的签到一起走 Cloudflare Turnstile，纯协议请求会被拦——见下面的「Turnstile」说明。',
    draft: {
      label: 'New API 站点签到',
      method: 'POST',
      url: '',
      contentType: 'application/json',
      body: '{}',
      headers: { Cookie: '', 'New-Api-User': '' },
      success: { jsonPath: 'success', equals: true },
      already: { bodyMatches: '已签到|已经签到|already' },
      // 字段名是 quota_awarded（见 model/checkin.go 的 Checkin.QuotaAwarded），
      // 不是 quota —— 写错只会让奖励永远记 0，而且不会有任何报错。
      reward: { jsonPath: 'data.quota_awarded' },
      rewardUnit: '额度',
      scheduleAt: '08:30',
    },
  },
  {
    id: 'cookie-get',
    label: '通用：Cookie + GET',
    hint: '最常见的一类。把签到接口的 URL 和 Cookie 头粘进来即可；判定默认「HTTP 2xx 就算成功」。',
    draft: {
      label: 'Cookie 签到',
      method: 'GET',
      url: '',
      contentType: '',
      body: '',
      headers: { Cookie: '' },
      success: {},
      already: { bodyMatches: '已签到|已经签到|重复签到|already' },
      reward: {},
      rewardUnit: '积分',
      scheduleAt: '08:30',
    },
  },
  {
    id: 'bearer-post',
    label: '通用：Bearer Token + POST JSON',
    hint: '接口用 Authorization: Bearer <token>。token 从站点的 localStorage / Cookie 里取。',
    draft: {
      label: 'Token 签到',
      method: 'POST',
      url: '',
      contentType: 'application/json',
      body: '{}',
      headers: { Authorization: 'Bearer ' },
      success: { jsonPath: 'code', equals: 0 },
      already: { jsonPath: 'code', equals: 1001 },
      reward: { jsonPath: 'data.reward' },
      rewardUnit: '积分',
      scheduleAt: '08:30',
    },
  },
  {
    id: 'form-post',
    label: '通用：表单 POST（application/x-www-form-urlencoded）',
    hint: '老式站点常用。body 写成 `a=1&b=2`，同时可能需要一个 X-CSRF-Token 头。',
    draft: {
      label: '表单签到',
      method: 'POST',
      url: '',
      contentType: 'application/x-www-form-urlencoded',
      body: '',
      headers: { Cookie: '' },
      success: {},
      already: { bodyMatches: '已签到|already' },
      reward: {},
      rewardUnit: '积分',
      scheduleAt: '08:30',
    },
  },
]

/** 模板 → 一条可编辑草稿（`headers` 只给空值，用户自己填）。 */
export function draftFromTemplate(templateId, takenIds = new Set()) {
  const template = TEMPLATES.find(row => row.id === templateId) ?? TEMPLATES[1]
  const base = 'checkin'
  let id = base
  let suffix = 2
  while (takenIds.has(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return {
    id,
    enabled: true,
    note: '',
    template: template.id,
    ...JSON.parse(JSON.stringify(template.draft)),
    headers: { ...template.draft.headers },
  }
}

/** 模板目录（界面「添加渠道」的下拉用）。 */
export function templateView() {
  return TEMPLATES.map(template => ({
    id: template.id,
    label: template.label,
    hint: template.hint,
    draft: JSON.parse(JSON.stringify(template.draft)),
  }))
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 判定规则规范化：只留认识的字段，且值必须是标量 / 字符串。 */
function normalizeRule(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const rule = {}
  const jsonPath = text(source.jsonPath)
  if (jsonPath !== '') rule.jsonPath = jsonPath.slice(0, 200)
  if (Object.hasOwn(source, 'equals')) {
    const value = source.equals
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') rule.equals = value
  }
  const bodyMatches = text(source.bodyMatches)
  if (bodyMatches !== '') rule.bodyMatches = bodyMatches.slice(0, 300)
  return rule
}

function normalizeHeaders(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    const name = text(key)
    // 头名不允许换行或冒号：那是把「值」注入成「新的头」的唯一途径。
    if (name === '' || /[\r\n:]/.test(name)) continue
    if (typeof value !== 'string') continue
    if (/[\r\n]/.test(value)) continue
    out[name] = value.trim().slice(0, 8192)
  }
  return out
}

/**
 * 规范化一条渠道配置（不含密钥）。
 *
 * 返回 `{ channel, problem }`：`problem` 非空表示这条被丢弃，界面据此告诉用户
 * 「哪一条、为什么」没加上，而不是让配置静默消失。
 */
export function normalizeChannel(raw, takenIds = new Set()) {
  if (raw === null || typeof raw !== 'object') return { problem: '不是一个对象' }
  const id = text(raw.id).toLowerCase()
  if (!ID_PATTERN.test(id)) return { problem: `id「${id}」不合法（小写字母开头，2-33 位，只含字母数字连字符）` }
  if (takenIds.has(id)) return { problem: `id「${id}」重复` }
  const url = text(raw.url)
  if (url === '') return { problem: `「${id}」缺少签到 URL` }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { problem: `「${id}」的 URL 不合法：${url}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { problem: `「${id}」只支持 http / https` }

  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(text(raw.method).toUpperCase())
    ? text(raw.method).toUpperCase()
    : 'POST'
  const body = typeof raw.body === 'string' ? raw.body.slice(0, MAX_BODY) : ''
  const time = text(raw.scheduleAt)
  const scheduled = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '08:30'

  return {
    channel: {
      id,
      label: (text(raw.label) || id).slice(0, 60),
      method,
      url: url.slice(0, 2048),
      contentType: text(raw.contentType).slice(0, 120),
      body: method === 'GET' || method === 'DELETE' ? '' : body,
      headerNames: Object.keys(normalizeHeaders(raw.headers)),
      success: normalizeRule(raw.success),
      already: normalizeRule(raw.already),
      reward: normalizeRule(raw.reward),
      rewardUnit: (text(raw.rewardUnit) || '积分').slice(0, 12),
      scheduleAt: scheduled,
      enabled: raw.enabled !== false,
      note: text(raw.note).slice(0, 300),
      template: text(raw.template).slice(0, 40) || undefined,
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : undefined,
    },
    headers: normalizeHeaders(raw.headers),
  }
}

/** 整份配置：逐条过滤，丢弃原因一并返回。 */
export function normalizeChannels(raw) {
  const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.channels) ? raw.channels : [])
  const takenIds = new Set()
  const channels = []
  const secrets = {}
  const problems = []
  for (const row of rows.slice(0, MAX_CHANNELS)) {
    const result = normalizeChannel(row, takenIds)
    if (result.channel === undefined) {
      problems.push(result.problem ?? '未知问题')
      continue
    }
    takenIds.add(result.channel.id)
    channels.push(result.channel)
    if (result.headers !== undefined && Object.keys(result.headers).length > 0) secrets[result.channel.id] = result.headers
  }
  return { channels, secrets, problems }
}

/**
 * 批量生成中转站草稿：一行一个域名。
 *
 * 为什么要这个：白嫖的人往往同时挂着五六个中转站，逐个点「添加」再填 Cookie
 * 是纯粹的手工活。这里允许一次性粘贴一整列域名，**共用同一份 Cookie 与用户 ID**
 * （同一个人在不同 New API 站上通常各有账号，所以也支持 `域名,用户ID` 的形式）。
 *
 * 输入格式（每行一条，空行与 `#` 注释跳过）：
 *
 *     api.example.com
 *     api.other.com,12345
 *     https://a.b.c,678,uid=1        ← 第三段及以后忽略
 *
 * @returns {{ drafts: Array<object>, problems: Array<{ line: number, text: string, problem: string }> }}
 */
export function parseSiteList(raw, { cookie = '', userId = '', takenIds = new Set() } = {}) {
  const text = typeof raw === 'string' ? raw : ''
  const drafts = []
  const problems = []
  const ids = new Set(takenIds)
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '' || line.startsWith('#')) continue
    // 逗号或空白分隔；域名本身不含空格，所以两种都收。
    const parts = line.split(/[,\s]+/).filter(part => part !== '')
    const origin = parts[0] ?? ''
    if (origin === '') continue
    if (drafts.length >= MAX_CHANNELS) {
      problems.push({ line: index + 1, text: line, problem: `超过上限 ${MAX_CHANNELS} 条` })
      continue
    }
    const ownUserId = /^\d{2,}$/.test(parts[1] ?? '') ? parts[1] : userId
    const draft = newApiDraft(origin, { cookie, userId: ownUserId, takenIds: ids })
    if (draft === undefined) {
      problems.push({ line: index + 1, text: line, problem: `不是合法域名：${origin}` })
      continue
    }
    ids.add(draft.id)
    drafts.push(draft)
  }
  return { drafts, problems }
}

/** 密钥表规范化：只保留仍然存在的渠道。 */
export function normalizeSecrets(raw, channels) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const live = new Set((Array.isArray(channels) ? channels : []).map(channel => channel.id))
  const out = {}
  for (const [id, headers] of Object.entries(source)) {
    if (!live.has(id)) continue
    const clean = normalizeHeaders(headers)
    if (Object.keys(clean).length > 0) out[id] = clean
  }
  return out
}

/** `sk-abcd…wxyz` 掩码。空值返回 `未配置`。 */
export function maskValue(value) {
  const raw = typeof value === 'string' ? value : ''
  if (raw === '') return ''
  if (raw.length <= 6) return '••••'
  return `${raw.slice(0, 3)}…${raw.slice(-3)}`
}

/**
 * 回显给界面的形状：**不带密钥原文**，只给每个敏感头的掩码。
 *
 * 非敏感头（Referer / Content-Type）照常回显，方便用户核对请求。
 */
export function channelView(channel, headers, state) {
  const all = headers !== null && typeof headers === 'object' ? headers : {}
  const headerHints = {}
  for (const [key, value] of Object.entries(all)) {
    headerHints[key] = SENSITIVE_HEADER.test(key) ? maskValue(value) : String(value).slice(0, 120)
  }
  const lastDay = typeof state?.lastDay === 'string' ? state.lastDay : ''
  const advice = stateAdvice(state)
  return {
    ...channel,
    headerHints,
    hasSecrets: Object.keys(all).length > 0,
    state: {
      lastDay,
      lastRunAt: Number(state?.lastRunAt) || 0,
      lastStatus: text(state?.lastStatus),
      lastMessage: text(state?.lastMessage).slice(0, 400),
      lastReward: Number(state?.lastReward) || 0,
      totalReward: Number(state?.totalReward) || 0,
      streak: Number(state?.streak) || 0,
      runs: Number(state?.runs) || 0,
      consecutiveErrors: Number(state?.consecutiveErrors) || 0,
      history: (Array.isArray(state?.history) ? state.history : []).slice(-14),
    },
    // 派生结论放在顶层：界面直接显示 `advice.text`，不必自己算「连续几天」。
    advice,
  }
}

/**
 * 简单 JSON Path：`data.list[0].reward`、`$.code`、`success`。
 * 取不到返回 undefined。
 *
 * 允许省略前导点的原因很实际：用户从接口文档抄字段名时写的是 `success` 而不是
 * `$.success`，两者都该能用；但如果**看起来像路径又解析不动**（`a..b`），就返回
 * undefined —— 静默当成「字段不存在」，比抛异常更适合判定场景。
 */
export function jsonPathGet(value, jsonPath) {
  const raw = text(jsonPath)
  if (raw === '') return undefined
  const withoutRoot = raw.startsWith('$') ? raw.slice(1) : raw
  const normalized = withoutRoot.startsWith('.') || withoutRoot.startsWith('[') ? withoutRoot : `.${withoutRoot}`
  const tokens = []
  const pattern = /\.([A-Za-z0-9_$-]+)|\[(\d+)\]/g
  let cursor = 0
  for (let match = pattern.exec(normalized); match !== null; match = pattern.exec(normalized)) {
    // 只接受紧邻的 token：`a..b` 这种中间有垃圾的路径直接判为非法。
    if (match.index !== cursor) return undefined
    cursor = match.index + match[0].length
    tokens.push(match[1] !== undefined ? match[1] : Number(match[2]))
  }
  if (cursor !== normalized.length) return undefined
  let current = value
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined
    current = current[token]
  }
  return current
}

/** 规则命中判定。没有给规则 → 不命中（调用方按「没规则就不管」处理）。 */
function ruleMatches(rule, { status, textBody, json }) {
  if (rule === null || typeof rule !== 'object' || Object.keys(rule).length === 0) return false
  if (rule.jsonPath !== undefined) {
    const actual = jsonPathGet(json, rule.jsonPath)
    if (actual === undefined) return false
    if (rule.equals === undefined) return true
    // 宽松比较：`0` 与 `"0"`、`true` 与 `"true"` 都算命中——上游各家的类型不统一。
    return String(actual) === String(rule.equals)
  }
  if (rule.bodyMatches !== undefined) {
    try {
      return new RegExp(rule.bodyMatches, 'i').test(textBody)
    } catch {
      return textBody.includes(rule.bodyMatches)
    }
  }
  return false
}

/** 从响应里抠奖励数额：先按 JSON 路径，再按正则捕获组 1。 */
function extractReward(rule, { textBody, json }) {
  if (rule === null || typeof rule !== 'object') return undefined
  if (rule.jsonPath !== undefined) {
    const value = jsonPathGet(json, rule.jsonPath)
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }
  if (rule.bodyMatches !== undefined) {
    try {
      const found = new RegExp(rule.bodyMatches, 'i').exec(textBody)
      const n = Number(found?.[1])
      return Number.isFinite(n) && n >= 0 ? n : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 判定一次签到的结果。
 *
 * 顺序是**先看「是否已经签过」再看「是否成功」**：绝大多数站点的重复签到时也会
 * 返回 HTTP 200 + `code: 1001`，如果先判成功就会把「已签到」误报成「签到成功」
 * 并重复记奖励。
 *
 * @param {object} channel  规范化后的渠道
 * @param {{ status: number, text: string }} response
 * @returns {{ ok: boolean, alreadyDone: boolean, reward?: number, message: string }}
 */
export function evaluateResponse(channel, response) {
  const status = Number(response?.status) || 0
  const textBody = typeof response?.text === 'string' ? response.text : ''
  let json
  try {
    json = textBody === '' ? undefined : JSON.parse(textBody)
  } catch {
    json = undefined
  }
  const context = { status, textBody, json }
  if (ruleMatches(channel?.already, context)) {
    return { ok: true, alreadyDone: true, message: '今天已经签过了' }
  }
  const hasSuccessRule = channel?.success !== null && typeof channel?.success === 'object' && Object.keys(channel.success ?? {}).length > 0
  if (status < 200 || status >= 300) {
    return { ok: false, alreadyDone: false, message: `HTTP ${status}：${textBody.slice(0, 200)}` }
  }
  if (hasSuccessRule && ruleMatches(channel.success, context) !== true) {
    return { ok: false, alreadyDone: false, message: `响应不符合成功规则：${textBody.slice(0, 200)}` }
  }
  const reward = extractReward(channel?.reward, context)
  return {
    ok: true,
    alreadyDone: false,
    ...reward === undefined ? {} : { reward },
    message: reward === undefined ? '签到成功' : `签到成功，奖励 ${reward}`,
  }
}

//#region cURL 解析
/**
 * 把浏览器「Copy as cURL」的内容拆成一条渠道草稿。
 *
 * 支持 bash 版（`-H 'k: v'`、`--data-raw '{"a":1}'`、反斜杠续行）与 Windows
 * cmd 版（`^` 续行、双引号）。之所以要做这一步：手抄 Cookie 与 body 极易出错，
 * 而「复制成 cURL」是一键的。
 *
 * @param {string} raw
 * @returns {{ draft?: object, problem?: string }}
 */
export function parseCurl(raw) {
  const source = typeof raw === 'string' ? raw : ''
  if (text(source) === '') return { problem: 'cURL 为空' }
  // 续行：bash 的 `\` 与 cmd 的 `^` 都折成空格。
  const flattened = source.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').replace(/\r?\n/g, ' ')
  const tokens = tokenize(flattened)
  if (tokens.length === 0) return { problem: 'cURL 无法解析' }
  let url = ''
  let method = ''
  const headers = {}
  let body = ''
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '-H' || token === '--header') {
      const value = tokens[index + 1] ?? ''
      index += 1
      const colon = value.indexOf(':')
      if (colon > 0) headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim()
      continue
    }
    if (token === '-X' || token === '--request') {
      method = (tokens[index + 1] ?? '').toUpperCase()
      index += 1
      continue
    }
    if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary' || token === '--data-urlencode') {
      body = tokens[index + 1] ?? ''
      index += 1
      continue
    }
    if (token === '-b' || token === '--cookie') {
      headers.Cookie = tokens[index + 1] ?? ''
      index += 1
      continue
    }
    if (token === '-u' || token === '--user') {
      index += 1
      continue
    }
    if (token === '-A' || token === '--user-agent') {
      headers['User-Agent'] = tokens[index + 1] ?? ''
      index += 1
      continue
    }
    if (token.startsWith('http://') || token.startsWith('https://')) {
      url = token
      continue
    }
    if (token === 'curl' || token === '-s' || token === '--compressed' || token === '-L' || token === '-k' || token === '--insecure') continue
  }
  if (url === '') return { problem: 'cURL 里找不到 URL' }
  const contentType = headers['Content-Type'] ?? headers['content-type'] ?? ''
  return {
    draft: {
      label: new URL(url).hostname,
      method: method !== '' ? method : (body !== '' ? 'POST' : 'GET'),
      url,
      contentType,
      body,
      headers,
      success: {},
      already: { bodyMatches: '已签到|已经签到|重复签到|already' },
      reward: {},
      rewardUnit: '积分',
      scheduleAt: '08:30',
    },
  }
}

/** 极简 shell tokenizer：处理单/双引号、反斜杠转义与 **ANSI-C `$'…'` 引号**。 */
function tokenize(source) {
  const tokens = []
  let current = ''
  let quote = ''
  /** ANSI-C 引号（`$'…'`）：里面的 `\n` 是**真换行**，与普通单引号不同。 */
  let ansiC = false
  let started = false
  const ANSI_ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' }
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== '') {
      if (char === '\\' && index + 1 < source.length) {
        const next = source[index + 1]
        if (ansiC) {
          current += Object.hasOwn(ANSI_ESCAPES, next) ? ANSI_ESCAPES[next] : next
          index += 1
          continue
        }
        // bash 的双引号里只对这四类字符做转义；其余保留反斜杠本身（`\$`、`\"`、`\\`、`` \` ``）。
        if (quote === '"' && (next === '"' || next === '\\' || next === '$' || next === '`')) {
          current += next
          index += 1
          continue
        }
        if (quote === "'") { current += char; continue }
        current += next === 'n' ? '\n' : next
        index += 1
        continue
      }
      if (char === quote) {
        quote = ''
        ansiC = false
        continue
      }
      current += char
      continue
    }
    // `$'…'` 是 Chrome「Copy as cURL (bash)」在 body 含引号/换行时的默认形态，
    // 不认这个前缀就会把 `$` 一起吞进 body，请求体直接变成非法 JSON。
    if (char === '$' && source[index + 1] === "'") {
      quote = "'"
      ansiC = true
      started = true
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}
//#endregion

//#region New API / One API 站点识别（「白嫖」主力的自动化）
/**
 * New API 系站点的探针清单。
 *
 * 为什么值得单独做：AI 中转站绝大多数跑的是同一份开源代码（New API 或它的前身
 * One API），它们的**签到协议完全一致**——`POST /api/user/checkin`，成功
 * `{success:true,data:{quota_awarded}}`，重复签到 `{success:false,message:"今日已签到"}`。
 * 唯一需要用户提供的是域名 + Cookie + 自己那串数字用户 ID。
 *
 * 所以「加一个中转站」不该是填十几个字段，而应该是**填域名就好**。
 *
 * ⚠️ `sign_in` 是另一套（AnyRouter 系）的端点，有些站两个都挂了；这里都探一遍，
 * 谁先返回「像个签到响应」就用谁。
 */
export const NEWAPI_SIGN_PATHS = ['/api/user/checkin', '/api/user/sign_in']
/** 只用来判断「这是不是一台 New API」，不发任何会改变状态的请求。 */
export const NEWAPI_PROBE_PATHS = ['/api/status', '/api/about']

/** 判断一个响应体像不像 New API 的签到结果。 */
export function looksLikeNewApiCheckin(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return false
  // 成功：{success:true, message:"签到成功", data:{quota_awarded, checkin_date}}
  if (json.success === true && json.data !== null && typeof json.data === 'object') {
    return Object.hasOwn(json.data, 'quota_awarded') || Object.hasOwn(json.data, 'checkin_date')
  }
  // 已签到 / 未启用 / 参数错：{success:false, message:"今日已签到"}
  if (json.success === false && typeof json.message === 'string') return true
  return false
}

/** 判断响应体像不像「这台站是 New API」（`/api/status` 会回系统名与版本）。 */
export function looksLikeNewApiSite(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return false
  const data = json.data !== null && typeof json.data === 'object' ? json.data : json
  const name = `${data.system_name ?? ''} ${data.name ?? ''} ${data.version ?? ''}`.toLowerCase()
  return /new[\s-]?api|one[\s-]?api/.test(name)
}

/**
 * 域名规范化：只接受「裸域名 / 带协议的 origin」，拒绝路径、空格、怪符号。
 *
 * `new URL()` 比这里宽松得多：`new URL('https://bad~~~/x')` 是合法的（主机名里的
 * `~` 会被接受）。所以这里额外用一条 hostname 正则兜住，否则批量导入会把一堆
 * 敲错的域名当成正常站点写进去——保存成功、签到永远失败，还查不出为什么。
 *
 * @returns {string|undefined} 规整后的 origin（含协议），非法时 undefined。
 */
export function normalizeOrigin(origin) {
  const raw = text(origin)
  if (raw === '') return undefined
  // 本机地址默认 http：`127.0.0.1:8080` / `localhost:3000` 这类十有八九是自建
  // 服务，套上 https 只会连不上（而报错是笼统的「证书错误」）。
  const looksLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw)
  const scheme = looksLocal ? 'http' : 'https'
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `${scheme}://${raw}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const host = parsed.hostname
  // 允许：域名（含子域、连字符）、IPv4、[IPv6]、以及 localhost。
  const validHost = /^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]|([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/i.test(host)
  if (!validHost) return undefined
  return parsed.origin
}

/**
 * 从一个域名生出一条 New API 渠道草稿。
 *
 * `origin` 允许用户只粘 `api.example.com` 或整条 URL；这里统一成 origin。
 * 用户 ID 为空时**照样生成**（有些站不校验该头，或者用 Access Token 鉴权），
 * 但会在 note 里留一句提示——比直接拒绝好，能先跑通再补。
 */
export function newApiDraft(origin, { userId = '', cookie = '', takenIds = new Set(), signPath } = {}) {
  const base = normalizeOrigin(origin)
  if (base === undefined) return undefined
  const path = typeof signPath === 'string' && signPath !== '' ? signPath : '/api/user/checkin'
  const headers = { Cookie: cookie }
  if (userId !== '') headers['New-Api-User'] = String(userId)
  const label = base.replace(/^https?:\/\//, '')
  const baseId = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'newapi'
  let id = baseId
  let suffix = 2
  while (takenIds.has(id)) { id = `${baseId}-${suffix}`; suffix += 1 }
  return {
    id,
    label,
    enabled: true,
    note: userId === '' ? '未填用户 ID：多数 New API 站需要 New-Api-User 头，签到会 401' : '',
    template: 'newapi',
    method: 'POST',
    url: `${base}${path}`,
    contentType: 'application/json',
    body: '{}',
    headers,
    success: { jsonPath: 'success', equals: true },
    already: { bodyMatches: '已签到|已经签到|重复签到|already' },
    reward: { jsonPath: 'data.quota_awarded' },
    rewardUnit: '额度',
    scheduleAt: '08:30',
    // 额外字段（不进规范化后的配置，只给界面展示与后续探测用）
    siteOrigin: base,
  }
}

/**
 * 从 cURL 里顺手把 New-Api-User 抠出来。
 *
 * 这一步的价值：用户从浏览器复制签到请求时会天然带上这个头，但手抄到表单里
 * 很容易漏——漏了就是每个接口都 401，而报错信息完全不会提示「你少了这个头」。
 */
export function pickNewApiUser(headers) {
  const source = headers !== null && typeof headers === 'object' ? headers : {}
  for (const [name, value] of Object.entries(source)) {
    if (name.toLowerCase() !== 'new-api-user') continue
    const clean = String(value).trim()
    // 官方提示：负数或个位数通常是「未登录」时页面自己塞的占位值。
    return /^\d{2,}$/.test(clean) ? clean : ''
  }
  return ''
}
//#endregion

//#region 存储与调度
export function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonFile(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
  return value
}

/** 签到设置：自动开关 + 默认时间。 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const at = text(source.at)
  const retry = Number(source.retryMinutes)
  return {
    auto: source.auto !== false,
    at: /^([01]\d|2[0-3]):[0-5]\d$/.test(at) ? at : '08:30',
    // 开机补签：进程刚起来时如果今天还没签，立刻补一次（无需等到点）。
    catchUpOnStart: source.catchUpOnStart !== false,
    // 失败重试间隔（分钟）。0 = 当天不再重试。
    //
    // 为什么默认要重试：签到失败最常见的原因是**网络抖一下**（DNS、超时、站点
    // 502），而不是 Cookie 过期。这两种在响应体上分不开，但代价差得很远——
    // 不重试等于抖一次就白丢一整天的额度。3 次、30 分钟一次，一天的窗口足够。
    retryMinutes: Number.isFinite(retry) && retry >= 0 ? Math.min(Math.trunc(retry), 360) : 30,
    // 每个渠道每天最多执行几次（含首次）。上限存在的意义是别把过期 Cookie 打成刷单。
    maxAttemptsPerDay: (() => {
      const n = Number(source.maxAttemptsPerDay)
      return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 10) : 3
    })(),
  }
}

/** 某一刻的 UTC+8「HH:MM」。 */
export function utc8Clock(nowMs = Date.now()) {
  const shifted = new Date(nowMs + 8 * 3600e3)
  const pad = part => String(part).padStart(2, '0')
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}

export function utc8Day(nowMs = Date.now()) {
  const shifted = new Date(nowMs + 8 * 3600e3)
  const pad = part => String(part).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/**
 * 现在该不该自动签。
 *
 * 判据：
 *   1. 渠道启用；
 *   2. UTC+8 已过该渠道的 `scheduleAt`；
 *   3. **还没拿到结果**——注意「拿到结果」不等于「lastDay 是今天」：
 *      失败也算执行过，但**不算拿到结果**，所以要在当天晚些时候重试。
 *
 * 第 3 条是修掉的一个真实缺陷：早先只看 `lastDay === 今天`，于是一次网络抖动
 * 就会把当天标记成「已处理」，之后整天不再重试——用户看到的是「今天没签上」，
 * 而实际只是第一次请求超时了。
 *
 * 重试的节奏由 `settings.retryMinutes` 与 `settings.maxAttemptsPerDay` 控制；
 * 成功（含「已签到」）之后当天立刻不再跑。
 */
export function isDue(channel, state, nowMs = Date.now(), settings = undefined) {
  if (channel?.enabled === false) return false
  const day = utc8Day(nowMs)
  const at = text(channel?.scheduleAt) || '00:00'
  if (utc8Clock(nowMs) < at) return false
  // 今天已经拿到结果（签到成功 / 已签到）→ 不再跑。
  if (state?.lastDay === day && state?.lastStatus !== 'error') return false
  // 今天没跑过 → 到点就跑。
  if (state?.lastDay !== day) return true
  // 今天跑过但失败了 → 按重试间隔与次数上限决定还跑不跑。
  const retryMinutes = Number(settings?.retryMinutes)
  const gapMs = (Number.isFinite(retryMinutes) && retryMinutes >= 0 ? retryMinutes : 30) * 60_000
  if (gapMs === 0) return false
  const maxAttempts = Number(settings?.maxAttemptsPerDay)
  const lastRunAt = Number(state?.lastRunAt) || 0
  // ⚠️ `attemptsDay` 是 `YYYY-MM-DD` 字符串，**不能** `Number()` 它（会得到 NaN，
  // 于是「上限」永远算成 0 次、重试永远放行、而界面上看起来一切正常）。
  const attemptsToday = String(state?.attemptsDay ?? '') === day ? (Number(state?.attempts) || 0) : 0
  if (attemptsToday >= (Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 3)) return false
  return nowMs - lastRunAt >= gapMs
}

/**
 * 把一次执行结果并入状态（连续天数按「昨天签过」判断）。
 *
 * 除了「今天签没签」，还记两件**为了白嫖体验**必须留的东西：
 *
 *   - `history`：最近 N 天的结果，用来画「这个站这周给了多少 / 断了哪几天」。
 *     只看 `totalReward` 的话，一个静默失败三天的渠道跟正常渠道长得一模一样。
 *   - `consecutiveErrors`：连续失败次数。Cookie 过期是常态（几天到几周），
 *     界面据此把「今天失败」升级成「已经连续失败 3 天，Cookie 大概过期了」。
 *
 * 历史按天去重（同一天多次 force 重签只保留最后一条），最多留 30 天。
 */
export function nextState(previous, result, { day, nowMs }) {
  const prev = previous !== null && typeof previous === 'object' ? previous : {}
  const yesterday = utc8Day(nowMs - 864e5)
  const wasYesterday = prev.lastDay === yesterday
  const reward = Number(result?.reward) || 0
  const ok = result?.ok === true
  const counted = ok && result?.alreadyDone !== true
  const status = ok ? (result.alreadyDone === true ? 'already' : 'ok') : 'error'

  const history = []
  for (const row of Array.isArray(prev.history) ? prev.history : []) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.day !== 'string' || row.day === day) continue
    history.push({
      day: row.day,
      status: typeof row.status === 'string' ? row.status : 'unknown',
      reward: Number(row.reward) || 0,
    })
  }
  history.push({ day, status, reward: counted ? reward : 0 })
  // 只留最近 30 天（按日期字符串排序即可，格式是定长的 YYYY-MM-DD）。
  history.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  while (history.length > 30) history.shift()

  return {
    lastDay: day,
    lastRunAt: nowMs,
    lastStatus: status,
    lastMessage: String(result?.message ?? '').slice(0, 400),
    lastReward: reward,
    totalReward: Math.round(((Number(prev.totalReward) || 0) + (counted ? reward : 0)) * 100) / 100,
    streak: counted ? (wasYesterday ? (Number(prev.streak) || 0) + 1 : 1) : (Number(prev.streak) || 0),
    runs: (Number(prev.runs) || 0) + 1,
    // 连续失败次数：成功（含「已签到」）立刻清零，失败才累加。
    consecutiveErrors: ok ? 0 : (Number(prev.consecutiveErrors) || 0) + 1,
    // 当天尝试次数：`isDue` 靠它实现「失败后隔一会儿再试，但一天最多试 N 次」。
    attemptsDay: day,
    attempts: (String(prev.attemptsDay ?? '') === day ? (Number(prev.attempts) || 0) : 0) + 1,
    history,
  }
}

/**
 * 把状态压成界面要的两个派生结论。
 *
 * 「连续失败几天」比「上次失败」有用得多：Cookie 过期的第一条线索就是它，
 * 而单个 error 谁都可能偶发一次（站点抖一下）。
 */
export function stateAdvice(state) {
  const errors = Number(state?.consecutiveErrors) || 0
  const history = Array.isArray(state?.history) ? state.history : []
  const week = history.slice(-7)
  const weekReward = Math.round(week.reduce((sum, row) => sum + (Number(row.reward) || 0), 0) * 100) / 100
  const weekSigned = week.filter(row => row.status === 'ok' || row.status === 'already').length
  if (errors >= 3) {
    return { level: 'error', text: `已连续 ${errors} 天失败，Cookie 多半过期了——重新复制一次`, weekReward, weekSigned }
  }
  if (errors > 0) return { level: 'warn', text: `上次失败（连续 ${errors} 次）`, weekReward, weekSigned }
  if (weekSigned === 0) return { level: 'muted', text: '最近 7 天没有成功记录', weekReward, weekSigned }
  return { level: 'ok', text: `最近 7 天签了 ${weekSigned} 次`, weekReward, weekSigned }
}
//#endregion
