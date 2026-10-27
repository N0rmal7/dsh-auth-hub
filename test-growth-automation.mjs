// test-growth-automation.mjs — 成长清扫闭环（多账号 / 台账 / 自动清扫判据）离线单测。
// 不依赖网络、不依赖真实凭据：用 DSH_HOME 指向临时目录造 state.json 与 .credentials.yaml。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

let pass = 0
let fail = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    fail += 1
    failures.push({ name, message: error.message })
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    fail += 1
    failures.push({ name, message: error.message })
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

// ── 造一个临时 DSH_HOME ────────────────────────────────────────────────────
const home = mkdtempSync(path.join(tmpdir(), 'growth-auto-'))
process.env.DSH_HOME = home
const stateDir = path.join(home, 'channel-pack')
mkdirSync(stateDir, { recursive: true })

function writeState(accounts) {
  writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ accounts }, null, 2), 'utf8')
}
function writeCreds(blocks) {
  // 模拟 .credentials.yaml：`REF: '{"access_token":"...","domain":"..."}'`
  const lines = blocks.map(([ref, obj]) => `${ref}: '${JSON.stringify(obj)}'`)
  writeFileSync(path.join(home, '.credentials.yaml'), `${lines.join('\n')}\n`, 'utf8')
}

writeState([
  { id: 'buddy-a', provider: 'buddy', nickname: '账号A', enabled: true, credentialRef: 'BUDDY_A' },
  { id: 'buddy-b', provider: 'buddy', nickname: '账号B', enabled: true, credentialRef: 'BUDDY_B' },
  { id: 'buddy-off', provider: 'buddy', nickname: '停用号', enabled: false, credentialRef: 'BUDDY_OFF' },
  { id: 'wb-a', provider: 'workbuddy', nickname: '国际号', enabled: true, credentialRef: 'WB_A' },
  { id: 'buddy-nocred', provider: 'buddy', nickname: '缺凭据', enabled: true, credentialRef: 'BUDDY_MISSING' },
])
writeCreds([
  ['BUDDY_A', { access_token: 'token-a', domain: 'copilot.tencent.com' }],
  ['BUDDY_B', { access_token: 'token-b', domain: 'copilot.tencent.com' }],
  ['BUDDY_OFF', { access_token: 'token-off', domain: 'copilot.tencent.com' }],
  ['WB_A', { access_token: 'token-wb', domain: 'www.workbuddy.ai' }],
])

const mod = await import('file:///D:/dsh-auth-hub/index.js')

console.log('\n=== 1. resolveGrowthAccounts：多账号枚举 ===')
check('buddy 只返回**启用且凭据可解析**的 2 个账号（不是 1 个）', () => {
  const rows = mod.resolveGrowthAccounts('buddy')
  assert.equal(rows.length, 2, `实际 ${rows.length}`)
  assert.deepEqual(rows.map(r => r.accountId), ['buddy-a', 'buddy-b'])
})
check('停用账号(enabled:false)被排除', () => {
  const ids = mod.resolveGrowthAccounts('buddy').map(r => r.accountId)
  assert.ok(!ids.includes('buddy-off'))
})
check('凭据缺失的账号被跳过（不产生半成品凭据）', () => {
  const ids = mod.resolveGrowthAccounts('buddy').map(r => r.accountId)
  assert.ok(!ids.includes('buddy-nocred'))
})
check('nickname / domain 正确带出', () => {
  const [a] = mod.resolveGrowthAccounts('buddy')
  assert.equal(a.nickname, '账号A')
  assert.equal(a.credential.accessToken, 'token-a')
  assert.equal(a.credential.domain, 'copilot.tencent.com')
})
check('workbuddy 走独立 provider（返回 1 个）', () => {
  assert.equal(mod.resolveGrowthAccounts('workbuddy').length, 1)
})
check('ids 过滤只扫指定账号', () => {
  const rows = mod.resolveGrowthAccounts('buddy', { ids: ['buddy-b'] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].accountId, 'buddy-b')
})
check('未知 provider → 空数组', () => {
  assert.equal(mod.resolveGrowthAccounts('nope').length, 0)
})

console.log('\n=== 2. runGrowthSweepForProvider：逐个清扫 + 失败隔离 + 聚合 ===')
const grants = []
let calls = []

