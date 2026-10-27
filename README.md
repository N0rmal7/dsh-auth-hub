# DSH 账号中心（dsh-auth-hub）

**一个插件管全部账号渠道**：13 个账号渠道的登录 / 账号池 / 积分领取内置在本插件里，
**外加一类自己加的签到渠道**（v0.4.0），WorkBuddy 国内版 / 国际版登录也在同一个页面。

- 页面位置：`设置 → 账号中心`（`settings.section`，`order: 17`）
- 界面：DSH 设置卡风格（同款边框、折叠箭头、分区、账号行、chip、胶囊按钮，
  颜色全部来自 `--dsw-alias-*` 主题变量）

## 五个分区

| 分区 | 内容 |
| --- | --- |
| **渠道账号** | 13 个内置渠道的账号 / 余额 / 签到状态。**折叠状态就显示**「N 个账号 · 余额 X · 今日已签」；展开可登录、领取、刷新余额、续期、停用、删除 |
| **签到渠道** | **自己加的**每日签到站点：粘一条 cURL 或选模板即可，每天自动签到、把奖励记进同一个积分台账 |
| **按模型** | 只看**账号渠道**：模型来自内置 channel-pack 的 `model.list` RPC。展开可见它落在哪些渠道、渠道下有哪些账号与余额，并可「加入轮换草稿」；**轮换组的管理与说明也在这里** |
| **积分上限** | **每账号**每天最多消耗多少积分（附整渠道上限）；已用量 = 余额**逐包**差分，签到/充值/到期都不计入 |
| **WorkBuddy** | 国内版 / 国际版：登录、切换账号、签到、自动签到开关、余额 |

## 签到渠道（v0.4.0 新增，v0.5.0 强化「白嫖」）

### 为什么是「声明式」而不是往 pack 里加渠道

内置 channel-pack 的 13 个渠道全是「官方客户端」形态：浏览器授权 / 扫码 / 设备码，
拿 OAuth 令牌，协议各自定制（CodeBuddy 的 `X-Conversation-*` 头、ZCode 的验证码、
CodeArts 的 AK/SK…）。**每加一个都要先逆向它的登录与请求**，是以周计的活，而且上游
一改版就失效。

但「每日签到」这件事本身极其同质：

```
POST/GET  某个 URL（带 Cookie 或 Bearer）
→ { code: 0, data: { reward: 20 } }
```

所以这里把它抽象成**一条 HTTP 模板 + 一组判定规则**。加一个渠道 = 在设置页填几个
字段，**不需要改代码、不需要重启**。

### 白嫖主线：New API 系中转站

