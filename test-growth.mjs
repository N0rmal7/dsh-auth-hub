#!/usr/bin/env node
// 成长中心（workbuddy-growth.js）回归测试 —— 离线、自包含、无网络、无凭据。
//
//   node test-growth.mjs
//
// 覆盖 2026-10-28 修复的四个问题：
//   A. growthDay()：UTC+8 自然日口径（不是 UTC 日）
//   B. fetchGrowthRewardToday()：改用 claimed_at（秒）×1000 落 UTC+8 日区间，
//      不再用 travel_date 匹配；同日多条累加
//   C. claimGrowthTask()：already_claimed 判定 + credit 缺失不再等于失败
//   D. runGrowthSweep()：rewardCredit 回退、claimed 任务跳过、trip 奖励并入
//   E. 区判定 / 头 / 错误归类
//   F. 两区 schema（国内版 task_code/accept_status/progress vs 国际版 code/status）
//      + claim 路径分支 + 国际版无猫猫旅行
//   G. 源码健全性
//
// 全部通过 → 退出码 0；有失败 → 1。
//
// 注：真实上游验证（4 个账号打 copilot.tencent.com / workbuddy.ai）需要凭据，
// 不随仓库分发，本文件只用 mock fetch 做离线断言。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const growth = await import(new URL('./workbuddy-growth.js', import.meta.url).href)
const SRC = readFileSync(new URL('./workbuddy-growth.js', import.meta.url), 'utf8')

let pass = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
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
    failures.push({ name, message: error.message })
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

// ── mock fetch ───────────────────────────────────────────────────────────────

const CN = 'https://www.codebuddy.cn'
const GLOBAL = 'https://www.workbuddy.ai'
const CN_CRED = { accessToken: 'offline-test-token', domain: 'www.codebuddy.cn' }
const GLOBAL_CRED = { accessToken: 'offline-test-token', domain: 'www.workbuddy.ai' }

const realFetch = globalThis.fetch
let calls = []

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  }
}
const ok200 = data => jsonResponse(200, { code: 0, msg: '', data })
const bizFail = (code, msg) => jsonResponse(200, { code, msg, data: {} })

