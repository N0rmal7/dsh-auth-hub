const PLATFORM_APPEARANCE = {
      workbuddy: { label: 'WorkBuddy 渠道', hint: '浏览器授权登录' },
      buddy: { label: 'CodeBuddy', hint: '浏览器授权登录' },
      codearts: { label: '华为 CodeArts', hint: '浏览器授权登录（AK/SK）' },
      qoder: { label: 'Qoder 国际版', hint: '浏览器授权登录' },
      qodercn: { label: 'Qoder 国内版', hint: '浏览器授权登录 · 每日 10:00 刷新' },
      trae: { label: 'TRAE', hint: '浏览器授权登录' },
      cline: { label: 'Cline', hint: '设备码轮询' },
      lobsterai: { label: '有道 LobsterAI', hint: '扫码 / 短信' },
      loomy: { label: '讯飞 Loomy', hint: '扫码 / 短信' },
      raccoon: { label: '商汤 Raccoon', hint: '浏览器授权登录' },
      minimax: { label: 'MiniMax', hint: '浏览器授权登录' },
      zcode: { label: 'ZCode / Z.ai', hint: '需要过验证码' },
      gemini: { label: 'Gemini', hint: '浏览器授权登录' },
      kimi: { label: 'Kimi Code', hint: 'OAuth 设备码（浏览器输入 user code）' },
      opencode: { label: 'OpenCode', hint: '免费档（常被限流）' },
    }

    /**
     * 未在字典里的 provider 的兜底外观。
     *
     * 之所以要兜底而不是丢弃：第三方渠道插件（Kimi Code / Command Code /
     * SuperGrok …）注册到 `ctx.llm` 后本插件就能给它们做轮换与积分上限，
     * 但它们的名字本插件不认识。丢弃等于「装了也用不上」。
     */
    
const fallbackPlatform = provider => ({
      provider,
      label: provider.charAt(0).toUpperCase() + provider.slice(1),
      hint: '第三方渠道（由其它插件注册）',
      unknown: true,
    })

    /** 把 host 给的 provider id 列表套上外观。顺序以 host 为准（注册顺序）。 */
    
const buildPlatforms = providers => (Array.isArray(providers) ? providers : [])
      .filter(provider => typeof provider === 'string' && provider !== '')
      .map(provider => (PLATFORM_APPEARANCE[provider] !== undefined
        ? { provider, ...PLATFORM_APPEARANCE[provider] }
        : fallbackPlatform(provider)))

    /**
     * 兜底清单：仅当 `platform.list` 取不到时用（旧版 host / RPC 未就绪）。
     * 必须与 host 侧的 `modelAdapters` 键保持一致，否则会显示不存在的渠道。
     */
    
const FALLBACK_PLATFORMS = buildPlatforms([
      'workbuddy', 'buddy', 'codearts', 'qoder', 'qodercn', 'trae',
      'cline', 'lobsterai', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
    ])

    /**
     * WorkBuddy 两态：国际版走 www.workbuddy.ai，国内版与 CodeBuddy 共用
     * copilot.tencent.com（所以「国内版」在渠道上就是 CodeBuddy 那一条）。
     * 两者都由内置 pack 提供登录与签到；成长中心由本插件补上。
     */
    
return { buildPlatforms, PLATFORM_APPEARANCE }