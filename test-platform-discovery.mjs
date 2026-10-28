// 验证「动态渠道发现」的正确性（离线，不联网）。
//   A. host 侧 platform.list 返回的 provider 集合 == modelAdapters 的键
//   B. client 侧 buildPlatforms 能把 provider id 映射成可渲染的平台对象
//   C. 兜底清单不会比 host 多（防止显示不存在的渠道）
//   D. 未知 provider 有兜底外观（第三方渠道也要能显示）
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

let pass = 0
const fails = []
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`) }
  catch (e) { fails.push({ name, m: e.message }); console.log(`  ✗ ${name}\n      ${e.message}`) }
}

const packSrc = readFileSync('vendor/channel-pack/pack.js', 'utf8')
const clientSrc = readFileSync('client.js', 'utf8')

console.log('=== A. host 侧：platform.list 的数据源 ===')

check('platform.list 用例已注册', () => {
  assert.match(packSrc, /case "platform\.list":/)
})

check('platform.list 以 modelAdapters 为唯一事实源', () => {
  const block = packSrc.slice(packSrc.indexOf('case "platform.list":'))
  const body = block.slice(0, block.indexOf('case "model.list"'))
  assert.match(body, /Object\.keys\(modelAdapters/, '必须从 modelAdapters 取键，而不是另维护一份数组')
})

check('modelAdapters 的键覆盖全部已知渠道', () => {
  const m = packSrc.match(/const modelAdapters = \{([\s\S]*?)\n  \};/)
  assert.ok(m, '未找到 modelAdapters 定义')
  const keys = new Set()
  for (const line of m[1].split('\n')) {
    const t = line.trim()
    const direct = t.match(/^([a-zA-Z][a-zA-Z0-9]*):\s*pruned\(/)
    if (direct) keys.add(direct[1])
    const spread = t.match(/\{\s*([a-zA-Z][a-zA-Z0-9]*):\s*pruned\(/)
    if (spread) keys.add(spread[1])
  }
  const expected = ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
    'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'gemini', 'zcode']
  for (const k of expected) assert.ok(keys.has(k), `modelAdapters 缺少 ${k}`)
  assert.ok(keys.size >= 13, `modelAdapters 只有 ${keys.size} 个渠道，少于 13`)
  console.log(`      → 实测 modelAdapters 含 ${keys.size} 个渠道: ${[...keys].join(', ')}`)
})

console.log('\n=== B. client 侧：外观映射 ===')

// 把 client 里的三块（字典 / 兜底 / 构建函数）抠出来，用 Function 求值。
// 不用正则切字符串（多行数组会截断），改成按「下一个顶层声明」的边界切。
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

const appearanceSrc = sliceDecl(clientSrc, 'const PLATFORM_APPEARANCE = {', [
  'const fallbackPlatform =', 'const buildPlatforms =', 'const FALLBACK_PLATFORMS',
])
const fallbackFnSrc = sliceDecl(clientSrc, 'const fallbackPlatform = provider =>', [
  'const buildPlatforms =', 'const FALLBACK_PLATFORMS',
])
const buildSrc = sliceDecl(clientSrc, 'const buildPlatforms = providers =>', [
  'const FALLBACK_PLATFORMS',
])
const fallbackListSrc = sliceDecl(clientSrc, 'const FALLBACK_PLATFORMS = buildPlatforms([', [
  'const WORKBUDDY_CHANNELS', 'GROWTH_PATH',
])

const factory = new Function(`
  ${appearanceSrc}
  ${fallbackFnSrc}
  ${buildSrc}
  ${fallbackListSrc}
  return { PLATFORM_APPEARANCE, fallbackPlatform, buildPlatforms, FALLBACK_PLATFORMS }