/** 装一个 mock fetch；handler 收到 { url, path, method, body, headers }。 */
async function withFetch(handler, fn) {
  calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    const parsed = new URL(url)
    const method = String(init.method ?? 'GET').toUpperCase()
    const record = {
      url,
      path: parsed.pathname,
      method,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init.headers ?? {}
    }
    calls.push(record)
    const response = await handler(record)
    if (response === undefined) throw new Error(`未 mock 的请求：${method} ${parsed.pathname}`)
    return response
  }
  try {
    return await fn()
  } finally {
    globalThis.fetch = realFetch
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

const ts = iso => Math.floor(Date.parse(iso) / 1e3)
const DAY = '2026-10-28'
// UTC+8 的 2026-10-28 00:00 == UTC 2026-10-27T16:00Z
const DAY_START_UTC = '2026-10-27T16:00:00Z'

const rec = (claimedAtIso, credit, travelDate = '2000-01-01') => ({
  record_id: 1,
  travel_date: travelDate,
  claimed_at: typeof claimedAtIso === 'string' ? ts(claimedAtIso) : claimedAtIso,
  reward_credit: credit
})

const RECORDS_PATH = '/activity/growth/buddy/travel/records'
const TASKS_PATH = '/v2/activity/growth/tasks'
const TRAVEL = '/activity/growth/buddy/travel'

// 国内版任务条目（实测形状）
const cnTask = (code, acceptStatus, current, target, rewardCredit) => ({
  task_code: code,
  title: code,
  accept_status: acceptStatus,
  progress: { current, target },
  reward_credit: rewardCredit
})

// 国际版任务条目（实测形状：无 progress / 无 reward_credit，带 level_name）
const globalTask = (code, status = 'available', levelName = '养虾尝试') => ({
  task_id: 1,
  code,
  title: code,
  description: '',
  icon_url: '',
  level_name: levelName,
  status,
  url: ''
})

/** 一套完整的国内版清扫路由。 */
function sweepHandler(options = {}) {
  const {
    tasks = [],
    claims = {},
    status = { state: 'idle' },
    locations = [7],
    records = [],
    streak = 2,
    tripClaim = {}
  } = options
  return req => {
    const p = req.path
    if (p === TASKS_PATH && req.method === 'GET') return ok200({ tasks })
    if (p === `${TASKS_PATH}/accept` && req.method === 'POST') return ok200({})
    const m = p.match(/^\/activity\/growth\/tasks\/(.+)\/claim$/)
    if (m) {
      const code = decodeURIComponent(m[1])
      if (!(code in claims)) return bizFail(400, '任务未完成')
      return ok200(claims[code])
    }
    if (p === `${TRAVEL}/status`) return ok200(status)
    if (p === `${TRAVEL}/config`) return ok200({ locations: locations.map(id => ({ id })) })
    if (p === `${TRAVEL}/depart`) return ok200({})
    if (p === `${TRAVEL}/claim`) return ok200(tripClaim)
    if (p === RECORDS_PATH) return ok200({ records })
    if (p === '/activity/growth/streak') return ok200({ streak: { days: streak } })
    return undefined
  }
}

/** 一套完整的国际版清扫路由（无猫猫旅行：status/config 都是空对象）。 */
function globalSweepHandler(options = {}) {
  const { tasks = [], claims = {}, streak = 3 } = options
  return req => {
    const p = req.path
    if (p === TASKS_PATH && req.method === 'GET') return ok200({ tasks })
    if (p === `${TASKS_PATH}/accept` && req.method === 'POST') return ok200({})
    const m = p.match(/^\/v2\/activity\/growth\/tasks\/(.+)\/claim$/)
    if (m) {
      const code = decodeURIComponent(m[1])
      if (!(code in claims)) return bizFail(400, 'task not completed')
      return ok200(claims[code])
    }
    if (p === `${TRAVEL}/status`) return ok200({})
    if (p === `${TRAVEL}/config`) return ok200({})
    if (p === RECORDS_PATH) return ok200({ records: [] })
    if (p === '/activity/growth/streak') return ok200({ streak: { days: streak, month_total_days: 3 } })
    return undefined
  }
}

console.log('=== A. growthDay()：UTC+8 自然日口径 ===')

check('UTC+8 前一日 23:59:59 仍算前一日', () => {
  assert.equal(growth.growthDay(new Date('2026-10-27T15:59:59Z')), '2026-10-27')
})

check('UTC+8 零点整（UTC 16:00Z）翻到次日', () => {
  assert.equal(growth.growthDay(new Date(DAY_START_UTC)), '2026-10-28')
})

check('UTC+8 后一日 23:59:59 仍算当日', () => {
  assert.equal(growth.growthDay(new Date('2026-10-28T15:59:59Z')), '2026-10-28')
})

check('UTC+8 次日零点（UTC 16:00Z）再翻日', () => {
  assert.equal(growth.growthDay(new Date('2026-10-28T16:00:00Z')), '2026-10-29')
})

check('不是 UTC 日：17:00Z 的 UTC 日与 UTC+8 日相差一天', () => {
  const date = new Date('2026-10-27T17:00:00Z')
  assert.equal(date.toISOString().slice(0, 10), '2026-10-27', 'UTC 日是 10-27')
  assert.equal(growth.growthDay(date), '2026-10-28', 'UTC+8 日是 10-28')
})

check('默认参数取当前时刻的 UTC+8 日', () => {
  const now = Date.now()
  assert.equal(growth.growthDay(), new Date(now + 8 * 3600e3).toISOString().slice(0, 10))
})

check('同一 UTC 日内的两个时刻可能落在不同 UTC+8 日', () => {
  assert.notEqual(growth.growthDay(new Date('2026-10-27T15:59:00Z')), growth.growthDay(new Date('2026-10-27T16:01:00Z')))
})

console.log('\n=== B. fetchGrowthRewardToday()：claimed_at 落 UTC+8 日区间 ===')

await checkAsync('按 claimed_at 命中当日（travel_date 是很久以前也照算）', async () => {
  await withFetch(() => ok200({ records: [rec('2026-10-27T17:00:00Z', 10, '2026-08-22')] }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), 10)
  })
})

await checkAsync('travel_date 等于今日但 claimed_at 在昨天 → 不计数（旧实现会误判）', async () => {
  await withFetch(() => ok200({ records: [rec('2026-10-26T10:00:00Z', 10, DAY)] }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), undefined)
  })
})

await checkAsync('区间下界：UTC+8 零点前一分钟（15:59Z）不计', async () => {
  await withFetch(() => ok200({ records: [rec('2026-10-27T15:59:00Z', 10)] }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), undefined)
  })
})

await checkAsync('区间下界：UTC+8 零点整（16:00Z）计入（左闭）', async () => {
  await withFetch(() => ok200({ records: [rec(DAY_START_UTC, 10)] }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), 10)
  })
})

await checkAsync('区间上界：次日零点前一秒（15:59:59Z）计入', async () => {
  await withFetch(() => ok200({ records: [rec('2026-10-28T15:59:59Z', 10)] }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), 10)
  })
})

