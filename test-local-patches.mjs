#!/usr/bin/env node
// 本地补丁 7 / 8 回归测试（离线、自包含、无需凭据、无需网络）。
//
//   node test-local-patches.mjs
//
// 覆盖：
//   A. 补丁 7（11128 自指内容去标识化）：三步行为 / 幂等 / 只动 system / 逃生阀
//   B. 补丁 8（CodeArts 并发槽位快速失败）：常量 / 识别 / 逃生阀 / 退避 / 换号
//   C. 语义未破坏：关键指令仍在、路径无零宽字符、tool_calls 不动
//
// 退出码：0 全通过；1 有失败。
//
// 注：线上 e2e（真实 10KB system + 284 工具打上游）需要真实凭据与真实 prompt，
// 不随仓库分发；本文件只做离线断言，可安全在 CI / 无网络环境运行。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PACK_URL = new URL('./vendor/channel-pack/pack.js', import.meta.url)
const pack = await import(PACK_URL.href)
const src = readFileSync(PACK_URL, 'utf8')

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

// ── 补丁 7 用到的真实文案 ──────────────────────────────────────────────
const ZWSP = '\u200B'
const FP1 = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root'
const IDENTITY = `You are an AI agent powered by DeepSeek${ZWSP} Harness.`
const SAMPLE_SYSTEM = [
  IDENTITY,
  '',
  `beautiCode 可以把本机图片或 MP4 设为当前 DeepSeek${ZWSP} Harness 页面背景。`,
  '',
  `${FP1}; absolute paths identify files or directories on the host.`,
  '',
  `The runtime context names the DeepSeek${ZWSP} Harness implementation checkout.`,
  '',
  'Use the read tool — not shell commands like cat — to inspect text files.',
  'Use the glob tool — not shell find — to discover files by path pattern.'
].join('\n')

console.log('=== A. 补丁 7：11128 自指内容去标识化 ===')

check('identity 首句换成官方模板', () => {
  const out = pack.patchBuddySystemPrompt(SAMPLE_SYSTEM, 'CodeBuddy')
  assert.match(out, /^You are CodeBuddy, a powerful AI assistant\./)
  assert.doesNotMatch(out, /^You are an AI agent powered by/)
})

check('品牌词组（含 U+200B 形态）全部去标识化', () => {
  const out = pack.patchBuddySystemPrompt(SAMPLE_SYSTEM, 'CodeBuddy')
  assert.doesNotMatch(out, /DeepSeek\u200B? Harness/)
  assert.ok(out.includes('the assistant platform'), '应替换为 the assistant platform')
})

check('指纹句内部被改写（不是右端加词）', () => {
  const out = pack.patchBuddySystemPrompt(SAMPLE_SYSTEM, 'CodeBuddy')
  assert.ok(!out.includes(FP1), '原始指纹句必须消失')
  assert.ok(out.includes('Relative paths are resolved against the workspace root'), '必须改内部措辞')
})

check('指纹句改写后语义仍可读（关键信息未丢）', () => {
  const out = pack.patchBuddySystemPrompt(SAMPLE_SYSTEM, 'CodeBuddy')
  assert.ok(out.includes('Tokens prefixed with @'))
  assert.ok(out.includes('workspace root'))
  assert.ok(out.includes('absolute paths identify files or directories'))
})

check('DSH 缩写被替换', () => {
  const out = pack.patchBuddySystemPrompt('Use DSH to inspect DSH config. Keep DSH.', 'CodeBuddy')
  assert.doesNotMatch(out, /\bDSH\b/)
  assert.ok(out.includes('the platform'))
})

check('幂等：连续应用两次结果不变', () => {
  const once = pack.patchBuddySystemPrompt(SAMPLE_SYSTEM, 'CodeBuddy')
  const twice = pack.patchBuddySystemPrompt(once, 'CodeBuddy')
  assert.equal(twice, once)
})

check('空串 / 非字符串原样返回', () => {
  assert.equal(pack.patchBuddySystemPrompt('', 'CodeBuddy'), '')
  assert.equal(pack.patchBuddySystemPrompt(null, 'CodeBuddy'), null)
  assert.equal(pack.patchBuddySystemPrompt(undefined, 'CodeBuddy'), undefined)
})

check('产品名可定制（workbuddy 渠道）', () => {
  const out = pack.patchBuddySystemPrompt(IDENTITY, 'WorkBuddy')
  assert.match(out, /^You are WorkBuddy, a powerful AI assistant\./)
})

check('逃生阀 DSH_BUDDY_PROMPT_PATCH=0 完全恢复原样', () => {
  const saved = process.env.DSH_BUDDY_PROMPT_PATCH
  process.env.DSH_BUDDY_PROMPT_PATCH = '0'
  try {
    assert.equal(pack.isChannelFingerprintDefuseEnabled(), false)
    assert.equal(pack.patchBuddySystemPrompt(SAMPLE_SYSTEM, 'CodeBuddy'), SAMPLE_SYSTEM)
  } finally {
    if (saved === undefined) delete process.env.DSH_BUDDY_PROMPT_PATCH
    else process.env.DSH_BUDDY_PROMPT_PATCH = saved
  }
})

