# DSH 账号中心（dsh-auth-hub）

**一个插件管全部账号渠道**：13 个渠道的登录 / 账号池 / 积分领取已经内置（原属
`dsh-our-free-model`），WorkBuddy 双区登录复用 `dsh-workbuddy`。

- 页面位置：`设置 → 账号中心`（`settings.section`，`order: 17`）
- 界面：DSH WorkBuddy 的设置卡风格（同款边框、折叠箭头、分区、账号行、chip、胶囊按钮，
  颜色全部来自 `--dsw-alias-*` 主题变量）

## 五个分区

| 分区 | 内容 |
| --- | --- |
| **渠道账号** | 13 个渠道的账号 / 余额 / 签到状态。**折叠状态就显示**「N 个账号 · 余额 X · 今日已签」；展开可登录、领取、刷新余额、续期、停用、删除 |
| **按模型** | 只看**账号渠道**：模型来自内置 channel-pack 的 `model.list` RPC。展开可见它落在哪些渠道、渠道下有哪些账号与余额，并可「加入轮换草稿」；**轮换组的管理与说明也在这里** |
| **积分上限** | **每账号**每天最多消耗多少积分（附整渠道上限）；已用量 = 余额**逐包**差分，签到/充值/到期都不计入 |
| **WorkBuddy** | 国内版 / 国际版：登录、切换账号、签到、自动签到开关、余额 |

## 迁移：账号渠道已内置

`vendor/channel-pack/pack.js`（2.9MB，原属 `dsh-our-free-model`）现在由本插件持有并加载，
`channel-pack.js` 负责调用 `pack.apply(ctx, …)`。它会自己：

- 用 `ctx.llm` 注册 13 个渠道适配器（codearts / buddy / workbuddy / lobsterai / qoder /
  qodercn / trae / cline / loomy / raccoon / minimax / zcode / gemini）
- 读 `$DSH_HOME/channel-pack/state.json` 账号池、`$DSH_HOME/.credentials.yaml` 凭据
- 在本插件的 web 服务上自挂 `/api/channel-pack`（connection RPC）与
  `/api/channel-pack/captcha-carrier`（ZCode 验证码载体页）

**所以不再需要装 `dsh-our-free-model`。** 验证方式见下方「迁移验收」。

### 重复项如何合并

| 重复的东西 | 处理 |
| --- | --- |
| 账号池 / 凭据存储 | 只保留内置 pack 那一份（`state.json` + `.credentials.yaml`），两个插件不再各存一份 |
| WorkBuddy 登录 | 打包内 `workbuddy` 渠道（腾讯 OAuth，刷新走 `X-Refresh-Token`）由内置 pack 提供；`dsh-workbuddy` 的**双区登录 + 心跳 + 成长任务**是独立一套，继续复用未重写 |
| 模型目录 | 只用内置 pack 的 `model.list`；**不用** `/api/our-free-model/combos`（那份只含 free / kilo / eac 免费车道）。轮换组另见下节 |
| 签到 | 内置 pack 的开机自动签到（含 10:05 UTC+8 重试补丁）+ 本页「自动补签」；`dsh-workbuddy` 只管它自己的国内版签到 |

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

- 游标在进程内（重启只丢一个起点，与上游 combos 同一取舍）；GET 用 `peek` 预览，
  **不推进游标** —— 读接口不改变路由行为。
- 存 `$DSH_HOME/channel-pack/rotations.json`，经 `GET/POST /plugins/dsh-auth-hub/rotations` 读写。
- 单测：`D:\linshi\ofm-debug\rotation-test.mjs`（27 项）+ `router-test.mjs`（32 项）
  + `host-smoke-test.mjs`（27 项，含「组真的注册成 provider」的端到端验证）。

## 积分上限（每账号）

- 口径是**积分**（账号渠道按积分扣费），不是请求次数或 token。
- **上限是每账号的**：`usage-policy.json` 的 `accounts` 表，一个渠道下多个账号各算各的；
  某个账号用满只是它自己不再被选中，不会拖累同渠道的其它账号。整渠道上限（`providers`）
  保留，两者是「且」的关系。