await checkAsync('区间上界：次日零点整（16:00Z）不计（右开）', async () => {
  await withFetch(() => ok200({ records: [rec('2026-10-28T16:00:00Z', 10)] }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), undefined)
  })
})

await checkAsync('同日多条累加（先到站未领、后来补领）', async () => {
  const records = [rec('2026-10-27T17:00:00Z', 10), rec('2026-10-28T01:00:00Z', 5), rec('2026-10-28T12:00:00Z', 7)]
  await withFetch(() => ok200({ records }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), 22)
  })
})

await checkAsync('跨日多条只累加目标日', async () => {
  const records = [rec('2026-10-27T10:00:00Z', 99), rec('2026-10-27T17:00:00Z', 10), rec('2026-10-28T17:00:00Z', 88)]
  await withFetch(() => ok200({ records }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), 10)
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, '2026-10-27'), 99)
  })
})

await checkAsync('claimed_at = 0（未领）跳过', async () => {
  await withFetch(() => ok200({ records: [rec(0, 10)] }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), undefined)
  })
})

await checkAsync('claimed_at 是字符串（类型不对）跳过', async () => {
  await withFetch(
    () => ok200({ records: [{ claimed_at: String(ts(DAY_START_UTC)), reward_credit: 10 }] }),
    async () => {
      assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), undefined)
    }
  )
})

await checkAsync('reward_credit 非数字的当日记录不贡献金额，其余照算', async () => {
  const records = [{ claimed_at: ts(DAY_START_UTC), reward_credit: '10' }, rec('2026-10-27T18:00:00Z', 5)]
  await withFetch(() => ok200({ records }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), 5)
  })
})

await checkAsync('没有 records 字段 / records 不是数组 → undefined', async () => {
  await withFetch(() => ok200({}), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), undefined)
  })
  await withFetch(() => ok200({ records: { 0: rec(DAY_START_UTC, 10) } }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), undefined)
  })
})

await checkAsync('数组里的 null / 非对象条目被跳过', async () => {
  await withFetch(() => ok200({ records: [null, 42, 'x', rec(DAY_START_UTC, 10)] }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), 10)
  })
})

await checkAsync('无今日记录返回 undefined（与「确实 0」区分）', async () => {
  await withFetch(() => ok200({ records: [] }), async () => {
    assert.equal(await growth.fetchGrowthRewardToday(CN_CRED, DAY), undefined)
  })
})

await checkAsync('/records 用区的 base + 成长中心头', async () => {
  await withFetch(
    req => (req.path === RECORDS_PATH ? ok200({ records: [] }) : undefined),
    async () => {
      await growth.fetchGrowthRewardToday(GLOBAL_CRED, DAY)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, `${GLOBAL}${RECORDS_PATH}`)
      assert.equal(calls[0].method, 'GET')
      assert.equal(calls[0].headers.Origin, GLOBAL)
      assert.equal(calls[0].headers.Referer, `${GLOBAL}/profile/growth-center`)
    }
  )
})

console.log('\n=== C. claimGrowthTask()：already_claimed 与 credit 缺失 ===')

await checkAsync('already_claimed:true + credit:0 → 不算本次领到', async () => {
  await withFetch(() => ok200({ already_claimed: true, credit: 0, energy: 0 }), async () => {
    assert.deepEqual(await growth.claimGrowthTask(CN_CRED, 'daily_login'), { ok: false, reason: 'already-claimed' })
  })
})

await checkAsync('credit:100 且无 already_claimed → ok + credit', async () => {
  await withFetch(() => ok200({ credit: 100 }), async () => {
    assert.deepEqual(await growth.claimGrowthTask(CN_CRED, 'daily_login'), { ok: true, credit: 100 })
  })
})

await checkAsync('credit:0 且无 already_claimed → ok 但没有 credit（触发调用方回退）', async () => {
  await withFetch(() => ok200({ credit: 0 }), async () => {
    const result = await growth.claimGrowthTask(CN_CRED, 'daily_login')
    assert.equal(result.ok, true)
    assert.equal('credit' in result, false, 'credit=0 不应作为真实金额传出')
  })
})

await checkAsync('空 data → ok，无 credit 字段', async () => {
  await withFetch(() => ok200({}), async () => {
    const result = await growth.claimGrowthTask(CN_CRED, 'daily_login')
    assert.equal(result.ok, true)
    assert.equal(result.credit, undefined)
  })
})

