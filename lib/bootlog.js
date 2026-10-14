// 启动诊断：把"插件被加载时到底拿到了什么"写进文件。
//
// 为什么需要它：插件在组合包层被挂载时，可能**没有 agent 作用域**，
// 于是 ctx.get('tools') 返回 undefined，我的代码走守卫直接 return——
// 表现就是"插件装上了、schema 也读到了、但工具一个都不出现、判据一条都不写"。
//
// 现象和推断我已经分不清了，所以让它自己说。
// 输出：$DSH_HOME/dsh-soul-boot.log（追加写，一眼能看出每次启动拿到了什么）
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const LOG = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-soul-boot.log');

/**
 * 记一行。**绝不抛**——诊断代码自己出错就等于没有诊断。
 */
function line(tag, obj) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    appendFileSync(LOG, `${stamp} [${tag}] ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`, 'utf8');
  } catch { /* 诊断失败不影响主流程 */ }
}

/** 安全地尝试拿一个服务，不抛。 */
function tryService(ctx, key) {
  try {
    const v = ctx.get(key);
    if (v === undefined || v === null) return { present: false };
    const methods = typeof v === 'object'
      ? Object.keys(v).filter((k) => typeof v[k] === 'function').slice(0, 12)
      : [];
    return { present: true, kind: typeof v, methods };
  } catch (e) {
    return { present: false, error: String(e?.message ?? e) };
  }
}

/** 安全地看一眼 ctx 上有哪些域。 */
function tryScope(ctx) {
  try {
    const sc = ctx.scope ?? ctx[Symbol.for('cordis.scope')] ?? null;
    return sc ? String(sc) : '(无 scope 属性)';
  } catch { return '(取不到)' }
}

/**
 * 在 apply 的三个时点各记一次：进入 / 拿到什么 / 决定做什么。
 * @param {object} ctx 插件上下文
 * @param {object} config 已解析的配置
 */
export function bootLog(ctx, config) {
  line('boot', {
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    keys: Object.keys(config ?? {}).slice(0, 20),
  });
  line('ctx.services', {
    tools: tryService(ctx, 'tools'),
    systemPrompt: tryService(ctx, 'systemPrompt'),
    agents: tryService(ctx, 'agents'),
    session: tryService(ctx, 'session'),
    settings: tryService(ctx, 'settings'),
    logger: tryService(ctx, 'logger'),
  });
  line('ctx.scope', tryScope(ctx));
  try {
    line('ctx.ownKeys', Object.getOwnPropertyNames(Object.getPrototypeOf(ctx)).slice(0, 40));
  } catch (e) {
    line('ctx.ownKeys', 'FAILED: ' + String(e?.message ?? e));
  }
}

/** 记一条决策（比如"拿不到 tools，所以不注册"）。 */
export function bootDecision(tag, detail) {
  line('decision:' + tag, detail);
}

export { LOG as BOOT_LOG_PATH };