`)
const { PLATFORM_APPEARANCE, buildPlatforms, FALLBACK_PLATFORMS } = factory()

check('buildPlatforms 对已知 provider 用字典文案', () => {
  const [p] = buildPlatforms(['gemini'])
  assert.equal(p.provider, 'gemini')
  assert.equal(p.label, 'Gemini')
  assert.equal(p.unknown, undefined)
})

check('buildPlatforms 对未知 provider 走兜底（第三方渠道可见）', () => {
  const [p] = buildPlatforms(['kimicode'])
  assert.equal(p.provider, 'kimicode')
  assert.equal(p.label, 'Kimicode')
  assert.equal(p.unknown, true)
  assert.match(p.hint, /第三方渠道/)
})

check('buildPlatforms 保留 host 给的顺序', () => {
  const out = buildPlatforms(['zcode', 'gemini', 'cline']).map(p => p.provider)
  assert.deepEqual(out, ['zcode', 'gemini', 'cline'])
})

check('buildPlatforms 过滤空值与非字符串', () => {
  const out = buildPlatforms([null, '', 'gemini', undefined, 123])
  assert.deepEqual(out.map(p => p.provider), ['gemini'])
})

check('buildPlatforms 对非数组输入返回空数组（不崩）', () => {
  for (const bad of [undefined, null, 'x', 42, {}]) {
    assert.deepEqual(buildPlatforms(bad), [])
  }
})

console.log('\n=== C. 兜底清单必须 ⊆ host 实际渠道 ===')

check('FALLBACK_PLATFORMS 的 provider 都在 modelAdapters 里', () => {
  const m = packSrc.match(/const modelAdapters = \{([\s\S]*?)\n  \};/)
  const body = m[1]
  const missing = []
  for (const p of FALLBACK_PLATFORMS) {
    // 允许 `...cond ? {} : { opencode: ... }` 这种条件注册
    const present = new RegExp(`\\b${p.provider}\\s*:\\s*pruned\\(`).test(body)
    if (!present) missing.push(p.provider)
  }
  assert.deepEqual(missing, [], `兜底清单含 host 未注册的渠道: ${missing.join(', ')}`)
})

check('FALLBACK_PLATFORMS 数量 = 13（不含条件注册的 opencode）', () => {
  assert.equal(FALLBACK_PLATFORMS.length, 13, `实际 ${FALLBACK_PLATFORMS.length}`)
})

check('opencode 有外观但不进兜底（host 默认禁用）', () => {
  assert.ok(PLATFORM_APPEARANCE.opencode !== undefined, 'opencode 应有外观定义')
  assert.ok(!FALLBACK_PLATFORMS.some(p => p.provider === 'opencode'),
    'opencode 不应在兜底清单里（channel-pack.js 默认 disableOpencode: true）')
})

console.log('\n=== D. client 里不再有硬编码渠道数组 ===')

check('client.js 已无 CHANNEL_PLATFORMS 残留', () => {
  assert.doesNotMatch(clientSrc, /CHANNEL_PLATFORMS/)
})

check('平台清单从 state 读取（platforms），不是常量', () => {
  assert.match(clientSrc, /const \[platforms, setPlatforms\] = useState\(FALLBACK_PLATFORMS\)/)
  assert.match(clientSrc, /buildPlatforms\(pool\)/)
})

check('第三方 provider 单独存 externalPlatforms（不进渠道卡片）', () => {
  assert.match(clientSrc, /const \[externalPlatforms, setExternalPlatforms\] = useState\(\[\]\)/)
  assert.match(clientSrc, /setExternalPlatforms\(extra\)/)
})

check('第三方 provider 会进轮换候选（按模型页）', () => {
  const s = clientSrc.indexOf("tab === 'models'")
  const block = clientSrc.slice(s, s + 400)
  assert.match(block, /\[\.\.\.platforms, \.\.\.externalPlatforms\]/,
    '轮换候选应合并账号池渠道与第三方 provider')
})

check('RPC 失败时保留兜底清单（不清空页面）', () => {
  const s = clientSrc.indexOf("rpc('platform.list'")
  const block = clientSrc.slice(s, s + 700)
  assert.match(block, /catch\(\(\) => \{/, '必须有 catch')
  assert.doesNotMatch(block, /catch\([^)]*\)\s*=>\s*\{?\s*setPlatforms\(\[\]\)/, '不能把清单清空')
})

console.log('\n' + '='.repeat(58))
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言`)
  process.exitCode = 0
} else {
  console.log(`❌ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`)
  for (const f of fails) console.log(`   · ${f.name}: ${f.m}`)
  process.exitCode = 1
}