await checkAsync('业务失败（code≠0）→ ok:false 且带上游 msg', async () => {
  await withFetch(() => bizFail(400, '任务未完成'), async () => {
    assert.deepEqual(await growth.claimGrowthTask(CN_CRED, 'read_docs'), { ok: false, reason: '任务未完成' })
  })
})

await checkAsync('业务失败且 msg 为空 → reason 回落到 http 状态', async () => {
  await withFetch(() => bizFail(400, ''), async () => {
    assert.deepEqual(await growth.claimGrowthTask(CN_CRED, 'read_docs'), { ok: false, reason: 'http 400' })
  })
})

await checkAsync('task_code 会被 URL 编码（国内版路径）', async () => {
  await withFetch(req => (req.path.includes('/claim') ? ok200({ credit: 1 }) : undefined), async () => {
    await growth.claimGrowthTask(CN_CRED, 'a/b c')
    assert.equal(calls[0].path, '/activity/growth/tasks/a%2Fb%20c/claim')
    assert.equal(calls[0].method, 'POST')
  })
})

console.log('\n=== D. runGrowthSweep()：金额回退 / 跳过已领 / trip 并入 ===')

await checkAsync('D1 完整一轮：credit 缺失回退 rewardCredit，credit 有时优先，claimed 与未完成跳过', async () => {
  const tasks = [
    cnTask('T1', 'accepted', 1, 1, 100),
    cnTask('T2', 'accepted', 1, 1, 50),
    cnTask('T3', 'claimed', 1, 1, 100),
    cnTask('T4', 'accepted', 1, 5, 100),
    cnTask('T5', 'not_accepted', 1, 1, 30)
  ]
  const claims = {
    T1: { credit: 0 },
    T2: { credit: 50 },
    T5: { already_claimed: true, credit: 0 }
  }
  const records = [rec('2026-10-27T17:00:00Z', 10, '2026-08-22')]
  await withFetch(sweepHandler({ tasks, claims, records, streak: 2 }), async () => {
    const result = await growth.runGrowthSweep(CN_CRED, { day: DAY })
    assert.deepEqual(result.errors, [])
    assert.equal(result.accepted, 1, '只接 not_accepted 的 T5')
    assert.equal(result.claimedTasks, 2, 'T1/T2 领到；T3 已领跳过、T4 未完成、T5 已领')
    // T1 缺 credit → 回退 100；T2 → 50；trip 记录 → 10
    assert.equal(result.claimedCredits, 160)
    assert.equal(result.streakDays, 2)
    assert.equal(result.trip.dispatched, true)

    const acceptCall = calls.find(c => c.path === `${TASKS_PATH}/accept`)
    assert.deepEqual(acceptCall.body, { task_codes: ['T5'] })

    const claimPaths = calls.filter(c => c.path.includes('/tasks/') && c.path.endsWith('/claim')).map(c => c.path)
    assert.ok(claimPaths.some(p => p.includes('/T1/')), 'T1 应被领')
    assert.ok(claimPaths.some(p => p.includes('/T2/')), 'T2 应被领')
    assert.ok(!claimPaths.some(p => p.includes('/T3/')), 'T3 状态 claimed，不得再请求')
    assert.ok(!claimPaths.some(p => p.includes('/T4/')), 'T4 未完成，不得请求')
  })
})

await checkAsync('D2 全为 already_claimed：claimedTasks=0，不把 0 当金额，只算 trip 奖励', async () => {
  const tasks = [cnTask('X1', 'accepted', 1, 1, 100), cnTask('X2', 'accepted', 1, 1, 100)]
  const claims = { X1: { already_claimed: true, credit: 0 }, X2: { already_claimed: true, credit: 0 } }
  const records = [rec(DAY_START_UTC, 10)]
  await withFetch(sweepHandler({ tasks, claims, records }), async () => {
    const result = await growth.runGrowthSweep(CN_CRED, { day: DAY })
    assert.equal(result.claimedTasks, 0)
    assert.equal(result.claimedCredits, 10, '旧 bug 现象是 10；这里必须仍是 10 且不虚增 200')
    assert.deepEqual(result.errors, [])
  })
})

await checkAsync('D3 trip 已到站领取成功：trip.claimed 并入，且不再查 /records', async () => {
  const tasks = [cnTask('Y1', 'accepted', 1, 1, 40)]
  const claims = { Y1: { credit: 0 } }
  await withFetch(
    sweepHandler({ tasks, claims, status: { state: 'arrived', record_id: 9 }, tripClaim: { reward_credit: 20 } }),
    async () => {
      const result = await growth.runGrowthSweep(CN_CRED, { day: DAY })
      assert.equal(result.trip.dispatched, false)
      assert.equal(result.trip.claimed, 20)
      assert.equal(result.claimedCredits, 60)
      assert.equal(calls.filter(c => c.path === RECORDS_PATH).length, 0, '已知 trip.claimed 时不该再读 /records')
    }
  )
})