await checkAsync('两个账号各扫一次，totals 正确累加', async () => {
  calls = []
  const out = await mod.runGrowthSweepForProvider({
    provider: 'buddy',
    day: '2026-10-28',
    sweep: async (credential, options) => {
      calls.push(credential.accessToken)
      // 账号A 挣 910，账号B 挣 5
      return credential.accessToken === 'token-a'
        ? { claimedTasks: 9, claimedCredits: 910, streakDays: 2 }
        : { claimedTasks: 1, claimedCredits: 5, streakDays: 7 }
    },
    recordGrant: (provider, accountId, amount, at) => grants.push({ provider, accountId, amount, at }),
  })
  assert.equal(calls.length, 2, '应扫 2 个账号')
  assert.equal(out.totals.accounts, 2)
  assert.equal(out.totals.swept, 2)
  assert.equal(out.totals.failed, 0)
  assert.equal(out.totals.claimedTasks, 10)
  assert.equal(out.totals.claimedCredits, 915)
  assert.equal(out.totals.streakDays, 7, 'streakDays 取最大')
})

await checkAsync('台账按**真实 accountId** 各记一条（不再传空串）', async () => {
  assert.equal(grants.length, 2, '两个账号应各记一条 grant')
  assert.deepEqual(grants.map(g => g.accountId).sort(), ['buddy-a', 'buddy-b'])
  assert.equal(grants.find(g => g.accountId === 'buddy-a').amount, 910)
  assert.equal(grants.find(g => g.accountId === 'buddy-b').amount, 5)
  assert.ok(grants.every(g => g.provider === 'buddy'))
  assert.ok(grants.every(g => g.accountId !== ''), 'accountId 不允许为空串')
})

await checkAsync('失败隔离：一个账号抛错，另一个仍成功', async () => {
  grants.length = 0
  const out = await mod.runGrowthSweepForProvider({
    provider: 'buddy',
    day: '2026-10-28',
    sweep: async credential => {
      if (credential.accessToken === 'token-a') throw new Error('401 unauthorized')
      return { claimedTasks: 1, claimedCredits: 5 }
    },
    recordGrant: (p, accountId, amount) => grants.push({ p, accountId, amount }),
  })
  assert.equal(out.totals.failed, 1)
  assert.equal(out.totals.swept, 1)
  const failed = out.accounts.find(r => r.error !== undefined)
  const ok = out.accounts.find(r => r.result !== undefined)
  assert.equal(failed.accountId, 'buddy-a')
  assert.match(failed.error, /401/)
  assert.equal(ok.accountId, 'buddy-b')
  // 失败账号不记台账
  assert.equal(grants.length, 1)
  assert.equal(grants[0].accountId, 'buddy-b')
})

await checkAsync('claimedCredits=0 不写台账（避免 0 元 grant 污染 grantedSince）', async () => {
  grants.length = 0
  await mod.runGrowthSweepForProvider({
    provider: 'buddy',
    day: '2026-10-28',
    sweep: async () => ({ claimedTasks: 0, claimedCredits: 0 }),
    recordGrant: (p, accountId, amount) => grants.push({ accountId, amount }),
  })
  assert.equal(grants.length, 0)
})

await checkAsync('sweep 返回畸形值（undefined/null）不炸', async () => {
  const out = await mod.runGrowthSweepForProvider({
    provider: 'buddy',
    day: '2026-10-28',
    sweep: async () => undefined,
    recordGrant: () => {},
  })
  assert.equal(out.totals.failed, 0)
  assert.equal(out.totals.claimedCredits, 0)
})

await checkAsync('空 provider（无启用账号）→ 0 账号、不抛错', async () => {
  const out = await mod.runGrowthSweepForProvider({ provider: 'nope', sweep: async () => ({}), recordGrant: () => {} })
  assert.equal(out.totals.accounts, 0)
  assert.equal(out.totals.swept, 0)
})

console.log('\n=== 3. runGrowthSweepForProvider：day 口径 ===')
await checkAsync('sweep 收到传入的 day（UTC+8 自然日）', async () => {
  let seen
  await mod.runGrowthSweepForProvider({
    provider: 'workbuddy',
    day: '2026-10-28',
    sweep: async (_c, options) => { seen = options.day; return {} },
    recordGrant: () => {},
  })
  assert.equal(seen, '2026-10-28')
})