- 已用量靠**余额差分**，但是**逐包**比较剩余量（v2 台账）：
  - 签到 / 充值**新建或加量**的包 → 贡献 0（`max(0, prev-cur)` 天然排除）；
  - 到期失效的包 → `remaining` 不变，也贡献 0；
  - 签到**不会冲抵**当天已用量。
  - 只给得出 `total` 的渠道退回总量差分，并把**领取量**加回去：pack 的本地补丁 5 在
    领取成功时写 `grants[]`，所以「领了又用掉」也能算清真消耗。
- 执行者：内置 pack 的本地补丁 5（`getAvailableAccount()` 在候选里**逐个剔除**，见
  `ofm-local-patches.md`）。留空/0 = 不限；文件不存在 = 完全不过滤。
- 仍诚实的两条边界：没查过余额的账号没数据；两次查询之间的消耗会在下一次查询时
  一次性计入（按查询时刻归日）。
- 单测：`D:\linshi\ofm-debug\cap-test\credit-test.mjs`（19 项）+
  `cap-test\account-cap-test.mjs`（32 项：逐包差分 / 签到排除 / grants 对账 / v1 迁移）。

## Host 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/plugins/dsh-auth-hub/status` | 内置 pack 与**轮换路由**的挂载状态 + `controlKey` + 文件路径 |
| GET/POST | `/plugins/dsh-auth-hub/policy` | 每账号积分上限（v3，写需 `controlKey`） |
| POST | `/plugins/dsh-auth-hub/credit-sample` | 余额快照（写需 `controlKey`） |
| POST | `/plugins/dsh-auth-hub/credit-grant` | 补录一次领取量（写需 `controlKey`） |
| GET/POST | `/plugins/dsh-auth-hub/rotations` | 轮换组（写需 `controlKey`，并广播目录刷新） |

写操作都校验控制键（缺键 403）；`controlKey` 每进程随机、由 `/status` 下发。

## 迁移验收（实测）

新建纯净 profile `hubonly`，**只装 `dsh-auth-hub`**（`node_modules` 里没有
`dsh-our-free-model`、也没有 `dsh-workbuddy`），启动后：

- `channelPack.state = ready`
- `status.backends` 里 `channel-pack=False`（外部插件确实不存在）
- 用会话访问 `/api/channel-pack` 的 `account.list` → **HTTP 200**，返回真实 CodeArts 账号
  `mm_9527`（`credentialRef: CODEARTS_ACCOUNT_4735B115`）
- 客户端启动图里只有 `dsh-auth-hub/client.js`，没有 `dsh-our-free-model/client.js`
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
   （换渠道 / 新开会话），对齐上游 2.5.7。
4. **回归测试 29 项**：`D:\linshi\ofm-debug\cap-test\buddy-identity-test.mjs`
   （#544 直连矩阵全变体 + wire 数组集成路径 + 长工具会话形态）。

## 安装

桌面端 profile 由 Electron 应用独占管理，命令行不能直接装。两种装法：

1. **应用内插件管理器**：从本地文件夹安装 `D:\linshi\dsh-auth-hub`。
2. **手工真实目录安装**（当前状态）：
   - 复制本目录到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-auth-hub/`
     （**必须是真实目录，不能是符号链接 / junction**）
   - `package.json` 的 `dsh.profile.bundles` 末尾追加 `"dsh-auth-hub"`
   - 重启应用

## 已知边界

- 渠道账号栏依赖 shell 提供 `connection` 服务；拿不到时显示提示而不是报错。
- `/api/*` 有 browser-trust 围栏，只能在本 shell 页面里用（curl 需带会话 cookie）。
- WorkBuddy 国际版没有签到接口（按钮置灰并写明）。
- 「自动补签」需要页面开着；关掉后靠内置 pack 的开机签到 + 10:05 重试。
- 轮换组的游标不持久化（重启换起点）。
- 轮换组**一旦被会话选中就是会话的模型**：删掉或停用该组后，旧会话仍保存着
  `auth-hub/<组id>`，请求会得到「轮换组不存在或已停用」的明确失败 —— 重选模型即可。
- 轮换的**候选顺序**以组配置为准，`least-used` 按渠道级已用量排序（不是账号级）。
- `dsh-workbuddy` 目前没有替代：它的双区 OAuth 与心跳是独立实现，本插件直接复用。