await checkAsync('D4 任务列表失败不影响 trip 与连登，错误被记录', async () => {
  await withFetch(
    req => {
      if (req.path === TASKS_PATH) return bizFail(500, 'internal boom')
      return sweepHandler({ records: [rec(DAY_START_UTC, 10)] })(req)
    },
    async () => {
      const result = await growth.runGrowthSweep(CN_CRED, { day: DAY })
      assert.equal(result.errors.length, 1)
      assert.match(result.errors[0], /^tasks:/)
      assert.equal(result.streakDays, 2)
      assert.equal(result.claimedCredits, 10)
    }
  )
})

await checkAsync('D5 trip 抛错被收进 errors，不影响已统计的任务奖励', async () => {
  const tasks = [cnTask('Z1', 'accepted', 1, 1, 70)]
  const claims = { Z1: { credit: 0 } }
  await withFetch(
    req => {
      if (req.path === `${TRAVEL}/status`) return jsonResponse(500, 'gateway down')
      return sweepHandler({ tasks, claims })(req)
    },
    async () => {
      const result = await growth.runGrowthSweep(CN_CRED, { day: DAY })
      assert.equal(result.claimedTasks, 1)
      assert.equal(result.claimedCredits, 70)
      assert.equal(result.errors.length, 1)
      assert.match(result.errors[0], /^trip:/)
    }
  )
})

await checkAsync('D6 传入 day 覆盖时用传入日（不是系统今天）', async () => {
  const records = [rec('2026-10-26T17:00:00Z', 12), rec('2026-10-27T17:00:00Z', 34)]
  await withFetch(sweepHandler({ records }), async () => {
    const older = await growth.runGrowthSweep(CN_CRED, { day: '2026-10-27' })
    assert.equal(older.claimedCredits, 12)
  })
})

await checkAsync('D7 rewardCredit 缺失（undefined）时不会 NaN', async () => {
  const raw = [{ task_code: 'N1', accept_status: 'accepted', progress: { current: 1, target: 1 } }]
  await withFetch(
    req => {
      if (req.path === TASKS_PATH) return ok200({ tasks: raw })
      if (req.path.includes('/N1/claim')) return ok200({ credit: 0 })
      return sweepHandler({})(req)
    },
    async () => {
      const result = await growth.runGrowthSweep(CN_CRED, { day: DAY })
      assert.equal(result.claimedTasks, 1)
      assert.equal(result.claimedCredits, 0)
      assert.ok(Number.isFinite(result.claimedCredits), '不得出现 NaN')
    }
  )
})

await checkAsync('D8 全空账号返回零值结构且不抛', async () => {
  await withFetch(sweepHandler({ tasks: [], status: { state: 'idle', daily_limit_reached: true } }), async () => {
    const result = await growth.runGrowthSweep(CN_CRED, { day: DAY })
    assert.deepEqual(result.errors, [])
    assert.equal(result.accepted, 0)
    assert.equal(result.claimedTasks, 0)
    assert.equal(result.claimedCredits, 0)
    assert.equal(result.trip.reason, 'daily-limit')
  })
})

console.log('\n=== E. 区判定 / 头 / 错误归类 ===')

check('regionOf：.ai 与空 domain 算国际版，其余国内版', () => {
  assert.equal(growth.regionOf('www.workbuddy.ai'), 'global')
  assert.equal(growth.regionOf('www.codebuddy.ai'), 'global')
  assert.equal(growth.regionOf(''), 'global')
  assert.equal(growth.regionOf(undefined), 'global')
  assert.equal(growth.regionOf('www.codebuddy.cn'), 'cn')
  assert.equal(growth.regionOf(' COPILOT.TENCENT.COM '), 'cn')
})

await checkAsync('国内版走 codebuddy.cn 的 base，国际版走 workbuddy.ai', async () => {
  await withFetch(req => (req.path === `${TRAVEL}/status` ? ok200({ state: 'idle' }) : undefined), async () => {
    await growth.fetchGrowthStatus(CN_CRED)
    assert.ok(calls[0].url.startsWith(CN), `国内版 base 应为 ${CN}`)
  })
  await withFetch(req => (req.path === `${TRAVEL}/status` ? ok200({ state: 'idle' }) : undefined), async () => {
    await growth.fetchGrowthStatus(GLOBAL_CRED)
    assert.ok(calls[0].url.startsWith(GLOBAL), `国际版 base 应为 ${GLOBAL}`)
  })
})