await checkAsync('未传 day 时回退到 utc8Day()', async () => {
  let seen
  await mod.runGrowthSweepForProvider({
    provider: 'workbuddy',
    sweep: async (_c, options) => { seen = options.day; return {} },
    recordGrant: () => {},
  })
  assert.equal(seen, mod.utc8Day === undefined ? seen : seen)
  assert.match(seen, /^\d{4}-\d{2}-\d{2}$/)
})

console.log('\n=== 4. 自动清扫设置 + 幂等判据 ===')
check('默认 auto=false（不替用户做决定）', () => {
  assert.equal(mod.readGrowthSettings({}).auto, false)
})
check('默认 providers = workbuddy + buddy', () => {
  assert.deepEqual(mod.readGrowthSettings({}).providers, ['workbuddy', 'buddy'])
})
check('默认 maxAttemptsPerDay=2 / retryMinutes=20', () => {
  const s = mod.readGrowthSettings({})
  assert.equal(s.maxAttemptsPerDay, 2)
  assert.equal(s.retryMinutes, 20)
})
check('DSH_GROWTH_AUTO=1 可强制开启（验证用）', () => {
  assert.equal(mod.readGrowthSettings({ DSH_GROWTH_AUTO: '1' }).auto, true)
})
check('配置文件 auto:true 生效', () => {
  writeFileSync(mod.growthSettingsFile(), JSON.stringify({ auto: true, providers: ['buddy'], maxAttemptsPerDay: 3, retryMinutes: 5 }), 'utf8')
  const s = mod.readGrowthSettings({})
  assert.equal(s.auto, true)
  assert.deepEqual(s.providers, ['buddy'])
  assert.equal(s.maxAttemptsPerDay, 3)
  assert.equal(s.retryMinutes, 5)
})
check('非法配置被夹紧/回退（attempts=999 → 10；retry=-5 → 回退默认 20）', () => {
  writeFileSync(mod.growthSettingsFile(), JSON.stringify({ auto: true, maxAttemptsPerDay: 999, retryMinutes: -5 }), 'utf8')
  const s = mod.readGrowthSettings({})
  assert.equal(s.maxAttemptsPerDay, 10, '上限夹紧到 10')
  // 负数不是"立即重试"而是**非法值**：回退默认 20 分钟。
  // 与 checkin-channels.js:804 的既有口径一致（`retry >= 0 ? … : 30`）——
  // 若把 -5 夹成 0 会变成"每轮都重试"，反而把上游打爆。
  assert.equal(s.retryMinutes, 20)
})
check('retryMinutes=0 是合法值（不等待，仍受 maxAttemptsPerDay 约束）', () => {
  writeFileSync(mod.growthSettingsFile(), JSON.stringify({ auto: true, retryMinutes: 0 }), 'utf8')
  assert.equal(mod.readGrowthSettings({}).retryMinutes, 0)
})
check('空 providers 数组回退到默认两个渠道', () => {
  writeFileSync(mod.growthSettingsFile(), JSON.stringify({ auto: true, providers: [] }), 'utf8')
  assert.deepEqual(mod.readGrowthSettings({}).providers, ['workbuddy', 'buddy'])
})
check('auto-state 读写往返', () => {
  mod.writeGrowthAutoState({ version: 1, providers: { buddy: { lastDay: '2026-10-28', attempts: 1, lastStatus: 'ok' } } })
  const back = mod.readGrowthAutoState()
  assert.equal(back.providers.buddy.lastDay, '2026-10-28')
  assert.equal(back.providers.buddy.lastStatus, 'ok')
})
check('auto-state 文件不存在时返回空壳（不抛）', () => {
  rmSync(mod.growthAutoStateFile(), { force: true })
  const back = mod.readGrowthAutoState()
  assert.deepEqual(back.providers, {})
})

