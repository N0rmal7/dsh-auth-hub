/**
 * 账号渠道加载器：把内置的 channel-pack（渠道的登录 / 账号池 / 积分）挂进本插件。
 *
 * 迁移说明（2026-10-21）：这份 `vendor/channel-pack/pack.js` 原属 `dsh-our-free-model`，
 * 现由本插件自己持有并加载，所以**不需要再安装 `dsh-our-free-model`**。
 * 由 `pack.apply(ctx, config)` 自己完成：
 *   - 用 `ctx.llm` 注册账号渠道适配器（codearts / buddy / workbuddy / lobsterai /
 *     qoder / qodercn / trae / cline / loomy / raccoon / minimax / zcode / gemini）
 *   - 账号池落 `$DSH_HOME/channel-pack/state.json`，凭据落 `$DSH_HOME/.credentials.yaml`
 *   - 在本插件的 web 服务上自挂 `/api/channel-pack`（connection RPC）与验证码载体页
 *
 * 因此本文件只负责三件事：等依赖服务上线、调 `apply`、把失败变成一行可读日志。
 */

/** channel-pack 需要的宿主服务。缺任何一个都不挂载，但本插件其余部分照常加载。 */
export const CHANNEL_PACK_DEPS = ['credentials', 'commands', 'llm']

/**
 * @param {object} ctx      cordis context（必须已注入依赖服务）
 * @param {object} options
 * @param {boolean} [options.disableOpencode] 是否禁用 opencode 渠道
 * @param {object} [options.outlet]           出口代理（本插件不接，留空 = 直连）
 * @param {(message: string) => void} [options.warn]
 * @param {(message: string) => void} [options.info]
 * @returns {Promise<{ ok: boolean, pack?: object, error?: string }>}
 */
export async function mountChannelPack(ctx, options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const info = typeof options.info === 'function' ? options.info : () => {}
  let pack
  try {
    pack = await import('./vendor/channel-pack/pack.js')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn(`auth-hub: 内置 channel-pack 载入失败：${reason}`)
    return { ok: false, error: reason }
  }
  if (typeof pack.apply !== 'function') {
    const reason = '内置 channel-pack 缺少 apply()'
    warn(`auth-hub: ${reason}`)
    return { ok: false, error: reason }
  }
  try {
    pack.apply(ctx, {
      // opencode 免费档在「不在 opencode 里」时恒 403（已实测），开着只会制造噪音。
      disableOpencode: true,
      ...(options.outlet === undefined ? {} : { outlet: options.outlet }),
    })
    info('auth-hub: 内置 channel-pack 已挂载（账号渠道清单由 platform.list 动态下发）')
    return { ok: true, pack }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn(`auth-hub: 内置 channel-pack 挂载失败：${reason}`)
    return { ok: false, error: reason }
  }
}