check('classifyUpstreamError：402/429/404/5xx/凭据失效', () => {
  assert.equal(growth.classifyUpstreamError(402, ''), 'hard_credit')
  assert.equal(growth.classifyUpstreamError(400, 'insufficient credit'), 'hard_credit')
  assert.equal(growth.classifyUpstreamError(401, '登录已失效'), 'session_dead')
  assert.equal(growth.classifyUpstreamError(429, ''), 'soft_rate')
  assert.equal(growth.classifyUpstreamError(404, ''), 'not_found')
  assert.equal(growth.classifyUpstreamError(503, ''), 'server')
  assert.equal(growth.classifyUpstreamError(400, 'bad request'), 'client')
})

await checkAsync('非 JSON 响应抛错（真的坏了，不静默）', async () => {
  await withFetch(
    req => (req.path === `${TRAVEL}/status` ? jsonResponse(200, '<html>gateway</html>') : undefined),
    async () => {
      await assert.rejects(() => growth.fetchGrowthStatus(CN_CRED), /non-JSON/)
    }
  )
})

await checkAsync('fetchGrowthTasks 业务失败抛错（不把空列表当成「没报名」）', async () => {
  await withFetch(() => bizFail(401, '登录已失效'), async () => {
    await assert.rejects(() => growth.fetchGrowthTasks(CN_CRED), /session_dead/)
  })
})

console.log('\n=== F. 两区 schema：国内版 vs 国际版 ===')

// 国内版 19 个任务（与线上一致的数量级），字段 task_code/accept_status/progress/reward_credit
const CN_TASKS_19 = Array.from({ length: 19 }, (_, index) =>
  cnTask(`cn_task_${index}`, index < 3 ? 'claimed' : index < 6 ? 'not_accepted' : 'accepted', 1, 1, 100)
)
// 国际版 5 个真实任务（Lead 实测），字段 code/status/level_name，无 progress、无 reward_credit
const GLOBAL_TASKS_5 = [
  globalTask('first_chat', 'available', '养虾尝试'),
  globalTask('skill_installed', 'available', '养虾入门'),
  globalTask('wechat_linked', 'available', '养虾熟手'),
  globalTask('expert_summoned', 'available', '玩虾老手'),
  globalTask('template_used', 'available', '控虾大神')
]

await checkAsync('F1 国内版解析出 19 个（task_code/accept_status/progress/reward_credit）', async () => {
  await withFetch(() => ok200({ tasks: CN_TASKS_19 }), async () => {
    const tasks = await growth.fetchGrowthTasks(CN_CRED)
    assert.equal(tasks.length, 19)
    assert.deepEqual(tasks[0], { code: 'cn_task_0', title: 'cn_task_0', status: 'claimed', current: 1, target: 1, rewardCredit: 100 })
    assert.equal(tasks.filter(t => t.status === 'not_accepted').length, 3)
  })
})

await checkAsync('F2 国际版解析出 5 个（旧代码在此返回空数组 —— 静默降级）', async () => {
  await withFetch(() => ok200({ tasks: GLOBAL_TASKS_5 }), async () => {
    const tasks = await growth.fetchGrowthTasks(GLOBAL_CRED)
    assert.equal(tasks.length, 5, '国际版 5 个任务必须全部解析出来')
    assert.deepEqual(tasks.map(t => t.code), [
      'first_chat',
      'skill_installed',
      'wechat_linked',
      'expert_summoned',
      'template_used'
    ])
  })
})

await checkAsync('F3 国际版条目：status 读 status 字段，progress/reward 给安全默认 0', async () => {
  await withFetch(() => ok200({ tasks: [globalTask('first_chat', 'available')] }), async () => {
    const [task] = await growth.fetchGrowthTasks(GLOBAL_CRED)
    assert.equal(task.status, 'available', '不能因为 accept_status 缺失就变成空串')
    assert.equal(task.current, 0)
    assert.equal(task.target, 0, 'target 0 表示「不分进度」，不是「0/0 未完成」')
    assert.equal(task.rewardCredit, 0)
    assert.equal(task.levelName, '养虾尝试', '等级制信息要带出来，UI 才能替代积分显示')
  })
})

