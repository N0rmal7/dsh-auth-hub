// Kimi Code 渠道集成验收（离线，不联网）。
// 覆盖：product 契约 / device flow 函数 / adapter / 注册链路 / client 外观。
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

console.log('=== 1. product 契约（与官方 kimi-cli 交叉验证过的值）===')

check('client_id 与官方 CLI 一致', () => {
  assert.match(packSrc, /KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"/)
})

check('OAuth host 与官方 CLI 一致（auth.kimi.com）', () => {
  assert.match(packSrc, /KIMI_OAUTH_HOST = "https:\/\/auth\.kimi\.com"/)
})

check('chat 走 api.kimi.com/coding/v1（OpenAI 兼容）', () => {
  assert.match(packSrc, /"https:\/\/api\.kimi\.com\/coding\/v1"/)
})

check('device flow 端点是官方路径', () => {
  assert.match(packSrc, /\/api\/oauth\/device_authorization/)
  assert.match(packSrc, /\/api\/oauth\/token/)
})

check('product 常量引用这些值', () => {
  const m = packSrc.match(/var KIMI = \{[\s\S]*?\n\};/)
  assert.ok(m, '未找到 KIMI 常量')
  assert.match(m[0], /id: "kimi"/)
  assert.match(m[0], /oauthHost: KIMI_OAUTH_HOST/)
  assert.match(m[0], /clientId: KIMI_CLIENT_ID/)
  assert.match(m[0], /defaultCredentialRef: "KIMI_ACCESS_TOKEN"/)
})

console.log('\n=== 2. device flow 与续期 ===')

check('有 device authorization 申请函数', () => {
  assert.match(packSrc, /function requestKimiDeviceAuthorization\(/)
  assert.match(packSrc, /user_code|userCode/)
})

check('有 token 轮询函数（grant_type=device_code）', () => {
  assert.match(packSrc, /function pollKimiDeviceToken\(/)
  assert.match(packSrc, /urn:ietf:params:oauth:grant-type:device_code/)
})

check('有 refresh_token 续期', () => {
  assert.match(packSrc, /function refreshKimiToken\(/)
  assert.match(packSrc, /grant_type: "refresh_token"/)
})

check('续期终态判定（无 refresh_token → RefreshTokenExpired）', () => {
  // 精确定位 KimiAuth 类内的 refreshCredential（前面有多个渠道的同名方法）
  const clsStart = packSrc.indexOf('var KimiAuth = class')
  assert.ok(clsStart > 0, '未找到 KimiAuth')
  const clsBody = packSrc.slice(clsStart, clsStart + 12000)
  const m = clsBody.match(/async refreshCredential\(credential\) \{[\s\S]*?\n  \}/)
  assert.ok(m, '未找到 KimiAuth.refreshCredential')
  assert.match(m[0], /isKimiRefreshable\(credential\)/)
  assert.match(m[0], /RefreshTokenExpiredError\d*/)
  assert.match(m[0], /refreshKimiToken\(/)
})

check('X-Msh-* 设备头（官方 CLI 的身份标识）', () => {
  assert.match(packSrc, /X-Msh-Platform/)
  assert.match(packSrc, /X-Msh-Device-Id/)
})

console.log('\n=== 3. adapter 契约 ===')

check('KimiAdapter extends LlmAdapter 且实现 providerInfo', () => {
  assert.match(packSrc, /var KimiAdapter = class extends LlmAdapter\d* \{/)
  const cls = packSrc.slice(packSrc.indexOf('var KimiAdapter'))
  assert.match(cls.slice(0, 2000), /providerInfo\(provider\)/)
})

check('凭据缺失时报 MISSING_CREDENTIAL（文案可读）', () => {
  assert.match(packSrc, /kimi: \\u65E0\\u53EF\\u7528\\u51ED\\u636E/)
})

check('支持图片输入判定（inputModalitiesFor）', () => {
  const cls = packSrc.slice(packSrc.indexOf('var KimiAdapter'))
  assert.match(cls.slice(0, 3000), /inputModalitiesFor\(model\)/)
})

check('额度耗尽可换号（KIMI_MAX_ROTATE 与 cline 同量级）', () => {
  assert.match(packSrc, /KIMI_MAX_ROTATE = 3/)
})

console.log('\n=== 4. 注册链路（三处缺一不可）===')

check('modelAdapters 注册 kimi', () => {
  const m = packSrc.match(/const modelAdapters = \{([\s\S]*?)\n  \};/)
  assert.match(m[1], /kimi:\s*pruned\(KIMI\.id,\s*kimiAdapter\)/)
})

check('account.create 有 kimi 分支（device flow 登录入口）', () => {
  assert.match(packSrc, /provider === KIMI\.id/)
  const s = packSrc.indexOf('provider === KIMI.id')
  const block = packSrc.slice(s, s + 1200)
  assert.match(block, /kimi\.startLogin\(/)
  assert.match(block, /userCode/, 'device flow 必须把 userCode 下发给前端')
  assert.match(block, /pool\.addAccount\(/)
})

check('续期调度接入 refreshTargets', () => {
  assert.match(packSrc, /\["kimi", createPoolRefresh\(pool, "kimi", kimi\)\]/)
})

check('实例化在 apply() 内（kimiAuth + kimiAdapter）', () => {
  assert.match(packSrc, /const kimi = new KimiAuth\(ctx, \{ product: KIMI \}\)/)
  assert.match(packSrc, /const kimiAdapter = registerKimiLlm\(ctx, \{/)
})

check('stop() 清理链包含 kimi', () => {
  const s = packSrc.indexOf('ctx.effect(() => () => {\n    service.stop();')
  const block = packSrc.slice(s, s + 600)
  assert.match(block, /kimi\.stop\(\)/)
})

console.log('\n=== 5. client 外观 ===')

check('PLATFORM_APPEARANCE 有 kimi 条目', () => {
  assert.match(clientSrc, /kimi: \{ label: 'Kimi Code', hint: 'OAuth 设备码/)
})

console.log('\n' + '='.repeat(58))
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言`)
  process.exitCode = 0
} else {
  console.log(`❌ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`)
  for (const [n, m] of fails) console.log(`   · ${n}: ${m}`)
  process.exitCode = 1
}
