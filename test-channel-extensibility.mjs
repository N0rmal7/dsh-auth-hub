// 核心验收：证明「host 多注册一个渠道 → 界面自动出现」这条链路成立。
//
// 不启动真实 DSH，而是用「源码契约 + 端到端数据流模拟」证明：
//   1. host 侧 platform.list 返回 modelAdapters 的键（改 modelAdapters 即改清单）
//   2. client 侧 buildPlatforms 对任意新 provider 都能生成可渲染对象
//   3. 全链路无写死的渠道名（client 不再有 CHANNEL_PLATFORMS）
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const packSrc = readFileSync('vendor/channel-pack/pack.js', 'utf8')
const clientSrc = readFileSync('client.js', 'utf8')

let pass = 0
const fails = []
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push([name, e.message]); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

// ── 取出 client 的映射函数 ──────────────────────────────────────────
const sliceDecl = (src, startMarker, nextMarkers) => {
  const s = src.indexOf(startMarker)
  assert.ok(s >= 0, `未找到 ${startMarker}`)
  let end = src.length
  for (const m of nextMarkers) {
    const i = src.indexOf(m, s + startMarker.length)
    if (i > s && i < end) end = i
  }
  return src.slice(s, end)
}
const factory = new Function(`
  ${sliceDecl(clientSrc, 'const PLATFORM_APPEARANCE = {', ['const fallbackPlatform ='])}
  ${sliceDecl(clientSrc, 'const fallbackPlatform = provider =>', ['const buildPlatforms ='])}
  ${sliceDecl(clientSrc, 'const buildPlatforms = providers =>', ['const FALLBACK_PLATFORMS'])}
  ${sliceDecl(clientSrc, 'const FALLBACK_PLATFORMS = buildPlatforms([', ['const WORKBUDDY_CHANNELS'])}
  return { PLATFORM_APPEARANCE, fallbackPlatform, buildPlatforms, FALLBACK_PLATFORMS }
`)
const { PLATFORM_APPEARANCE, buildPlatforms } = factory()

console.log('=== 1. 模拟「新增一个渠道」的完整链路 ===')

// 这是本轮最有意义的断言：假设 host 注册了 3 个新渠道，
// client 是否不需要任何改动就能渲染它们？
const NEW_CHANNELS = ['kimicode', 'commandcode', 'supergrok']

check('host 注册的新渠道能被 client 渲染（零改动）', () => {
  const providers = ['gemini', ...NEW_CHANNELS, 'zcode']
  const platforms = buildPlatforms(providers)
  assert.equal(platforms.length, providers.length, '不能有渠道被吞掉')
  for (const p of platforms) {
    assert.equal(typeof p.provider, 'string')
    assert.equal(typeof p.label, 'string')
    assert.ok(p.label.length > 0, `${p.provider} 的 label 不能为空`)
    assert.equal(typeof p.hint, 'string')
  }
  console.log(`      → 渲染出 ${platforms.length} 个: ${platforms.map(p => p.label).join(', ')}`)
})

check('新渠道被标记为 unknown（UI 可据此提示「第三方」）', () => {
  const platforms = buildPlatforms(NEW_CHANNELS)
  assert.ok(platforms.every(p => p.unknown === true), '未在字典里的渠道应标记 unknown')
})

check('已知渠道不被标记 unknown', () => {
  const platforms = buildPlatforms(['gemini', 'codearts'])
  assert.ok(platforms.every(p => p.unknown === undefined))
})

check('host 返回空清单时 client 不崩（保留兜底逻辑在上层）', () => {
  assert.deepEqual(buildPlatforms([]), [])
})

console.log('\n=== 2. host 侧：改 modelAdapters 就等于改清单 ===')

check('platform.list 用 providerIdsOf 而非裸 Object.keys（第三方可见）', () => {
  const s = packSrc.indexOf('case "platform.list":')
  const block = packSrc.slice(s, packSrc.indexOf('case "model.list":'))
  assert.match(block, /providerIdsOf/, '必须复用 providerIdsOf（优先 llm.listProviders）')
  assert.match(block, /const pool = Object\.keys\(modelAdapters/, '账号池渠道仍以 modelAdapters 为准')
  assert.match(block, /others/, '必须区分出第三方 provider')
})

check('platform.list 返回 pool 与 others 两类（不混为一个数组）', () => {
  const s = packSrc.indexOf('case "platform.list":')
  const block = packSrc.slice(s, packSrc.indexOf('case "model.list":'))
  assert.match(block, /value:\s*\{\s*providers:\s*pool,\s*pool,\s*others\s*\}/,
    '返回结构应为 { providers, pool, others }')
})

check('新增渠道只需在 modelAdapters 加一行（无其它同步点）', () => {
  // 验证 client 里没有任何地方再罗列渠道名做校验
  const suspicious = [
    /provider\s*===\s*['"](workbuddy|buddy|codearts|gemini)['"]/g,
  ]
  for (const re of suspicious) {
    const found = [...clientSrc.matchAll(re)].map(m => m[0])
    // WorkBuddy 专属分区允许有特判（它是独立卡片），其余不该有
    const nonWb = found.filter(s => !/workbuddy|buddy/.test(s))
    assert.deepEqual(nonWb, [], `client 里仍有渠道名硬编码: ${nonWb.join(', ')}`)
  }
})

console.log('\n=== 3. 兜底清单与实际渠道一致性 ===')

check('兜底清单每一项都在 modelAdapters 里', () => {
  const m = packSrc.match(/const modelAdapters = \{([\s\S]*?)\n  \};/)
  const body = m[1]
  const missing = []
  for (const [provider] of Object.entries(PLATFORM_APPEARANCE)) {
    if (provider === 'opencode') continue // 条件注册，默认禁用
    if (!new RegExp(`\\b${provider}\\s*:\\s*pruned\\(`).test(body)) missing.push(provider)
  }
  assert.deepEqual(missing, [], `外观字典含 host 未注册的渠道: ${missing.join(', ')}`)
})

check('modelAdapters 的每个渠道都有外观定义（否则显示成 id）', () => {
  const m = packSrc.match(/const modelAdapters = \{([\s\S]*?)\n  \};/)
  const keys = []
  for (const line of m[1].split('\n')) {
    const t = line.trim()
    const a = t.match(/^([a-zA-Z][a-zA-Z0-9]*):\s*pruned\(/)
    if (a) keys.push(a[1])
    const b = t.match(/\{\s*([a-zA-Z][a-zA-Z0-9]*):\s*pruned\(/)
    if (b) keys.push(b[1])
  }
  const noAppearance = keys.filter(k => PLATFORM_APPEARANCE[k] === undefined)
  assert.deepEqual(noAppearance, [], `这些渠道缺外观定义（会显示成裸 id）: ${noAppearance.join(', ')}`)
})

check('用户可见文案不再写死渠道数', () => {
  // 找所有面向用户的字符串字面量里含「N 个渠道」的
  const uiTexts = [...clientSrc.matchAll(/['"`][^'"`]*\d+\s*个渠道[^'"`]*['"`]/g)].map(m => m[0])
  assert.deepEqual(uiTexts, [], `仍有写死渠道数的用户文案: ${uiTexts.join(' | ')}`)
})

console.log('\n' + '='.repeat(58))
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言`)
  console.log('\n结论：新增渠道只需在 host 的 modelAdapters 注册 adapter，')
  console.log('      client 会通过 platform.list 自动发现并渲染——无需改前端。')
  process.exitCode = 0
} else {
  console.log(`❌ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`)
  for (const [n, m] of fails) console.log(`   · ${n}: ${m}`)
  process.exitCode = 1
}