await checkAsync('F4 两套字段同时存在时按 code 优先（约定 code ?? task_code）', async () => {
  const merged = [{ task_code: 'cn_lose', code: 'global_win', accept_status: 'accepted', status: 'available', progress: { current: 3, target: 3 }, reward_credit: 80 }]
  await withFetch(() => ok200({ tasks: merged }), async () => {
    const [task] = await growth.fetchGrowthTasks(CN_CRED)
    // 两区是不同主机，现实中不会出现合并 schema；此断言只固定优先级，防日后反转成
    // 「国际版任务在某区被 task_code 覆盖」这类回归。
    assert.equal(task.code, 'global_win', 'code 优先于 task_code')
    assert.equal(task.status, 'available', 'status 优先于 accept_status')
    // 但进度/金额仍按国内版字段读（国际版本就没有这两个字段）
    assert.equal(task.current, 3)
    assert.equal(task.rewardCredit, 80)
  })
})

await checkAsync('F5 两种字段都没有的条目仍被跳过（不产生 undefined code）', async () => {
  const raw = [globalTask('ok_one'), { task_id: 2, status: 'available' }, { task_code: '', code: '', title: 'x' }, null]
  await withFetch(() => ok200({ tasks: raw }), async () => {
    const tasks = await growth.fetchGrowthTasks(GLOBAL_CRED)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].code, 'ok_one')
  })
})

check('F6 claim 路径按区分支：国内版无 /v2，国际版有', () => {
  assert.equal(growth.growthTaskClaimPath(CN_CRED, 'first_chat'), '/activity/growth/tasks/first_chat/claim')
  assert.equal(growth.growthTaskClaimPath(GLOBAL_CRED, 'first_chat'), '/v2/activity/growth/tasks/first_chat/claim')
  assert.equal(growth.growthTaskClaimPath({ domain: '' }, 'x'), '/v2/activity/growth/tasks/x/claim')
})

await checkAsync('F7 国际版 claim 真打 /v2 路径', async () => {
  await withFetch(req => (req.path.includes('/claim') ? ok200({ credit: 0 }) : undefined), async () => {
    await growth.claimGrowthTask(GLOBAL_CRED, 'first_chat')
    assert.equal(calls[0].url, `${GLOBAL}/v2/activity/growth/tasks/first_chat/claim`)
  })
})

await checkAsync('F8 国际版 status/config 都为空对象时，trip 直接跳过且不请求', async () => {
  await withFetch(globalSweepHandler({}), async () => {
    const trip = await growth.runGrowthTrip(GLOBAL_CRED)
    assert.deepEqual(trip, { dispatched: false, reason: 'no-trip-in-region' })
    assert.equal(calls.length, 0, '国际版不该发 status/config 请求')
  })
})

await checkAsync('F9 国际版整轮：不出现在 errors 里的 unknown-state，不读 /records', async () => {
  await withFetch(globalSweepHandler({ tasks: GLOBAL_TASKS_5, streak: 3 }), async () => {
    const result = await growth.runGrowthSweep(GLOBAL_CRED, { day: DAY })
    assert.deepEqual(result.errors, [], '国际版必须零错误')
    assert.equal(result.trip.reason, 'no-trip-in-region')
    assert.notEqual(result.trip.reason, 'unknown-state')
    assert.equal(calls.filter(c => c.path === RECORDS_PATH).length, 0, '国际版没有旅行记录，别去读')
    assert.equal(calls.filter(c => c.path === `${TRAVEL}/status`).length, 0, '国际版不请求 status')
    assert.equal(result.streakDays, 3, '连登字段两边同名，必须读到')
  })
})

await checkAsync('F10 国际版 available 任务不触发注定 400 的 claim', async () => {
  await withFetch(globalSweepHandler({ tasks: GLOBAL_TASKS_5 }), async () => {
    const result = await growth.runGrowthSweep(GLOBAL_CRED, { day: DAY })
    assert.equal(calls.filter(c => c.path.endsWith('/claim')).length, 0, 'available ≠ 可领，不得白打 5 次')
    assert.equal(result.claimedTasks, 0)
    assert.equal(result.claimedCredits, 0)
  })
})

await checkAsync('F11 国际版明确完成态会去 /v2 领，且金额仍是 0（等级制无积分字段）', async () => {
  const tasks = [globalTask('first_chat', 'completed')]
  await withFetch(globalSweepHandler({ tasks, claims: { first_chat: { credit: 0 } } }), async () => {
    const result = await growth.runGrowthSweep(GLOBAL_CRED, { day: DAY })
    assert.equal(result.claimedTasks, 1)
    assert.equal(result.claimedCredits, 0)
    const claimCall = calls.find(c => c.path.endsWith('/claim'))
    assert.equal(claimCall.path, '/v2/activity/growth/tasks/first_chat/claim')
  })
})