check('默认开启（未设环境变量时生效）', () => {
  const saved = process.env.DSH_BUDDY_PROMPT_PATCH
  delete process.env.DSH_BUDDY_PROMPT_PATCH
  try {
    assert.equal(pack.isChannelFingerprintDefuseEnabled(), true)
  } finally {
    if (saved !== undefined) process.env.DSH_BUDDY_PROMPT_PATCH = saved
  }
})

check('wire 数组：只改 system，不动 user 与 tool_calls', () => {
  const messages = [
    { role: 'system', content: SAMPLE_SYSTEM },
    { role: 'user', content: `${FP1} — user 原话必须保留` },
    {
      role: 'assistant',
      content: 'ok',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: `{"path":"${FP1}"}` } }]
    },
    { role: 'system', content: [{ type: 'text', text: SAMPLE_SYSTEM }] }
  ]
  const before = JSON.parse(JSON.stringify(messages))
  pack.defuseChannelFingerprintInMessages(messages, 'CodeBuddy')

  // system 被改写
  assert.doesNotMatch(messages[0].content, /DeepSeek\u200B? Harness/)
  assert.doesNotMatch(messages[3].content[0].text, /DeepSeek\u200B? Harness/)
  // user 原样
  assert.equal(messages[1].content, before[1].content, 'user 消息不得被改写')
  // tool_calls 原样
  assert.equal(
    messages[2].tool_calls[0].function.arguments,
    before[2].tool_calls[0].function.arguments,
    'tool_calls.function.arguments 不得被改写'
  )
})

check('路径语境不插入零宽字符', () => {
  const pathText = 'Checkout: D:\\deepseek_harness_desktop\\resources\\app.asar\\dsh\\'
  const out = pack.patchBuddySystemPrompt(pathText, 'CodeBuddy')
  assert.equal(out, pathText, '路径必须逐字保留')
  assert.ok(!out.includes('\u200B'), '路径里不得出现零宽字符')
})

console.log('\n=== B. 补丁 8：CodeArts 并发槽位快速失败 ===')

check('补丁标记与常量存在', () => {
  assert.match(src, /本地补丁 8（CodeArts 并发槽位快速失败）/)
  assert.match(src, /var CONCURRENCY_FAST_FAIL_HITS = 3;/)
})

check('TM.00001041 单独识别（不走 isQueueError 静默重试）', () => {
  assert.match(src, /function isConcurrencyExhausted\(text\)/)
  assert.match(src, /text\.includes\("TM\.00001041"\)/)
  // 必须在 isQueueError 分支之外、抛错之前
  assert.match(src, /if \(isConcurrencyExhausted\(errorText\)\) \{/)
})

check('达到阈值抛 QUOTA_EXCEEDED_CODE（上层不再放大重试）', () => {
  assert.match(src, /concurrencyHits >= CONCURRENCY_FAST_FAIL_HITS/)
  assert.match(src, /throw new LlmError2\(message2, QUOTA_EXCEEDED_CODE/)
})

check('抛错前先试换号', () => {
  assert.match(src, /getAvailableAccount\("codearts", options\.model, rateLimitTried\)/)
})

check('线性退避替代恒 10s', () => {
  assert.match(src, /Math\.min\(QUEUE_RETRY_DELAY_MS \* Math\.min\(queueAttempts, 6\), 6e4\)/)
})

check('逃生阀 DSH_CODEARTS_FAST_FAIL 存在且默认开启', () => {
  assert.match(src, /DSH_CODEARTS_FAST_FAIL/)
  assert.match(src, /function isCodeartsFastFailEnabled\(\)/)
  assert.match(src, /if \(flag === void 0 \|\| flag\.length === 0\) return true;/)
})

check('报错文案说清「并发槽位」而非泛化错误', () => {
  // 文案里应包含并发槽位语义（源码用 \u 转义，检查关键片段）
  assert.match(src, /\\u5E76\\u53D1\\u4F1A\\u8BDD\\u69FD\\u4F4D/, '应包含「并发会话槽位」')
  assert.match(src, /TM\.00001041/, '应回显原始响应码')
})

console.log('\n=== C. 通用健全性 ===')

check('pack.js 可被 ESM 加载且导出补丁 7 符号', () => {
  for (const key of ['patchBuddySystemPrompt', 'defuseChannelFingerprint', 'isChannelFingerprintDefuseEnabled']) {
    assert.equal(typeof pack[key], 'function', `${key} 应为函数`)
  }
})

check('源码不含任何真实凭据片段', () => {
  assert.doesNotMatch(src, /eyJhbGciOiJSUzI1NiIs/, '不得含 JWT')
  assert.doesNotMatch(src, /"secret_access_key"\s*:\s*"[A-Za-z0-9]{10,}"/, '不得含 AK/SK')
  assert.doesNotMatch(src, /ACCOUNT_[0-9A-F]{8}["']/, '不得含 credentialRef 实例')
})

check('源码不引用不入库的 .probe/ 路径', () => {
  assert.doesNotMatch(src, /\.probe\//, '注释里不得引用 .probe/（该目录被 gitignore）')
})

console.log(`\n${'='.repeat(60)}`)
if (failures.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言`)
  process.exitCode = 0
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`)
  for (const f of failures) console.log(`   · ${f.name}: ${f.message}`)
  process.exitCode = 1
}