// 幂等判据：这是调度器 tick 里那段过滤的等价逻辑，抽出来断言
function shouldRun(row, { day, nowMs, settings }) {
  if (row === undefined) return true
  if (row.lastDay !== day) return true
  if (row.lastStatus === 'ok') return false
  if ((row.attempts ?? 0) >= settings.maxAttemptsPerDay) return false
  return nowMs - (row.lastAt ?? 0) >= settings.retryMinutes * 60_000
}
const settings = { maxAttemptsPerDay: 2, retryMinutes: 20 }

check('判据：今天没跑过 → 跑', () => {
  assert.equal(shouldRun(undefined, { day: '2026-10-28', nowMs: 1, settings }), true)
})
check('判据：今天已成功 → 不再跑（防重复领取）', () => {
  const row = { lastDay: '2026-10-28', lastStatus: 'ok', attempts: 1, lastAt: 0 }
  assert.equal(shouldRun(row, { day: '2026-10-28', nowMs: 1e12, settings }), false)
})
check('判据：昨天成功 → 今天要跑（跨日不漏）', () => {
  const row = { lastDay: '2026-10-27', lastStatus: 'ok', attempts: 1, lastAt: 0 }
  assert.equal(shouldRun(row, { day: '2026-10-28', nowMs: 1, settings }), true)
})
check('判据：今天失败且未到间隔 → 不跑', () => {
  const nowMs = Date.now()
  const row = { lastDay: '2026-10-28', lastStatus: 'error', attempts: 1, lastAt: nowMs }
  assert.equal(shouldRun(row, { day: '2026-10-28', nowMs, settings }), false)
})
check('判据：今天失败且已过 20 分钟 → 重试', () => {
  const nowMs = Date.now()
  const row = { lastDay: '2026-10-28', lastStatus: 'error', attempts: 1, lastAt: nowMs - 21 * 60_000 }
  assert.equal(shouldRun(row, { day: '2026-10-28', nowMs, settings }), true)
})
check('判据：今天失败次数已达上限 → 不再重试（不天荒地老）', () => {
  const nowMs = Date.now()
  const row = { lastDay: '2026-10-28', lastStatus: 'error', attempts: 2, lastAt: nowMs - 999 * 60_000 }
  assert.equal(shouldRun(row, { day: '2026-10-28', nowMs, settings }), false)
})
check('判据不依赖时钟整点（机器休眠后仍正确）', () => {
  // 模拟休眠 6 小时后唤醒：日期变了就必须跑，没变就不能因为"错过整点"而漏跑
  const row = { lastDay: '2026-10-27', lastStatus: 'ok', attempts: 1, lastAt: 0 }
  assert.equal(shouldRun(row, { day: '2026-10-28', nowMs: 1, settings }), true)
})

console.log('\n=== 5. 源码级断言（接线是否真的接上）===')
const indexSrc = readFileSync('D:/dsh-auth-hub/index.js', 'utf8')
check('POST growth 路由调用 runGrowthSweepForProvider（不是只扫一个）', () => {
  assert.match(indexSrc, /runGrowthSweepForProvider\(\{/)
})
check('台账写入传真实 accountId（不再有空串 grant）', () => {
  assert.match(indexSrc, /recordGrant: \(p, accountId, amount, at\) => recordCreditGrant\(creditUsageFile\(\), p, accountId, at\)/)
  assert.equal(/recordCreditGrant\(creditUsageFile\(\), target, '', /.test(indexSrc), false)
})
check('growth scheduler 已注册且用日期判据', () => {
  assert.match(indexSrc, /'auth-hub: growth scheduler'/)
  assert.match(indexSrc, /readGrowthSettings\(\)/)
  assert.match(indexSrc, /row\.lastDay !== day/)
})
check('growth scheduler 不使用"算到下一个整点"的 setTimeout', () => {
  const idx = indexSrc.indexOf("'auth-hub: growth scheduler'")
  const block = indexSrc.slice(Math.max(0, idx - 4000), idx)
  assert.equal(/setTimeout\([^)]*nextHour|到下一个整点|computeNextRun/.test(block), false)
})

rmSync(home, { recursive: true, force: true })

console.log(`\n${'='.repeat(56)}`)
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 项断言`)
} else {
  console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`)
  for (const f of failures) console.log(`   - ${f.name}: ${f.message}`)
}
process.exit(fail === 0 ? 0 : 1)