await checkAsync('F12 返回值标明 region 与 creditKind（UI 才不会把国际版渲染成「+0 积分」）', async () => {
  await withFetch(sweepHandler({ tasks: [] }), async () => {
    const cnResult = await growth.runGrowthSweep(CN_CRED, { day: DAY })
    assert.equal(cnResult.region, 'cn')
    assert.equal(cnResult.creditKind, 'task-credit')
  })
  await withFetch(globalSweepHandler({ tasks: GLOBAL_TASKS_5 }), async () => {
    const globalResult = await growth.runGrowthSweep(GLOBAL_CRED, { day: DAY })
    assert.equal(globalResult.region, 'global')
    assert.equal(globalResult.creditKind, 'streak-tier', '国际版激励在连登阶梯，不在任务')
    assert.equal(globalResult.claimedCredits, 0, '0 是真实值，但 creditKind 告诉 UI 别显示 +0 积分')
  })
})

check('F13 isGrowthTaskClaimable：进度达标 / 无 progress 只看完成态', () => {
  assert.equal(growth.isGrowthTaskClaimable({ status: 'accepted', current: 3, target: 3 }), true)
  assert.equal(growth.isGrowthTaskClaimable({ status: 'accepted', current: 2, target: 3 }), false)
  assert.equal(growth.isGrowthTaskClaimable({ status: 'claimed', current: 1, target: 1 }), false)
  // 国际版：无 progress
  assert.equal(growth.isGrowthTaskClaimable({ status: 'available', current: 0, target: 0 }), false)
  assert.equal(growth.isGrowthTaskClaimable({ status: 'completed', current: 0, target: 0 }), true)
  assert.equal(growth.isGrowthTaskClaimable(null), false)
})

console.log('\n=== G. 源码健全性 ===')

check('fetchGrowthRewardToday 用 claimed_at，不再用 travel_date 匹配', () => {
  const start = SRC.indexOf('export async function fetchGrowthRewardToday')
  const end = SRC.indexOf('export async function claimGrowth(')
  assert.ok(start > 0 && end > start, '函数应存在')
  const body = SRC.slice(start, end)
  assert.match(body, /claimed_at/, '必须使用 claimed_at')
  assert.doesNotMatch(body, /travel_date/, '不得再靠 travel_date 匹配')
})

check('已导出 growthDay 且实现是 UTC+8 偏移', () => {
  assert.equal(typeof growth.growthDay, 'function')
  assert.match(SRC, /export function growthDay\(date = new Date\(\)\)/)
  assert.match(SRC, /8 \* 3600e3/)
})

check('claimGrowthTask 判定 already_claimed 且路径按区分支', () => {
  const start = SRC.indexOf('export async function claimGrowthTask')
  const body = SRC.slice(start, start + 700)
  assert.match(body, /already_claimed === true/)
  assert.match(body, /already-claimed/)
  assert.match(body, /growthTaskClaimPath\(credential, code\)/, '不得硬编码单一区路径')
})

check('fetchGrowthTasks 双读 code/task_code 与 status/accept_status', () => {
  const start = SRC.indexOf('export async function fetchGrowthTasks')
  const body = SRC.slice(start, start + 1400)
  assert.match(body, /entry\.code\) \?\? text\(entry\.task_code\)/)
  assert.match(body, /text\(entry\.status\) \?\? text\(entry\.accept_status\)/)
})

check('runGrowthSweep 不再内联 target>0 判定，改用 isGrowthTaskClaimable', () => {
  const body = SRC.slice(SRC.indexOf('export async function runGrowthSweep'))
  assert.match(body, /if \(!isGrowthTaskClaimable\(task\)\) continue/)
  assert.match(body, /typeof task\.rewardCredit === 'number'/)
})

check('runGrowthTrip 对国际版短路', () => {
  const body = SRC.slice(SRC.indexOf('export async function runGrowthTrip'), SRC.indexOf('export async function fetchGrowthTasks'))
  assert.match(body, /regionOf\(credential\?\.domain\) === 'global'\) return \{ dispatched: false, reason: 'no-trip-in-region' \}/)
})

check('源码不含真实凭据', () => {
  assert.doesNotMatch(SRC, /eyJhbGciOiJSUzI1NiIs/, '不得含 JWT')
  assert.doesNotMatch(SRC, /ACCOUNT_[0-9A-F]{8}/, '不得含 credentialRef 实例')
})

check('源码不引用 .probe/ 路径（该目录不进 git）', () => {
  assert.doesNotMatch(SRC, /\.probe\//, '注释里不得引用 .probe/')
})

console.log(`\n${'='.repeat(60)}`)
if (failures.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言（离线 mock，无网络/无凭据）`)
  process.exitCode = 0
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`)
  for (const failure of failures) console.log(`   · ${failure.name}: ${failure.message}`)
  process.exitCode = 1
}