AI 中转站绝大多数跑的是同一份开源代码（[New API](https://github.com/QuantumNous/new-api)
或它的前身 One API），签到协议**完全一致**：

| 项 | 值 |
| --- | --- |
| 端点 | `POST {站点}/api/user/checkin` |
| 成功 | `{ success: true, data: { quota_awarded: N, checkin_date } }` |
| 已签到 | `{ success: false, message: "今日已签到" }` |
| 鉴权 | `Cookie: session=…` + `New-Api-User: <数字用户ID>` |

字段名是 `quota_awarded`（见 `model/checkin.go` 的 `Checkin.QuotaAwarded`），
**不是 `quota`**——写错只会让奖励永远记 0，而且不会有任何报错。v0.4.0 的模板里
就是这个错，v0.5.0 已修。

于是「加一个中转站」被压成三种粒度：

| 方式 | 输入 | 适用 |
| --- | --- | --- |
| **⚡ 一键加中转站** | 域名 | 单个站，最快 |
| **⇥ 批量加中转站** | 一列域名 + 共用 Cookie/用户ID | 同时挂五六个站 |
| **粘 cURL** | 浏览器 Copy as cURL | 站点改过路径、或非 New API 系 |

前两种会：

1. 探 `GET /api/status`（或 `/api/about`）认这是不是 New API 系；
2. 依次试 `/api/user/checkin` 与 `/api/user/sign_in`（AnyRouter 系用后者）；
3. 自动填好端点、判定规则、奖励路径、`New-Api-User` 头。

批量导入**分两步**：先「解析预览」，看到列表没问题再「确认导入」。一次按下去把
20 个没验证的渠道写进去，之后每天全失败还得逐个删。

### ⚠️ Turnstile：白嫖的真实边界

新版 New API 的签到路由挂了 `TurnstileCheck()` 中间件
（[`router/api-router.go`](https://github.com/QuantumNous/new-api) 里
`selfRoute.POST("/checkin", middleware.TurnstileCheck(), controller.DoCheckin)`）。
开了这项的站点，**任何**粘 Cookie / 粘令牌的纯协议请求都会被拦——不是配置错了，
是站点要求真浏览器过 JS 挑战。

插件对这种情况的处理是**明确说出来**：探测时识别到挑战页会返回
`needsTurnstile: true` 并直接告诉你「纯协议签到会被拦」，而不是让你每天看着一条
含义不明的失败。识别不了的站点，渠道行上会一直显示「今日失败」，重试也救不了（见下）。

### 三种上手方式（界面里按省事程度排序）

1. **一键 / 批量加中转站**：见上，New API 系专用。
2. **粘 cURL**：浏览器 F12 → Network → 右键签到请求 → *Copy as cURL* → 粘进
   界面点「解析」。URL / Cookie / body / Content-Type 全自动拆出来。bash 版、
   Windows cmd 版（`^` 续行）、以及 Chrome 在 body 含引号时输出的 **ANSI-C
   `$'…'` 形态**都认。
   cURL 里若带 `New-Api-User`，会自动识别成 New API 并套用正确规则。
3. **选模板 / 手填**：`New API 系站点`、`Cookie + GET`、`Bearer + POST`、`表单 POST`。

### 判定规则（决定「到底算不算签成功」）

| 规则 | 作用 | 写法 |
| --- | --- | --- |
| `success` | 怎么算成功 | JSON 路径 + 等于（`success` = `true`、`code` = `0`），或响应正则 |
| `already` | 怎么算「今天已经签过」 | 同上，通常 `code=1001` 或 `/已签到/` |
| `reward` | 从哪儿抠奖励数额 | JSON 路径（`data.quota`）或正则捕获组 1 |

**顺序是先判 `already` 再判 `success`**：绝大多数站点重复签到时也返回 HTTP 200，
顺序反了会把「已签」记成「签到成功」并重复记奖励。

`success` 留空时按「HTTP 2xx 即成功」处理——够用，但强烈建议填上，否则站点返回
`{"code":500,"msg":"系统繁忙"}` 也会被当成功。

### 自动签到

- 判据是「UTC+8 的日期变了 **且** 已过该渠道的 `scheduleAt`」，60 秒一次轮询。
  用**幂等判据**而不是 `setTimeout` 算到下一个整点：机器休眠/唤醒后定时器会漂，
  而「比较日期与钟点」怎么漂都不会漏签或重签。
- 挂载 20 秒后先补一次（这就是「开机 30 秒内自动签到」）。
- 全局开关 `auto` + 「开机补签」`catchUpOnStart`：关掉补签后只签「刚好到这一个钟点」
  的渠道，避免启动瞬间把十几个站点连着打一遍（有些站点会对连续请求做风控）。
- 每个渠道可以各自设时间（默认 08:30）。

### 白嫖体验：知道自己有没有白到

光「签没签」不够。三个刻意加的观测点：

| 显示 | 回答的问题 | 数据来源 |
| --- | --- | --- |
| 最近 14 天格子（绿=签到 / 浅绿=已签 / 红=失败） | 这个站稳不稳？哪几天断了？ | `checkin-state.json` 的 `history[]` |
| 「近 7 天 +N」chip | 这周到底白到多少 | 同上，按奖励求和 |
| 「已连续 3 天失败，Cookie 多半过期了」 | 为什么突然签不上 | `consecutiveErrors` |

**连续失败次数**比「上次失败」有用得多：偶发一次谁都可能（站点抖一下），连着三天
只可能是 Cookie 过期——而 Cookie 过期是这套东西唯一的日常维护工作。

`history[]` 按天去重（同一天多次 `force` 重签只留最后一条）、最多留 30 天；界面
取最近 14 天画格子。

### 奖励怎么记账

签到成功且**不是**「已签到」时，按 `reward` 抠出的数额调
`recordCreditGrant()` 写进 `credit-usage.json` 的 `grants[]`。这样
「领了又用掉」不会被余额差分算成 0 消耗——口径与内置渠道的签到完全一致。
台账里 `provider` 用的就是渠道 id，所以按渠道看消耗时能对得上。

### 密钥怎么存

Cookie / Authorization / X-CSRF-Token 全部当密钥：

- 配置（`checkin-channels.json`）里**只留头的名字**（`headerNames`），值落在
  `checkin-secrets.json`；
- `GET /checkin` 只回**掩码**（`ses…lue`），非敏感头（Referer、Content-Type）才回原文；
- 保存时的合并语义是显式的：
  - `headers[name]` 非空 → 覆盖；
  - **不提交这个键** → 保持原值；
  - 名字出现在 `removeHeaders[]` → 删除。

  不用「空串」表达其中任何一种：空串既可能是「没改」也可能是「要删」，两种解释
  都试过，一种会让人永远清不掉过期 Cookie，另一种会让改个 Referer 就把 Cookie 洗掉。

### 边界（界面上也写着）

- **失败会重试**（v0.5.1 改）：默认隔 30 分钟再试、每天最多 3 次，均可调。这条
  是修掉「抖一次丢一天」缺陷后的取舍——签到失败最常见的原因是**网络抖一下**
  （DNS、超时、站点 502），而不是 Cookie 过期；两者在响应体上分不开，但不重试
  的代价是白丢一整天额度。次数上限则防止把过期 Cookie 打成刷单。
  渠道行上会显示「第 2/3 次失败 · N 分钟后重试」，重试在后台发生、看得见。
- **Cookie 会过期**（通常几天到几周）。过期后行上显示「今日失败」并连着失败数天，
  界面直接写「已连续 3 天失败，Cookie 多半过期了」，重贴一次即可。
- 这些渠道**只负责领额度，不提供模型**，所以不会出现在「按模型 / 轮换」里。
- 判据只看「当天是否已**成功**」，不看「距上次多久」——休眠一天后恢复不会连签
  两发；当天失败过的会在重试间隔之后再试。
- Turnstile 站点**无法通过重试解决**：人机校验每次都会拦，重试 3 次只是把
  「今日失败」确认三遍。这类站看行上的建议文案判断，别反复换 Cookie。

## 内置渠道包

`vendor/channel-pack/pack.js`（2.9MB）随插件一起分发，`channel-pack.js` 负责调用
`pack.apply(ctx, …)`。它会自己：

- 用 `ctx.llm` 注册 13 个渠道适配器（codearts / buddy / workbuddy / lobsterai / qoder /
  qodercn / trae / cline / loomy / raccoon / minimax / zcode / gemini）
- 读 `$DSH_HOME/channel-pack/state.json` 账号池、`$DSH_HOME/.credentials.yaml` 凭据
- 在本插件的 web 服务上自挂 `/api/channel-pack`（connection RPC）与
  `/api/channel-pack/captcha-carrier`（ZCode 验证码载体页）

**装这一个插件就够了**，账号池、凭据、模型目录、签到都由本插件自己提供。验证方式见
下方「安装验收」。

### 各部分数据来源

| 数据 | 来源 |
| --- | --- |
| 账号池 / 凭据存储 | 本插件内置 pack 的 `state.json` + `.credentials.yaml`，只有这一份 |
| 模型目录 | 内置 pack 的 `model.list`；轮换组另见下节 |
| WorkBuddy 登录 | 打包内 `workbuddy` 渠道（腾讯 OAuth，刷新走 `X-Refresh-Token`）；国内版 / 国际版的**双区登录 + 心跳 + 成长任务**由本插件的 `workbuddy-growth.js` 实现 |
| 签到 | 内置 pack 的开机自动签到（含 10:05 UTC+8 重试补丁）+ 本页「自动补签」，以及「签到渠道」那套自定义站点 |

## 轮换路由（2026-10-21 新增）

**为什么会有这一节**：旧版的 `rotation.js` 只是纯逻辑——算顺序、挑候选——但**没有任何
provider 用它**。结果是：用户在页面上辛苦拼出轮换组、保存成功，`/model` 里却**根本没有
这一项**（报障原文：「我找不到我创建的路由模型」）。

`rotation-router.js` 把它接到了模型目录上：

| 环节 | 行为 |
| --- | --- |
| 目录 | provider **`auth-hub`**（显示名「账号中心轮换」）→ 每个**启用且有成员**的轮换组是一个模型，名字形如 `deepseek-v4.1-flash（3 个候选）` |
| 选择 | 在输入框的模型选择器或 `/model` 里选它；保存组后广播 `llm/adapters-updated`，目录立刻刷新 |
| 执行 | 按策略算顺序（`fastball` / `round-robin` / `least-used`）→ 跳过今天已用满的候选 → 依次调下游；**首个 chunk 就失败**才换下一个 |
| 能力 | 透传组内第一个可用候选的上下文窗口、推理档位、输入模态；任何异常都退化为「无额外能力」，绝不让整个分组从选择器里消失 |
| 边界 | 成员指向自己时跳过（防递归）；已经产出内容后不再换人（半截的话不能拼两个模型） |

- 游标在进程内（重启只丢一个起点）；GET 用 `peek` 预览，
  **不推进游标** —— 读接口不改变路由行为。
- 存 `$DSH_HOME/channel-pack/rotations.json`，经 `GET/POST /plugins/dsh-auth-hub/rotations` 读写。

## 积分上限（每账号）

- 口径是**积分**（账号渠道按积分扣费），不是请求次数或 token。
- **上限是每账号的**：`usage-policy.json` 的 `accounts` 表，一个渠道下多个账号各算各的；
  某个账号用满只是它自己不再被选中，不会拖累同渠道的其它账号。整渠道上限（`providers`）
  保留，两者是「且」的关系。
- 已用量靠**余额差分**，但是**逐包**比较剩余量（v2 台账）：
  - 签到 / 充值**新建或加量**的包 → 贡献 0（`max(0, prev-cur)` 天然排除）；
  - 到期失效的包 → `remaining` 不变，也贡献 0；
  - 签到**不会冲抵**当天已用量。
  - 只给得出 `total` 的渠道退回总量差分，并把**领取量**加回去：内置 pack 在
    领取成功时写 `grants[]`，所以「领了又用掉」也能算清真消耗。
- 执行者：内置 pack 的账号选择逻辑（`getAvailableAccount()` 在候选里**逐个剔除**）。
  留空/0 = 不限；文件不存在 = 完全不过滤。
- 仍诚实的两条边界：没查过余额的账号没数据；两次查询之间的消耗会在下一次查询时
  一次性计入（按查询时刻归日）。

## Host 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/plugins/dsh-auth-hub/status` | 内置 pack、**轮换路由**、签到渠道的挂载状态 + `controlKey` + 文件路径 |
| GET/POST | `/plugins/dsh-auth-hub/policy` | 每账号积分上限（v3，写需 `controlKey`） |
| POST | `/plugins/dsh-auth-hub/credit-sample` | 余额快照（写需 `controlKey`） |
| POST | `/plugins/dsh-auth-hub/credit-grant` | 补录一次领取量（写需 `controlKey`） |
| GET/POST | `/plugins/dsh-auth-hub/rotations` | 轮换组（写需 `controlKey`，并广播目录刷新） |
| GET/POST | `/plugins/dsh-auth-hub/checkin` | 签到渠道（v0.4.0；写需 `controlKey`，密钥只回掩码） |
| POST | `/plugins/dsh-auth-hub/checkin-run` | 立即签到 `{ ids?, force? }`（写需 `controlKey`） |
| POST | `/plugins/dsh-auth-hub/checkin-parse` | 把 cURL 拆成草稿（写需 `controlKey`） |
| POST | `/plugins/dsh-auth-hub/checkin-probe` | 一键识别中转站 `{ origin, cookie?, userId? }`（写需 `controlKey`） |
| POST | `/plugins/dsh-auth-hub/checkin-import` | 批量生成中转站草稿 `{ sites, cookie?, userId? }`，**不写盘**（写需 `controlKey`） |

写操作都校验控制键（缺键 403）；`controlKey` 每进程随机、由 `/status` 下发。

## 签到渠道的数据文件

都在 `$DSH_HOME/channel-pack/` 下：

| 文件 | 内容 |
| --- | --- |
| `checkin-channels.json` | 渠道配置（**只有头的名字，没有值**） |
| `checkin-secrets.json` | Cookie / Authorization 的值 |
| `checkin-state.json` | 每个渠道的 `lastDay` / `lastStatus` / `streak` / `totalReward` |
| `checkin-settings.json` | `{ auto, at, catchUpOnStart }` |

## 安装验收（实测）

新建纯净 profile `hubonly`，**只装 `dsh-auth-hub`**，启动后：

- `channelPack.state = ready`
- `status.backends` 里 `channel-pack=False`（没有任何外部渠道插件）
- 用会话访问 `/api/channel-pack` 的 `account.list` → **HTTP 200**，返回真实 CodeArts 账号
  `mm_9527`（`credentialRef: CODEARTS_ACCOUNT_4735B115`）
- 客户端启动图里只有 `dsh-auth-hub/client.js`
- 轮换组写入 200、读取顺序稳定（`peek` 不推进）、无 key 403

## 渠道准入校验修复（issue #542/#544，2026-10-21）

CodeBuddy CN（`buddy`）网关对 system prompt 做**前缀匹配**：首句命中 DSH 默认 identity
句 `You are an AI agent powered by DeepSeek Harness.` 即返回 400 code 11128「request
illegal」——短请求正常、约 49 万 tokens 的长 agentic 会话必中（#542）。依据
[workbuddy-experts](https://github.com/vbarter/workbuddy-experts) 逆向的官方客户端
模板（CodeBuddy 与 WorkBuddy 是同一官方客户端），内置 pack 共打 4 处补丁：

1. **system 首句清洗**（`BuddyAdapter.stream()`）：序列化后的 **wire 数组**里，
   buddy / workbuddy 渠道的 system 消息首句 identity → 官方模板开场句
   `You are {productName}, a powerful AI assistant.`（`templates/workbuddy-prompt.tpl`），
   其余提示词逐字保留。清洗必须落在 wire 数组上——桌面端 identity 作为 system 消息
   存在于 `options.messages[]` 里，改 `options.system` 不生效（#544 评论区实测）。
   逃生阀：`DSH_BUDDY_IDENTITY_SCRUB=0` 恢复原样透传。
2. **X-Conversation-\* 三件套**（`BuddyAdapter.send()`）：buddy 渠道补齐与 workbuddy
   相同的 `X-Conversation-ID / X-Conversation-Message-ID / X-Conversation-Request-ID`
   会话头，对齐官方客户端的请求身份（#542 对照实验：带这套头的身份长会话正常）。
3. **11128 单独分类**：`isContentRejection()` 排除 11128——渠道校验按**请求**生效
   （#544 实测三个 buddy 账号表现一致），不再换号重试 + 写 30 分钟冷却；HTTP 400
   与流内两条路径都改为「渠道准入校验失败」错误，文案直接给可操作指引
   （换渠道 / 新开会话）。
4. **回归测试**：`buddy-identity-test.mjs`
   （#544 直连矩阵全变体 + wire 数组集成路径 + 长工具会话形态 + 品牌词中和）。

## 11128 二次修复：品牌词**子串**风控（v0.5.1）

补丁 4 只换了 system **首句**，但上游不是前缀匹配，而是**子串**匹配：请求体够大
（约 >1KB，真实 agentic 会话必满足）时，prompt 里任何位置出现 `DeepSeek Harness`
都会回 400 code 11128，上游原文 `Illegal API invocation from an unapproved channel`
（displayTips：「请求被拦截，请重新发送」）。真实 system prompt 里这个词组有十几处
（身份句、运行时上下文、工具结果、历史消息），所以补丁 4 仍会漏。

依据 [balongTTY/dsh-workbuddy-fix](https://github.com/balongTTY/dsh-workbuddy-fix)
的对照实验：同一 token、只改这一个词 —— 原文 0/5 失败、改后 5/5 成功；换账号 /
换域名 / 换客户端身份 / 补 13 个请求头全部无效。

**修法（本地补丁 6）**：零宽空格 U+200B 中和，`DeepSeek Harness` →
`DeepSeek\u200B Harness`。

- 模型读到的语义完全不变；删掉零宽字符可逐字还原（有回归测试断言）。
- 落在 `BuddyAdapter.stream()` 序列化后的 **wire 数组**上（所有消息的字符串
  content 与 `type: "text"` part），并覆盖 `options.system`。
- **跳过路径语境**（`(?<![\\/])…(?![\\/])`）：`D:\...\DeepSeek Harness\...`
  一个字都不动，否则模型会把坏路径交给工具调用。
- `tool_calls.function.arguments` 不动：那是模型产出的结构化参数，改它可能真的
  改坏一次写文件 / git 提交。
- 逃生阀沿用 `DSH_BUDDY_IDENTITY_SCRUB=0`（首句清洗与品牌词中和一起关闭）。

回归测试：`buddy-identity-test.mjs` 的 E 段 11 项（含路径跳过、语义可还原、
tool_calls 不动、JSON 可序列化）。

## 11128 三次修复：真正触发条件是**自指内容**，不是品牌词（v0.5.3）

⚠️ **上面 v0.5.1 的「品牌词子串风控」结论已被实测推翻**，补丁 6 对真实请求无效。

### 反证

同一账号、同样 4KB 体量，把 `DeepSeek Harness` 分别以**原样 / 零宽 U+200B / 全小写 /
全大写 / 换行拆开 / 制表拆开 / 只留 `DSH` / 只留单词** 发上去 —— **全部 200 放行**。
而真实 10KB system 原样发上去 —— **必 400 / 11128**。

### 真正触发的那句

DSH 运行时上下文里的一句固定短语：

```
Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root
```

匹配性质（约 150 次对照实验，每条 ≥2 次复跑）：

| 性质 | 实测 |
| --- | --- |
| 大小写 | **不敏感**（全小写 / 全大写 / 首字母大写 都拦） |
| 空白 | **逐字符精确**（句号后加空格、换行、制表**都放行**）—— 不是「空白归一化」，是这些改动直接破坏了精确子串 |
| 左右边界 | **都是硬边界**：删头 1 词即放行；右端截到 `workspace` 放行、到 `root` 才拦 |
| 是否需两句连读 | **是**：只发前半句或只发后半句都不拦 |
| 体量与位置 | **无关**：前后垫 0～4000 字符结论一致 |

> 早期「体量 >1KB 才触发」的结论是**假象**——前缀二分恰好切到这句造成的巧合。

### ⚠️ 关键教训：右端加词是无效修法

上游是**子串**匹配，`…workspace root` 在 `…workspace root directory` 里**仍是完整子串**，
照样 400。实测补 `directory` / `folder` / `dir` / 句号，连跑 3 次全部 400。
**只有改子串内部**（改词、换词序、换措辞）才能打破命中。

### 修法（本地补丁 7）

`patchBuddySystemPrompt()` 三步组合，只对 `role === 'system'` 生效：

1. identity 首句 → 官方模板 `You are {productName}, a powerful AI assistant.`
2. 品牌去标识化：`DeepSeek Harness`（含 U+200B 形态）→ `the assistant platform`，`DSH` → `the platform`
3. 指纹句**内部**改写：`Relative paths resolve from` → `Relative paths are resolved against`

ablation 显示**第 3 步单独即可放行**，另外两步是抵御上游规则变化的加固（多改无害）。

- `tool_calls.function.arguments` 不动；用户消息与工具结果里的这些词也不动。
- 逃生阀：`DSH_BUDDY_PROMPT_PATCH=0`（**独立**于 `DSH_BUDDY_IDENTITY_SCRUB`）。

**验收**：真实 10KB system + 284 工具 + 多轮历史，5 场景 × 3 次 —— 控制组 3/3 全 400、
方案组 12/12 全 200（`buddy-11128-regress.mjs`，55 项断言）。

## CodeArts 并发槽位：把 30 分钟静默重试改成 30 秒快速失败（v0.5.3）

**报错**：`400 {"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)…"}`，
**第一条请求就报**，不是用量耗尽。

### 这不是插件的 Chat-Id 泄漏

三重实测否定「上游按 Chat-Id 计并发」：

1. **完全不带** `Chat-Id` / `Session-Id` 发 chat —— 窗口内仍 200 正常出流；饱和时不带也照样 400。
2. 窗口内**全新 Chat-Id** 也能通过。
3. 隔离实验：固定 Session 变 Chat → 放行 2/3；固定 Chat 变 Session → 放行 2/3。
   **两个维度都不是闸门键**，计数键是**账号级 3 个槽位**。

`new CodeArtsAdapter` 只有 2 处（生产 / 诊断），**都没传** `chatId`/`sessionId`；
`dsh-llm` 是单实例注册表 —— **不存在「每 turn 新 Chat-Id」**。

> 所以「按账号持久化/派生 chatId」这条路**实测无收益**，不要做。

### 真问题：静默重试 30 分钟

`TM.00001041` 命中 `isQueueError()` 被当成「可重试排队」，HTTP 400 被吞掉 →
`10s × 180 次 ≈ 30 分钟`静默重试；而 `queryQueueStatus` 恒回 `working`，永不提前退出。
用户侧表现是**卡死不动**。

**修法（本地补丁 8）**：

- 单独累计 `concurrencyHits`，达 3 次即抛 `QUOTA_EXCEEDED`（**不在** `DEFAULT_RETRYABLE_CODES`，上层不再放大）。
- 抛错前先试 `getAvailableAccount` 换号（多账号时其它账号可能还有空槽位）。
- 退避改为线性 `min(10s × n, 60s)`，避免高频空转把 TPM 配额一起打爆。
- 逃生阀：`DSH_CODEARTS_FAST_FAIL=0` 恢复旧行为。

| | 修复前 | 修复后 |
| --- | --- | --- |
| 到报错 | **1800s（30 分钟）** | **30.0s** |
| 上游 chat 请求数 | 180 | 3 |
| 可见性 | 完全静默 | 明确说「并发槽位已满，稍后重试可能成功」 |

**如何区分「插件 bug」与「账号被占满」**：去掉所有会话头仍然 400 + 非 chat 签名端点
（`queue/status`）仍 200 + 过一段时间自己好了 = 账号侧槽位问题，不是插件 bug。

## 轮换组的推理档位翻译（v0.5.1）

**报错**：`provider "codearts" model "deepseek-v4.1-flash" does not support
reasoning effort "high"`。

**原因**：轮换组把同一模型的多个渠道并在一起，而各渠道对「思考档位」的命名完全
不统一——CodeArts 只有 `on` / `off`，buddy / workbuddy 用 `high` / `medium` / `max`。
会话里只存**一个** effort id（由组的首选候选的能力表决定），转发给另一个候选时它
未必认识；DSH 的 `resolveCallConfig` 明确「no clamping or aliasing is performed」，
于是在打上游之前直接抛 `UNSUPPORTED_REASONING_EFFORT`。

**修法**：`rotation-router.js` 在转发前按目标候选声明的能力表翻译档位
（`chooseEffort`）：

| 会话里的 effort | 目标候选声明 | 实际发给下游 |
| --- | --- | --- |
| `high` | `on` / `off`（CodeArts） | `on` |
| `on` | `high` / `medium` / `low`（buddy） | `high` |
| `max` | `low` / `high` / `max` | `max`（精确命中不动） |
| 任意 | 目标没有推理能力 | 删掉 `reasoningEffort`，走目标默认 |
| 未知方言 | 任意 | 目标 `defaultEffort`，再退第一个 |

档位按语义归一（`off < minimal < low < medium < high < xhigh < max`），
`on` / `default` / `auto` 视作 `high`；距离最近者优先，同距离取更低档。
能力表来自 `llm.resolveModelInfo()`（与 DSH 校验同源），带 5 分钟 TTL。

**还有第二层（v0.5.2）**：DSH 在**调用适配器之前**就用组的对外能力表校验会话里
保存的 `reasoningEffort`，所以组的能力表如果只取「第一个候选」，把组首换成
CodeArts（`on`/`off`）后，会话里存的 `high` 会在路由层被直接拒
（`provider "auth-hub" … does not support reasoning effort "high"`，请求根本到不了
`stream()`）。现在 `describeGroup()` 对**整组候选取并集**：

| 字段 | 合并规则 |
| --- | --- |
| 推理档位 | **并集**（按候选顺序去重）——只要任一候选认识该 id，会话就继续合法 |
| 默认档 | 第一个候选声明且仍在并集里的那个 |
| 上下文窗口 / 输出上限 | 取已知值的**最小**值，不夸大任何候选 |
| 输入模态 | **并集**（混入纯文本渠道不会关掉整组的看图） |
| systemPromptUpdate / toolUpdate | 所有候选一致才透传，否则用 DSH 默认 |

回归测试：`router-test.mjs` 的 E 段 11 项 + F 段 9 项（含「组首 codearts + 会话
high」的真实报障路径：路由层放行 → codearts 收 `on`、buddy 收 `high`）。

## 安装

桌面端 profile 由 Electron 应用独占管理，命令行不能直接装。两种装法：

1. **应用内插件管理器**：从本地文件夹安装 `dsh-auth-hub` 目录。
2. **手工真实目录安装**（当前状态）：
   - 复制本目录到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-auth-hub/`
     （**必须是真实目录，不能是符号链接 / junction**）
   - `package.json` 的 `dsh.profile.bundles` 末尾追加 `"dsh-auth-hub"`
   - 重启应用

## 测试

| 套件 | 覆盖 |
| --- | --- |
| `newapi-test.mjs` | New API 识别：响应体判定、域名严格校验、草稿生成、批量导入、`$'…'` cURL、五种站点形态的探测（成功 / 已签 / sign_in / Turnstile / 非 New API） |
| `checkin-test.mjs` | 规范化 / JSON Path / cURL 解析 / 判定顺序 / 奖励提取 / 状态推进 / **失败重试（间隔·上限·跨天重置）** / 历史与连续失败 / 执行器（本地 HTTP）/ 存储 / 批量 |
| `checkin-host-test.mjs` | Host 端到端：三份文件的读写、掩码、密钥合并与删除、cURL 路由、一键探测、批量导入、**失败后当天重试真的再发请求**、真打出去、grants 落账、删渠道清状态 |
| `checkin-client-smoke.mjs` | 浏览器半身：递归展开组件树，切到 `checkin` / 草稿分支 / 批量面板，断言关键控件真的渲染 |
| `host-smoke-test.mjs` | 轮换 provider 真的注册、积分上限、目录刷新 |
| `router-test.mjs` | 轮换路由：目录 / 顺序 / 回退 / **推理档位翻译** |
| `credit-test.mjs` / `account-cap-test.mjs` / `buddy-identity-test.mjs` | 积分台账 / 每账号上限 / 渠道准入校验（含品牌词中和） |

合计 300+ 项断言，覆盖签到、Host 端到端、New API 识别、组件渲染、轮换路由与品牌词中和。

## 已知边界

- 渠道账号栏依赖 shell 提供 `connection` 服务；拿不到时显示提示而不是报错。
- `/api/*` 有 browser-trust 围栏，只能在本 shell 页面里用（curl 需带会话 cookie）。
- WorkBuddy 国际版没有签到接口（按钮置灰并写明）。
- 「自动补签」需要页面开着；关掉后靠内置 pack 的开机签到 + 10:05 重试。
- **自己加的签到渠道**（v0.4.0）只覆盖「HTTP 一发 + JSON 判成败」这一形态：
  需要滑块验证码、需要微信扫码取 code、或成功与否只能靠人眼判断的站点，用这套
  规则接不了（那些得走内置渠道那种逆向路径）。
- **Turnstile 站点签不了**：新版 New API 的签到路由挂了 `TurnstileCheck()`，纯协议
  请求必被拦。插件会明确报出来（探测时 `needsTurnstile`，日常运行时「今日失败」），
  但不会去模拟浏览器——那是另一个量级的工程，且随时会被 CF 改版打回。
- **一键探测会真的发一次签到**：New API 只有签到接口本身能区分「成功」与「今日已签」，
  没有只读的试探办法。界面上写明了这一点；不想这样就走粘 cURL（那条路径不发请求）。
- 签到渠道的**密钥是明文**落在 `checkin-secrets.json`（与 `.credentials.yaml` 同级
  待遇）：它需要能在无人值守时自动签到，所以不能只存哈希。
- 轮换组的游标不持久化（重启换起点）。
- 轮换组**一旦被会话选中就是会话的模型**：删掉或停用该组后，旧会话仍保存着
  `auth-hub/<组id>`，请求会得到「轮换组不存在或已停用」的明确失败 —— 重选模型即可。
- 轮换的**候选顺序**以组配置为准，`least-used` 按渠道级已用量排序（不是账号级）。
- WorkBuddy 的**双区 OAuth + 心跳**由本插件的 `workbuddy-growth.js` 实现，与内置
  pack 的 `workbuddy` 渠道共用同一份账号池，但心跳与成长任务只有本插件这一套。
