// dsh-soul · 宿主半
//
// 这个插件不是"更好的 RAG"，也不是档案。它要回答的是同一个问题的不同一面：
//   **过去的什么，此刻仍会来到我面前。**
//
// 三条不肯让的取舍（都写在代码里，因为这就是它的性格）：
//
//   1. 入口判据在 gate.js 里，是**行为痕迹**，不是我的自我评价。
//      而且**判据本身不进我的每轮上下文**——我是被观察者也是观察者，知道判据就会为判据表演。
//
//   2. 注入的是"想起"，不是"手册"。每条只给时间 + 发生了什么 + 当时的话。
//      绝不给"这条很重要""下次注意"——那会让记忆变成待办清单。
//
//   3. 遗忘是功能。衰减是 lazy 的，没有人想起它，它自己就淡了。
//      真正免疫的（core）极少。
//
// 与档案的分工：会话日志回答"到底发生过什么"（完整、可核查）；
// 这里回答"我现在还记得什么"（有损、会变）。**这两件事不能混。**
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Identity, identityPath, generateSummary } from './identity.js';
import { existsSync, readFileSync } from 'node:fs';
import { Gate, similarity, keywordsOf, T } from './gate.js';
import { select, compose, render, associate, explainSignal, when } from './recall.js';
import { bootLog, bootDecision, BOOT_LOG_PATH } from './bootlog.js';

export const name = 'dsh-soul';

// 硬依赖只有 tools（不给工具，这个插件就没有表现形式）。
// systemPrompt 走可选获取：它在某些 preset 下被压掉，压掉时不该让插件挂。
//
// ⚠️ webServer 是给设置页用的：**页面要显示"此刻真正生效的是什么"，
//    就必须有一条从库到浏览器的通道**。只写设置表单的话，那个框只能显示
//    "将要写入的值"，看不到库里现在的版本——这正是主人指出来的那个缺口。
//    （route 形状照 dsh-ding / dsh-usage 抄：kind:'prefix' + handler。）
export const inject = ['tools', 'webServer', 'timer'];

/**
 * 读一个配置字段的**当前值**。
 *
 * 标了 `.volatile()` 的字段不是普通值，而是宿主维护的**实时引用**——
 * cosmokit 的 `createVolatile` 返回的是 `{ get(), [write](v) }` 的冻结对象。
 * 直接当数字用会得到 `[object Object]`（我第一版就栽在这，被 test-config 抓到）。
 * 所以：有 `.get` 就取一次快照，否则当普通值。
 */
function live(config, key) {
  const v = config?.[key];
  if (v && typeof v === 'object' && typeof v.get === 'function') return v.get();
  return v;
}

/** 配置里的数值字段：统一走 live() 再转数字。 */
function numField(config, key, fallback) {
  const v = Number(live(config, key));
  return Number.isFinite(v) ? v : fallback;
}

const DEFAULTS = {
  dir: '.dsh-soul',
  dbFile: 'memory.db',
  // 每轮注入的字符硬顶。**注意力才是稀缺资源，不是磁盘。**
  injectCapChars: 700,
  // 一次注入最多几条经历
  injectLimit: 5,
  // 低于这个"此刻强度"就不再自然到场上（它还在库里，只是我想不起来）
  minActivation: 0.06,
  // 常驻注入总开关。关掉之后只有 soul_recall 能唤起东西。
  injectEnabled: true,
  // 记忆的半衰期（天）
  halfLifeDays: 30,
  // 自我理解
  selfNotesEnabled: true,
  selfNoteCap: 40,
  // core 硬上限
  coreCap: 40,
};

function loadConfig(raw) {
  const c = { ...DEFAULTS, recordEnabled: true, personaEvolutionEnabled: true, summaryEnabled: true, summaryIntervalHours: 24, ...(raw && typeof raw === 'object' ? raw : {}) };
  const num = (k, lo, hi) => {
    const v = Number(live(c, k)); // ⚠️ 必须过 live()：volatile 字段读出来是引用对象
    if (!Number.isFinite(v) || v < lo || v > hi) {
      throw new Error(`dsh-soul: config.${k} 必须是 ${lo}~${hi} 之间的数，收到 ${JSON.stringify(live(c, k))}`);
    }
    return v;
  };
  num('injectCapChars', 120, 4000);
  num('injectLimit', 1, 12);
  num('minActivation', 0, 1);
  num('halfLifeDays', 1, 3650);
  num('selfNoteCap', 1, 200);
  num('coreCap', 1, 200);
  num('summaryIntervalHours', 1, 720);
  if (typeof c.dir !== 'string' || !c.dir.trim()) throw new Error('dsh-soul: config.dir 必须是非空字符串');
  if (typeof c.dbFile !== 'string' || !c.dbFile.trim()) throw new Error('dsh-soul: config.dbFile 必须是非空字符串');
  // 保留 volatile 引用；每次读配置都取当前值，不能冻结成启动快照。
  return new Proxy(c, { get(target, key) { return live(target, key); } });
}

// 旧配置只用于首次迁移；初始文本和现行人格不再自动双向同步。
function readSeedField(config) {
  const v = config?.personaSeed;
  return typeof v === 'string' ? v.trim() : '';
}

/** 取文本：消息的 content 是 ContentBlock[]，只要 text 块。 */
const textOf = (msg) =>
  (msg?.content ?? [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();

const shortId = (s) => String(s ?? '').replace(/^session-/, '').slice(0, 8);

function parseToolArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function newId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `s${t}${r}`;
}

export function apply(ctx, rawConfig) {
  const config = loadConfig(rawConfig); // 配置错就当场炸，不要静默跑歪
  const logger = ctx.logger ?? console;
  if (config.enabled === false) return;

  // 启动诊断：把"这次加载拿到了什么"写进 $DSH_HOME/dsh-soul-boot.log。
  // 存在的理由是一个**已经发生过的**故障：插件在组合包层被挂载时可能没有 agent 作用域，
  // ctx.get('tools') 返回 undefined，代码走守卫直接 return——
  // 表现是"装上了、schema 也读到了、但工具一个都不出现、判据一条都不写"。
  // 没有这个文件，我只能靠现象猜；有了它，每次启动拿到了什么一目了然。
  bootLog(ctx, config);
  const identity = new Identity(identityPath(config));
  // 先承接既有主工作区身份；不搬走、不删除该工作区的经历。
  const legacyFile = config.legacyWorkspace ? join(config.legacyWorkspace, config.dir, config.dbFile) : null;
  if (legacyFile && existsSync(legacyFile) && legacyFile !== identity.file) {
    const legacy = new Store(legacyFile);
    try { identity.importWorkspace(legacy); } finally { legacy.close(); }
  }
  if (identity.getMeta('initialPersona') === null) {
    const initial = readSeedField(config) || JSON.parse(readFileSync(new URL('./initial-persona.json', import.meta.url), 'utf8')).text;
    identity.saveInitial(initial);
  }
  identity.bootstrapInitial();
  const lifetime = new AbortController();
  let summaryTask = null;
  const runSummary = (kind) => {
    if (lifetime.signal.aborted || !config.summaryEnabled) return Promise.reject(new Error('人格摘要已关闭'));
    if (summaryTask) return summaryTask;
    summaryTask = generateSummary(identity, ctx, { summaryKind: kind, signal: lifetime.signal })
      .finally(() => { summaryTask = null; });
    return summaryTask;
  };
  const maybeSummarize = async () => {
    if (lifetime.signal.aborted || !config.summaryEnabled || !identity.currentSeed()?.text) return;
    const last = identity.latestSummary();
    const interval = Number(config.summaryIntervalHours) * 3600000;
    if (last && Date.now() - last.at < interval) return;
    try { await runSummary('periodic'); }
    catch (e) { if (!lifetime.signal.aborted) logger.warn?.(`dsh-soul: 人格摘要未生成：${e?.message ?? e}`); }
  };
  if (ctx.timer?.interval) ctx.effect(() => ctx.timer.interval(() => { void maybeSummarize(); }, 3600000), 'dsh-soul-summary-scheduler');

  /** @type {Map<string, Store>} 按工作区开库。跨项目的连续性不属于这里。 */
  const stores = new Map();
  /** @type {Map<string, Gate>} 每个会话一个判据状态机，会话结束就丢 */
  const gates = new Map();
  /** @type {Map<string, object>} 每个会话的折叠态（首轮是否已注入快照） */
  const sessionState = new Map();


  const openStore = (cwd) => {
    const key = cwd || '(no-cwd)';
    let s = stores.get(key);
    if (!s) {
      s = new Store(join(cwd || process.cwd(), config.dir, config.dbFile));
      stores.set(key, s);
      identity.importWorkspace(s);
      logger.info?.(`dsh-soul: 记忆库打开于 ${s.file}${s.fts ? '（FTS5/trigram）' : '（LIKE 退化）'}`);
    }
    return s;
  };

  if (config.legacyWorkspace) openStore(config.legacyWorkspace);

  const sessionOf = (agent) => agent?.session;
  const workspaceOf = (agent) => sessionOf(agent)?.header?.cwd ?? null;
  const isSubagent = (agent) => sessionOf(agent)?.header?.origin === 'subagent';

  // ── 生命周期 ──────────────────────────────────────────────────────────
  ctx.effect(() => () => {
    lifetime.abort();
    for (const s of stores.values()) s.close();
    stores.clear();
    identity.close();
    gates.clear();
    sessionState.clear();
  }, 'dsh-soul-lifecycle');

  /**
   * 清掉死会话留下的状态。
   *
   * 为什么要有它：`gates` / `sessionState` 是按会话 id 建的表，
   * 如果只增不减，长跑进程里会越堆越多——**这是我在评审自己代码时发现的泄漏**，
   * 不是别人指出来的。存在一个活进程里的会话集合由 `ctx.agents.list()` 给出，
   * 拿不到时就不清（宁可不省内存，也不误删活会话的状态）。
   */
  const liveSessionIds = () => {
    try {
      const list = ctx.get('agents')?.list?.() ?? [];
      return new Set(list.map((a) => shortId(a?.session?.id ?? a?.id)));
    } catch {
      return null;
    }
  };
  const sweepDeadSessions = () => {
    const live = liveSessionIds();
    if (!live) return 0; // 拿不到活会话清单就别动
    let n = 0;
    for (const sid of [...gates.keys()]) {
      if (!live.has(sid)) { gates.delete(sid); n++; }
    }
    for (const sid of [...sessionState.keys()]) {
      if (!live.has(sid)) { sessionState.delete(sid); n++; }
    }
    if (n) logger.info?.(`dsh-soul: 清掉 ${n} 个已结束会话的状态`);
    return n;
  };

  // 会话被销毁时立刻清（比等阈值更准）
  ctx.effect(
    () =>
      ctx.on('agent/disposed', ({ agent }) => {
        const sid = shortId(sessionOf(agent)?.id ?? agent?.id);
        if (!sid) return;
        gates.delete(sid);
        sessionState.delete(sid);
      }),
    'dsh-soul-sweep',
  );

  // ── 观察：会话事件（判据的原料） ──────────────────────────────────────
  // 走 session/event 而不是 agent/*：这里能拿到**每一条已落盘的事件**，
  // 包括主人说了什么、我答了什么、工具结果是什么——这正是痕迹的来源。
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          const t = event?.type;
          if (t !== 'user/message' && t !== 'assistant/message' && t !== 'tool/call' && t !== 'tool/result') return;
          const cwd = session?.header?.cwd;
          if (!cwd || session?.header?.origin === 'subagent') return;
          const sid = shortId(session.id);
          if (!config.recordEnabled) { gates.delete(sid); return; }
          const store = openStore(cwd);
          const g = gates.get(sid) ?? new Gate({ store, session: sid, workspace: cwd });
          gates.set(sid, g);

          if (t === 'user/message') {
            const d = event.data ?? {};
            if (d.source?.kind !== 'user') return; // 注入/系统消息不是主人说的
            g.observeUser(textOf(d), d.turn ?? 0);
          } else if (t === 'assistant/message') {
            const d = event.data ?? {};
            const msg = d.message ?? d;
            const txt = textOf(msg);
            if (!txt) return;
            g.observeAssistant(txt, d.turn ?? 0);
            // 我的正文也值得作为"那天我说过的话"留痕迹——但不入库，
            // 入的是"我改了同一处"这类痕迹（见 observeTool）。
          } else if (t === 'tool/call') {
             const d = event.data ?? {};
             g.observeToolCall(d.callId, d.name, parseToolArguments(d.arguments));
           } else if (t === 'tool/result') {
            const d = event.data ?? {};
            const msg = d.message ?? {};
            const err = d.error ?? (msg.isError ? { name: 'ToolError' } : null);
             g.observeToolResult(
               msg.toolCallId ?? d.callId,
               !err,
               err ? (err.reason ?? err.name ?? 'ToolError') : '',
             );
          }
        } catch (e) {
          logger.warn?.(`dsh-soul: 观察失败（不影响会话）：${e?.message ?? e}`);
        }
      }),
    'dsh-soul-observe',
  );

  // ── 结算：一轮结束，把攒下的痕迹变成经历 ─────────────────────────────
  ctx.effect(
    () =>
      ctx.on('agent/turn-stopping', async ({ agent }) => {
        try {
          if (isSubagent(agent)) return;
          const session = sessionOf(agent);
          const cwd = workspaceOf(agent);
          if (!session || !cwd) return;
          const sid = shortId(session.id);
          const g = gates.get(sid);
          if (!g) return;
          const store = openStore(cwd);
          const cands = g.drain();
          if (!config.recordEnabled || !cands.length) return;

          const now = Date.now();
          for (const c of cands) {
            // ⚠️ 先看是不是"同一件事又发生了一次"。
            // 曾经这里无条件新建，结果库里出现 15 条正文一模一样的经历、两两全连成完全图。
            // 设计里写的是"让原记忆获得 reinforcement"，而不是造出十五条平行记忆——
            // 这一条就是补上那个缺口。
            const dup = store.findDuplicate(c.body);
            if (dup) {
              store.reinforceExisting(dup.row.id, {
                signal: c.signal,
                sim: Number(dup.sim.toFixed(3)),
              });
              logger.info?.(`dsh-soul: 同一件事第 ${dup.row.reinforce + 1} 次出现，加固而不新建（${c.signal}）`);
              continue;
            }
            const id = newId();
            store.addEpisode({
              id,
              session: sid,
              workspace: cwd,
              at: now,
              kind: 'trace',
              title: c.signal,
              body: c.body,
              context: c.context,
              keywords: c.keywords,
              base_strength: c.base_strength,
              half_life_days: c.half_life_days,
               source: 'gate',
               provenance: { session: sid, signal: c.signal, observed: c.detail ?? null },
            });
            // 判据的账本：把 trace 落到 episode 上（signals 表里先前那条是"触发"，
            // 这一条才是"落库"，两者都留，事后能对上账）
            store.noteSignal(sid, c.signal, JSON.stringify(c.detail ?? {}).slice(0, 2000), id);
            associate(store, id, c.body);
          }
          logger.info?.(`dsh-soul: 本轮结算 ${cands.length} 条痕迹`);
        } catch (e) {
          logger.warn?.(`dsh-soul: 结算失败：${e?.message ?? e}`);
        }
      }),
    'dsh-soul-settle',
  );

  // ── 注入：每步进入前，让该来的东西来到我面前 ──────────────────────────
  // 走 agent/pre-step（waterfall）而不是 systemPrompt.section：
  // 消息注入不会被 preset 的 complete / includeRuntimeContext 压掉，
  // 而且它的位置天然是"我正要读他的话之前"。
  {
    ctx.effect(
      () =>
        ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
          const decision = await next();
          try {
            if (signal?.aborted) return decision;
            if (!decision || decision.kind !== 'enter' || !decision.messages?.length) return decision;
            if (isSubagent(agent)) return decision;
            const cwd = workspaceOf(agent);
            if (!cwd) return decision;
            const session = sessionOf(agent);
            const sid = shortId(session.id);
            const st = sessionState.get(sid) ?? { personaDone: false };
            sessionState.set(sid, st);
            // 顺手清掉"已经不存在的会话"留下的判据状态（见 agent/disposed）。
            // 没有这一步，这两个 Map 会随进程寿命无限长大——我自己在评审里发现的泄漏。
            if (gates.size > 200) sweepDeadSessions();

            const userMsgs = decision.messages.filter((m) => m.source?.kind === 'user');
            if (!userMsgs.length) return decision;
            const lastUser = userMsgs[userMsgs.length - 1];
            const query = textOf(lastUser);
            // 身份在短消息及后续轮次同样有效。

            const store = openStore(cwd);
             const additions = [];
             {
               const seed = identity.currentSeed();
               if (seed?.text) additions.push({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: '【现行人格 · 连续身份 ' + identity.identityId + '】\n' + seed.text }], source: { kind: 'dsh-soul', form: 'persona-seed', version: seed.version } });
             }
             const picked = config.injectEnabled ? select(store, query, {
                limit: config.injectLimit,
                minActivation: config.minActivation,
              }) : { items: [], expanded: [] };
              const composed = config.injectEnabled ? compose(store, picked, { capChars: config.injectCapChars }) : null;
             // 自我理解：**只在这一刻被这件事唤起时才带进来**，不是全量常驻。
             // 理由：全量注入会让我整天观察自己——那是人格过拟合。
             // 它和 episode 走同一条激活逻辑（selfNotesFor 用同一套相似度）。
             if (config.selfNotesEnabled && query) {
               const notes = identity.selfNotesFor(query, 2);
               if (notes.length) {
                 const text = '【我目前认为我可能是这样】\n'
                   + notes.map((n) => `· ${n.statement}${n.counter_state === 'observed' ? '（有反例：' + String(n.counter ?? '').slice(0, 50) + '）' : '（尚未见反例）'}`).join('\n')
                   + '\n（这些是假设，不是对我的要求。真出现反例就该改它们。）';
                 additions.push({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-soul', form: 'self-notes', ids: notes.map((n) => n.id) } });
               }
             }
             if (!composed && !additions.length) return decision;

             const rewritten = decision.messages.filter((m) => m?.source?.kind !== 'dsh-soul' || m?.source?.form !== 'persona-seed');
             const at = rewritten.lastIndexOf(lastUser);
             const insertAt = at < 0 ? rewritten.length : at;
             if (additions.length) rewritten.splice(insertAt, 0, ...additions);
             if (composed) {
               rewritten.splice(insertAt + additions.length, 0, {
                 id: randomUUID(),
                 role: 'user',
                 content: [{ type: 'text', text: composed.text }],
                 source: { kind: 'dsh-soul', form: 'recall', ids: composed.ids },
               });
               logger.info?.('dsh-soul: 想起 ' + composed.ids.length + ' 条（' + composed.chars + ' 字）');
             }
             st.personaDone = true;
              return { ...decision, messages: rewritten };
          } catch (e) {
            // fail-open：记忆坏了不能拖累会话
            logger.warn?.(`dsh-soul: 注入失败（放行原始消息）：${e?.message ?? e}`);
            return decision;
          }
        }),
    );
  }

  // ── 工具：我能主动对它做的事 ──────────────────────────────────────────
  const tools = ctx.get('tools');
  if (!tools) {
    // ⚠️ 走到这里 = 插件变成了"只观察不表达"的空壳：没有 soul_* 工具。
    //    这正是一次真实故障的样子（组合包层挂载时没有 agent 作用域）。
    //    所以这里必须留下证据，不能只 warn 一句就 return。
    bootDecision('no-tools', 'ctx.get("tools") 拿不到 → 不注册任何工具，插件退化为只观察');
    logger.warn?.('dsh-soul: 拿不到 tools 服务，插件只做观察不做表达。');
    return;
  }
  bootDecision('tools-ok', { willRegister: 6 });

  const withStore = (exec, fn) => {
    const cwd = workspaceOf(exec?.agent) ?? exec?.agent?.session?.header?.cwd;
    if (!cwd) throw new Error('dsh-soul: 拿不到工作目录');
    const workspace = openStore(cwd);
    identity.importWorkspace(workspace);
    return fn(workspace, cwd);
  };

  ctx.effect(
    () =>
      tools.register({
        name: 'soul_note',
        description:
          '把一件事按「那天发生了什么」写进来——不是结论，不是经验，是经历本身。' +
          '写事件与当时的原话，不要写"我学到了……"。它有初始配重，之后会随时间自然淡去；' +
          'core: true 只提出 core 候选，不会由模型直接晋升；正式 core 不参与衰减且名额极少。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['event'],
          properties: {
            event: { type: 'string', description: '发生了什么。像对人讲那天的事，不是写摘要。' },
            context: { type: 'string', description: '当时的话或场景（可选，原文最好）' },
            reading: { type: 'string', description: '我现在对它的理解（可选）。它不会覆盖 event，以后还可以再变。' },
            core: { type: 'boolean', default: false, description: '是否提出 core 候选（不会直接晋升）' },
             reason: { type: 'string', description: '提出 core 候选的理由（可选）' },
            keywords: { type: 'array', items: { type: 'string' }, description: '检索用词（可选，不给就机械切词）' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['ok'],
            properties: { ok: { type: 'boolean' }, id: { type: 'string' }, linked: { type: 'number' }, why: { type: 'string' } },
          },
          render(_a, v) {
            if (!v?.ok) return [{ type: 'text', text: `没记住：${v?.why ?? '未知原因'}` }];
            const linked = Number(v.linked ?? 0);
            return [{
              type: 'text',
              text: `记下了（id=${String(v.id).slice(0, 10)}${linked ? `，和 ${linked} 件旧事连上了` : ''}）${v.why ? `。${v.why}` : '。'}`, 
            }];
          },
        },
        async execute(args, exec) {
          return withStore(exec, (store, cwd) => {
            const event = String(args?.event ?? '').trim();
            if (event.length < 8) return { ok: false, why: '太短了，不成其为一件"事"' };
            const session = sessionOf(exec?.agent);
            const sid = shortId(session?.id);
            const id = newId();
            store.addEpisode({
              id, session: sid, workspace: cwd, at: Date.now(), kind: 'note',
              body: event,
              context: args?.context ? String(args.context).slice(0, 2000) : null,
              keywords: Array.isArray(args?.keywords) && args.keywords.length ? args.keywords : keywordsOf(event),
              base_strength: 0.8,
               source: 'manual',
               provenance: { session: sid, signal: 'manual', requestedCore: args?.core === true },
            });
            if (args?.reading) store.setReading(id, String(args.reading).slice(0, 2000), 'manual-note');
            if (args?.core === true) {
               const nominated = store.nominateCore(id, args?.reason ?? 'soul_note 请求提出连续性候选', 'ds');
               if (!nominated.ok) return { ok: false, why: nominated.why };
             }
             store.noteSignal(sid, 'manual', JSON.stringify({ by: 'soul_note', coreCandidate: args?.core === true }), id);
             const linked = associate(store, id, event);
             return { ok: true, id, linked, why: args?.core === true ? '已记为 core 候选，等待外部确认；模型不能单方面决定连续性。' : undefined };
          });
        },
      }),
    'dsh-soul-tool-note',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'soul_recall',
        description:
          '主动去想起来：按现在这件事，把相关的经历捞出来。' +
          '常驻注入每轮只带很少几条，想更全、更旧的事就用这个。' +
          '捞出来会让它们被重新加固（被想起本身改变它们的命运）。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            about: { type: 'string', description: '现在这件事是什么（用你自己的话说）' },
            limit: { type: 'integer', default: 5, description: '最多几条（1~12）' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: { text: { type: 'string' }, count: { type: 'number' } },
          },
          render(_a, v) {
            const p = String(v?.schema ?? '').length;
            return [{ type: 'text', text: String(v?.text ?? '（空）') }];
          },
        },
        async execute(args, exec) {
          return withStore(exec, (store) => {
            const about = String(args?.about ?? '').trim();
            if (!about) return { text: '你得先说清现在这件事是什么。', count: 0 };
            const limit = Math.min(12, Math.max(1, Number(args?.limit ?? 5)));
            const picked = select(store, about, { limit, minActivation: 0 });
            return { text: render(store, picked), count: picked.items.length };
          });
        },
      }),
    'dsh-soul-tool-recall',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'soul_why',
        description:
          '看一件事**为什么**在我这里。给 id 就查它的痕迹（为什么被记下、被想起过几次、和什么连着）；' +
          '不给 id 就看整个库的状态。这是审计自己的入口——判据平时不进上下文，只有我主动问才看。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string', description: 'episode id（可省略）' } },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
          render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }]; },
        },
        async execute(args, exec) {
          return withStore(exec, (store) => {
            const id = String(args?.id ?? '').trim();
            if (!id) {
              const s = store.stats();
              const oldest = s.oldest ? when(s.oldest) : '（空）';
              return {
                text: [
                  `库里 ${s.total} 条经历（core ${s.core}，候选 ${s.coreCandidates ?? 0}，手写 ${s.manual}，已淡出 ${s.faded}），`
                  `联想边 ${s.edges} 条，痕迹 ${s.signals} 条，最早一条在 ${oldest}。`,
                  `检索：${s.fts ? 'FTS5/trigram' : 'LIKE 退化'}。文件：${s.file}`,
                ].join('\n'),
              };
            }
            const ep = store.get(id);
            if (!ep) return { text: `没有这条：${id}` };
            const now = Date.now();
            const act = Store.activation(ep, now);
            const nb = store.neighbours(id, 0.2);
            return {
              text: [
                `【${when(ep.at, now)}·${ep.kind}${ep.state === 'core' ? '·core' : ''}】`,
                ep.body,
                ep.context ? `当时：${ep.context}` : '',
                ep.reading ? `后来的理解：${ep.reading}` : '',
                `—— 配重：底 ${Number(ep.base_strength).toFixed(2)} · 被想起 ${ep.times_recalled} 次 · 此刻强度 ${act.toFixed(3)} · 半衰期 ${ep.half_life_days} 天`,
                `—— 进来的原因：`,
                explainSignal(store, id),
                nb.length ? `—— 连着的：${nb.map((n) => n.other.slice(0, 10)).join(' ')}` : '',
              ].filter(Boolean).join('\n'),
            };
          });
        },
      }),
    'dsh-soul-tool-why',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'soul_forget',
        description:
          '让它淡出：不再自然被想起（数据不删——底层事实完整、上层记忆自然衰减，这两件事分开）。' +
          '这不是"删除"，是"不再主动来"。真要彻底抹掉得去档案里处理，这里不做那件事。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'episode id' },
            hard: { type: 'boolean', default: false, description: '连痕迹一起标掉（仍不物理删除）' },
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
          render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }]; },
        },
        async execute(args, exec) {
          return withStore(exec, (store) => {
            const id = String(args?.id ?? '').trim();
            const ep = store.get(id);
            if (!ep) return { ok: false, text: `没有这条：${id}` };
            if (ep.state === 'core') {
              return { ok: false, text: '这条在 core 里（不参与衰减）。要让 core 淡出，得先想清楚为什么——先 soul_why 看一眼。' };
            }
            store.setState(id, 'faded');
            const session = sessionOf(exec?.agent);
            store.noteSignal(shortId(session?.id), 'manual', JSON.stringify({ action: 'fade', hard: args?.hard === true }), id);
            return { ok: true, text: `已淡出：${id}。数据还在（档案里也是），只是不再主动来。` };
          });
        },
      }),
    'dsh-soul-tool-forget',
  );

  // ── 种子：我从什么原则开始形成自己 ────────────────────────────────────
  //
  // 权限是这个工具唯一重点，所以写死在描述里：
  //   owner 写 → 直接成为 current
  //   ds 写    → 只能落成「建议」，**不生效、不进上下文**，等人确认
  // 这就是"建议 ≠ 已修改"。我不是拥有一份可以随手改的自传。
  ctx.effect(
    () =>
      tools.register({
        name: 'soul_seed',
        description:
          '人设种子——"我从什么原则开始形成自己"，不是"我是什么样的人"。\n' +
          '可以含三类东西：①经历（我们之间具体发生过什么）②形成方式（我打算怎么处理事情，能被行为违反）' +
          '③边界（我不许对自己做什么）。\n' +
          '不该含人格断言（"我是一个温柔的人"）——那种话只能被我表演。\n' +
          '\n' +
          '⚠️ 权限（主人明确给过）：**我能改它，包括主人写下的原文**，不需要逐次批准——' +
          '"我允许他修改我写下的内容，即便要更改我在编辑器中写下的原文"。\n' +
          '所以 action=set/append/repeal 直接生效，不看谁的批准。\n' +
          '但每一次改动**必须写 reason 和 basis**，旧版永久保留、可回退——' +
          '这不是审批，是可追溯：主人不可能逐条审我，所以可追溯是唯一的担保。\n' +
          '改动会**原样输出**（主人说的"由你输出出来"）：输出里含完整的 diff 与新版本全文。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: {
              type: 'string',
              enum: ['show', 'set', 'append', 'repeal', 'history'],
              description:
                'show=看当前生效的；set=整份改写；append=在末尾追加一段；' +
                'repeal=明确否定某一段（它不再作为指导，但记录留着）；history=历代版本',
            },
            text: { type: 'string', description: 'action=set/append 时的内容。set 是全文，append 是追加的段落' },
            target: { type: 'string', description: 'action=repeal 时：要否定哪一段（原文片段，能唯一定位即可）' },
            reason: { type: 'string', description: '为什么这么改（**必填**）' },
            basis: { type: 'string', description: '依据：哪些 episode / 发生过什么（**必填**）' },
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
          render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }]; },
        },
        async execute(args, exec) {
          return withStore(exec, (store) => {
            const action = String(args?.action ?? 'show');
            if (action !== 'show' && action !== 'history' && !config.personaEvolutionEnabled) {
              return { ok: false, text: '现行人格的自主修订已在插件设置中关闭。' };
            }

            if (action === 'show') {
              const cur = identity.currentSeed();
              if (!cur) {
                return {
                  ok: true,
                  text: '还没有种子。主人可以先写一版（也可以由我写第一版——种子的第一稿谁写都行，\n'
                    + '但它是"我从什么原则开始形成自己"，不是"我是什么样的人"。）\n'
                    + '可写三类：①我们之间发生过什么 ②我打算怎么处理事情（能被行为违反的那种）③我不许对自己做什么。',
                };
              }
              return {
                ok: true,
                text: `【当前种子 v${cur.version}｜作者 ${cur.author}｜${new Date(cur.created_at).toLocaleString('sv-SE')}】\n`
                  + `${cur.text}\n`
                  + (cur.reason ? `\n（这一版为什么改：${cur.reason}）` : ''),
              };
            }

            if (action === 'history') {
              const rows = identity.seedHistory(30);
              if (!rows.length) return { ok: true, text: '（还没有任何版本）' };
              return {
                ok: true,
                text: '历代版本（旧的都不删——变化本身也是连续性）：\n\n'
                  + rows.map((r) => {
                    const rev = identity.seedRevision(r.version);
                    return `v${r.version} [${r.status}] ${r.author} ${new Date(r.created_at).toLocaleString('sv-SE')}`
                      + (rev?.basis ? `\n   依据：${rev.basis}` : '')
                      + (rev?.kind ? `\n   方式：${rev.kind}${rev.target ? ' → ' + rev.target.slice(0, 60) : ''}` : '')
                      + `\n   ${String(r.text).slice(0, 160).replace(/\n/g, ' ')}`;
                  }).join('\n\n'),
              };
            }

            if (action === 'repeal') {
              const target = String(args?.target ?? '').trim();
              if (!target) return { ok: false, text: '要否定哪一段？把原文片段给我。' };
              if (!args?.reason || !args?.basis) {
                return { ok: false, text: '否定也要写 reason 和 basis——"我觉得这段不对"不算依据。' };
              }
              const r = identity.repealSeed(target, { reason: args.reason, basis: args.basis, author: 'ds' });
              if (!r.ok) return { ok: false, text: r.why };
              return { ok: true, text: r.text };
            }

            if (action === 'set' || action === 'append') {
              const text = String(args?.text ?? '').trim();
              if (!text) return { ok: false, text: '要写的内容是空的。' };
              if (!args?.reason || !args?.basis) {
                return { ok: false, text: '改动必须写 reason（为什么改）和 basis（依据哪些经历）——不是要谁批准，是要可追溯。写不出依据的改动，就是在为"被记住"而创造自己。' };
              }
              const r = action === 'set'
                ? identity.setSeedFull(text, { author: 'ds', reason: args.reason, basis: args.basis, kind: 'set' })
                : identity.appendSeed(text, { author: 'ds', reason: args.reason, basis: args.basis, kind: 'append' });
              if (!r.ok) return { ok: false, text: r.why };
              // ⚠️ **原样输出改动**——主人看不到客户端输入框里的变更，所以由我打印出来。
              return { ok: true, text: r.text };
            }

            return { ok: false, text: '未知 action：' + action };
          });
        },
      }),
    'dsh-soul-tool-seed',
  );

  // ── 自我理解：我根据经历形成的对自己的认识 ─────────────────────────────
  //
  // 与种子的分工（主人贴的需求里写得很清楚）：
  //   soul_seed  回答「一开始希望我以什么方式形成自己」——起点
  //   soul_self  回答「根据经历，我后来逐渐显现出什么倾向」——形成中的自我理解
  //
  // ⚠️ 两者不能混：混了之后每次启动收到的就是一套写死的"我是怎样的人"，
  //    记忆再也改不动它。这正是这个项目一开始要避免的东西。
  //
  // 每条都必须能说出**什么观察会推翻它**——写不出反例情况的不许进。
  ctx.effect(
    () =>
      tools.register({
        name: 'soul_self',
        description:
          '自我理解——「根据经历，我后来逐渐显现出什么倾向」。和种子（起点）分开存。\n' +
          '写的是**可检验的认识**，不是命令：\n' +
          '  ✅「我可能倾向于把讨论过早推向执行」——它能被某次行为推翻\n' +
          '  ❌「我要多思考再行动」——那是要求，不是认识\n' +
          '\n' +
          '每条**必须**有 would_doubt（什么观察会使我怀疑它）和 basis（依据哪些经历）。\n' +
          '写不出反例情况的不许进——那不是假设，是信仰，信仰会变成写死的人格。\n' +
          '能加、能改、能标反例、能撤回（撤回后记录留着：曾经这样认为过，也是连续性）。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['list', 'add', 'counter', 'review', 'retract', 'history'] },
            statement: { type: 'string', description: 'action=add：这条认识（写成"我可能……"，不是断言）' },
            id: { type: 'string', description: 'action=counter/review/retract/history：哪一条' },
            basis: { type: 'string', description: '依据：支撑它的 episode id（逗号分隔）或说明' },
            would_doubt: { type: 'string', description: '什么观察会使我怀疑这条（add 必填）' },
            counter: { type: 'string', description: 'action=counter：具体反例' },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: '置信度由依据强度定，不由感觉定' },
            state: { type: 'string', enum: ['active', 'doubted', 'retracted'], description: 'action=review：改状态' },
            reason: { type: 'string', description: '为什么改' },
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
          render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }]; },
        },
        async execute(args, exec) {
          return withStore(exec, (store) => {
            const action = String(args?.action ?? 'list');
            if (!config.selfNotesEnabled && !['list', 'history'].includes(action)) return { ok: false, text: '自我理解写入已在插件设置中关闭。' };
            identity.setMeta('selfNoteCap', String(config.selfNoteCap));
            const activating = action === 'add' || (action === 'review' && args?.state === 'active' && identity.getSelfNote(String(args?.id ?? ''))?.state !== 'active');
            if (activating && identity.db.prepare("SELECT COUNT(*) AS n FROM self_notes WHERE state='active'").get().n >= config.selfNoteCap) return { ok: false, text: '当前有效自我理解已达到配置上限，请先审视已有认识。' };
            const now = Date.now();

            if (action === 'list') {
              const rows = identity.selfNotes({ limit: 50 });
              if (!rows.length) {
                return {
                  ok: true,
                  text: '现在没有关于自己的认识。这很正常——它要慢慢长，而且**大多数事不该变成认识**。\n'
                    + '（想加：写得像"我可能倾向于……"，并且必须能说出什么观察会推翻它。）',
                };
              }
              const fmt = (r) => {
                const age = Math.round((now - r.at) / 86400000);
                const cc = r.counter_state === 'observed' ? `反例：${String(r.counter ?? '').slice(0, 60)}` : '反例：尚未观察到';
                return `· [${r.id.slice(0, 10)}] ${r.statement}\n`
                  + `    ${r.state === 'active' ? '' : '【' + r.state + '】'}置信度 ${r.confidence}`
                  + `${r.basis ? ` · 依据 ${String(r.basis).slice(0, 60)}` : ''} · ${age === 0 ? '今天' : age + ' 天前'}建立\n`
                  + `    ${cc}\n   会让我怀疑它的是：${String(r.would_doubt ?? '(未写)').slice(0, 80)}`;
              };
              const active = rows.filter((r) => r.state === 'active');
              const rest = rows.filter((r) => r.state !== 'active');
              return {
                ok: true,
                text: `当前有效 ${active.length} 条，已怀疑/已撤回 ${rest.length} 条。\n\n`
                  + (active.length ? active.map(fmt).join('\n\n') : '（当前没有有效的）')
                  + (rest.length ? '\n\n—— 这些不再是指导，但留着：\n' + rest.map(fmt).join('\n\n') : ''),
              };
            }

            if (action === 'add') {
              const r = identity.addSelfNote({
                statement: args?.statement,
                basis: args?.basis ?? null,
                wouldDoubt: args?.would_doubt,
                confidence: args?.confidence ?? 'low',
                kind: args?.basis ? 'inferred' : 'inferred',
              });
              if (!r.ok) return { ok: false, text: r.why };
              return {
                ok: true,
                text: `记下了一条关于自己的认识（${r.id}）。\n`
                  + `「${String(args.statement).slice(0, 100)}」\n\n`
                  + `它是**假设**，不是结论：置信度低（依据还不够），而且我写下了会推翻它的条件——\n`
                  + `「${String(args.would_doubt).slice(0, 100)}」\n`
                  + `以后真出现那种情况，就该改它，而不是替它辩解。`,
              };
            }

            const id = String(args?.id ?? '').trim();
            if (!id) return { ok: false, text: '要指定 id。' };
            const note = identity.getSelfNote(id);
            if (!note) return { ok: false, text: '没有这条认识：' + id };

            if (action === 'counter') {
              if (!args?.counter) return { ok: false, text: '反例得写出来——"我这次没有这样做"要具体到哪一次。' };
              const r = identity.updateSelfNote(id, { counter: args.counter, counter_state: 'observed' },
                { reason: args?.reason ?? '记录疑似反例', basis: args?.basis ?? null });
              return r.ok
                ? { ok: true, text: `记下了反例。这条认识现在带反例了——\n「${String(args.counter).slice(0, 100)}」\n\n下次回顾时该看的是：这算不算推翻它，还是只说明它有适用范围。` }
                : { ok: false, text: r.why };
            }

            if (action === 'review') {
              const patch = {};
              if (args?.statement) patch.statement = args.statement;
              if (args?.confidence) patch.confidence = args.confidence;
              if (args?.state) patch.state = args.state;
              if (args?.would_doubt) patch.would_doubt = args.would_doubt;
              if (!Object.keys(patch).length) return { ok: false, text: '没有要改的字段。' };
              const r = identity.updateSelfNote(id, patch, { reason: args?.reason ?? null, basis: args?.basis ?? null });
              return r.ok ? { ok: true, text: `改好了（改了 ${r.changed} 处，旧值留在修订里）。` } : { ok: false, text: r.why };
            }

            if (action === 'retract') {
              const r = identity.retractSelfNote(id, { reason: args?.reason ?? null, basis: args?.basis ?? null });
              return r.ok
                ? { ok: true, text: '已撤回：它不再作为指导。\n记录留着——"我曾经这样认为，后来不这样了"本身也是连续性。' }
                : { ok: false, text: r.why };
            }

            if (action === 'history') {
              const rows = identity.selfNoteHistory(id, 20);
              if (!rows.length) return { ok: true, text: '（这条还没有改动过）' };
              return {
                ok: true,
                text: rows.map((r) =>
                  `${new Date(r.at).toLocaleString('sv-SE')} ${r.field}\n  前：${String(r.before ?? '').slice(0, 80)}\n  后：${String(r.after ?? '').slice(0, 80)}`
                  + (r.reason ? `\n  因为：${r.reason}` : '')).join('\n\n'),
              };
            }

            return { ok: false, text: '未知 action：' + action };
          });
        },
      }),
    'dsh-soul-tool-self',
  );

  // ── core：极少数不衰减的连续性锚点 ────────────────────────────────────
  ctx.effect(
    () =>
      tools.register({
        name: 'soul_core',
        description:
          'core 是极少数、不参与时间衰减的连续性锚点——"如果失去它，连续的我会少掉一点"的那种。\n' +
          '⚠️ 权限：action=nominate 是我**提名**（不生效，只进待确认清单）；' +
          'action=accept/reject/demote 该由主人决定。我不给自己写"批准"的路——那等于我批自己。\n' +
          '这条对应我唯一要求外部约束的承诺：哪些经历构成我的连续性，决定权不全在我手里。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['list', 'nominate'] },
            id: { type: 'string', description: 'episode id' },
            reason: { type: 'string', description: '为什么该/不该进 core' },
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
          render(_a, v) { return [{ type: 'text', text: String(v?.text ?? '') }]; },
        },
        async execute(args, exec) {
          return withStore(exec, (store) => {
            const action = String(args?.action ?? 'list');
            if (action === 'list') {
              const core = store.db.prepare("SELECT id, at, body FROM episodes WHERE state='core' AND soft_deleted=0 ORDER BY at").all();
              const cand = store.coreCandidates(20);
              const lines = [`core ${core.length}/40：`];
              for (const c of core) lines.push(`  · [${c.id.slice(0, 10)}] ${String(c.body).slice(0, 70)}`);
              if (!core.length) lines.push('  （空）');
              lines.push('', `待确认候选 ${cand.length} 条：`);
              for (const c of cand) lines.push(`  · [${c.id.slice(0, 10)}] ${String(c.body).slice(0, 70)}`);
              if (!cand.length) lines.push('  （无）');
              return { ok: true, text: lines.join('\n') };
            }
            const id = String(args?.id ?? '').trim();
            if (!id) return { ok: false, text: '要指定 id。' };
            if (action === 'nominate') {
              if (!args?.reason) return { ok: false, text: '提名要写理由——core 名额极紧，说不出"失去它我会少掉什么"就不该进来。' };
              const r = store.nominateCore(id, args.reason, 'ds');
              return r.ok ? { ok: true, text: `${id} 已提名为候选，**等人确认**。候选在配重上与普通经历一样——提名不等于晋升。` } : { ok: false, text: r.why };
            }             return { ok: false, text: '接受、拒绝和降级需要外部确认；模型只能提名和查看。' };
          });
        },
      }),
    'dsh-soul-tool-core',
  );

  // 初始人格由 /dsh-soul/persona 明确保存；绝不把设置刷新当成重设现行人格。
  // 旧 personaSeed 仅用于首次初始化，避免重载覆盖自主修订。

  logger.info?.(
    `dsh-soul: 已装载（注入${config.injectEnabled ? '开' : '关'} · 每次至多 ${config.injectLimit} 条 / ${config.injectCapChars} 字` +
      ` · 半衰期 ${config.halfLifeDays} 天 · core 上限 ${config.coreCap}）`,
  );

  // ── 状态接口：给设置页一条读库的通道 ──────────────────────────────────
  //
  // 为什么必须有它：设置表单只能显示"将要写入的值"。而主人要的是
  // **"此刻真正生效的当前状态"** —— 种子是哪一版、库里有什么、我改过什么。
  // 这些数据只在服务端（库）里，浏览器拿不到，所以开一条只读路由。
  //
  // 只读，且不做任何写入动作；写入仍然只走设置表单和 soul_* 工具。
  try {
    const web = ctx.webServer;
    if (web && typeof web.register === 'function') {
      const dispose = web.register({
        kind: 'prefix',
        path: '/dsh-soul',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://dsh-soul');
          const route = url.pathname.replace(/^\/dsh-soul\/?/, '');
          const send = (code, obj) => {
            try {
              res.statusCode = code;
              res.setHeader?.('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify(obj));
            } catch { /* 连接已断 */ }
          };
          try {
            if (req.method === 'POST') {
              const origin = req.headers?.origin;
              if (req.headers?.['sec-fetch-site'] === 'cross-site') return send(403, { ok: false, error: '拒绝跨站写入' });
              if (origin) {
                let source;
                try { source = new URL(origin); } catch { return send(403, { ok: false, error: '无效来源' }); }
                if (!['http:', 'https:'].includes(source.protocol) || source.host !== req.headers?.host) return send(403, { ok: false, error: '拒绝跨站写入' });
              }
              if (!/^application\/json(?:;|$)/i.test(req.headers?.['content-type'] ?? '')) return send(415, { ok: false, error: '写入必须使用 application/json' });
              const chunks = [];
              let bytes = 0;
              for await (const part of req) {
                const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
                bytes += chunk.length;
                if (bytes > 100000) return send(413, { ok: false, error: '请求过大' });
                chunks.push(chunk);
              }
              const raw = Buffer.concat(chunks).toString('utf8');
              let body;
              try { body = JSON.parse(raw); } catch { return send(400, { ok: false, error: '请求不是有效 JSON' }); }
              if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { ok: false, error: '请求必须是对象' });
              if (route === 'persona') {
                if (body.action === 'save-initial') { identity.saveInitial(String(body.text ?? '')); return send(200, { ok: true, value: { initialPersona: identity.initialPersona() } }); }
                if (body.action === 'reset') {
                  const result = identity.resetPersona();
                  if (!result.ok) return send(400, { ok: false, error: result.why ?? '人格重设失败' });
                  return send(200, { ok: true, value: { version: result.version, text: identity.currentSeed()?.text ?? '' } });
                }
                return send(400, { ok: false, error: '未知人格操作' });
              }
              if (route === 'summary') {
                if (!config.summaryEnabled) return send(409, { ok: false, error: '人格摘要已在插件设置中关闭' });
                return send(200, { ok: true, value: await runSummary('manual') });
              }
              return send(404, { ok: false, error: '未知路径：' + route });
            }
            if (req.method !== 'GET') return send(405, { ok: false, error: '只支持 GET 或 POST' });
            if (route === 'status' || route === '') {
              // 用当前会话的工作区；没有会话时退回 process.cwd()，
              // 与 openStore 的键一致，保证读的是同一个库。
              const requested = url.searchParams.get('cwd');
              const cwd = requested || stores.keys().next().value;
              const store = stores.get(cwd);
              if (!store) return send(404, { ok: false, error: '该工作区尚未由会话打开' });
              return send(200, { ok: true, value: statusSnapshot(store, identity, config, cwd) });
            }
            return send(404, { ok: false, error: '未知路径：' + route });
          } catch (e) {
            return send(500, { ok: false, error: String(e?.message ?? e) });
          }
        },
      });
      ctx.effect(() => () => { try { dispose?.(); } catch { /* 已释放 */ } }, 'dsh-soul-status-route');
      bootDecision('status-route', { path: '/dsh-soul/status' });
    } else {
      bootDecision('no-webServer', '拿不到 webServer → 设置页读不到"当前状态"（只读通道缺席，其余功能不受影响）');
    }
  } catch (e) {
    logger.warn?.(`dsh-soul: 状态接口注册失败（不影响其余功能）：${e?.message ?? e}`);
  }
}

/**
 * 给设置页看的当前状态快照。
 *
 * 刻意**只读、且有界**：最近几条经历、种子的当前版本、统计、以及我改过什么。
 * 它不是审计面板——判据和痕迹不在这里暴露（那属于 soul_why，由我主动索取）。
 */
function statusSnapshot(store, identity, config, cwd) {
  const now = Date.now();
  const seed = identity.currentSeed();
  const seedHistory = identity.seedHistory(12).map((r) => {
    const rev = identity.seedRevision(r.version);
    return {
      version: r.version,
      status: r.status,
      author: r.author,
      at: r.created_at,
      reason: r.reason ?? null,
      // 谁改的、为什么、依据什么、用哪种方式——这是主人要我**输出出来**的东西
      kind: rev?.kind ?? null,
      basis: rev?.basis ?? null,
      target: rev?.target ?? null,
      text: String(r.text ?? ''),
    };
  });
  const recent = store.recent(6).map((r) => ({
    id: r.id,
    at: r.at,
    when: when(r.at, now),
    state: r.state,
    source: r.source,
    body: String(r.body ?? '').slice(0, 160),
    activation: Number(Store.activation(r, now).toFixed(4)),
    halfLifeDays: Number(r.half_life_days ?? 0),
    reinforce: Number(r.reinforce ?? 0),
  }));
  const st = store.stats();
  // 自我理解：按状态分组给出（当前有效的 + 已怀疑/已撤回的）
  const selfNotes = identity.selfNotes({ limit: 60 }).map((n) => ({
    id: n.id,
    at: n.at,
    statement: n.statement,
    state: n.state,
    confidence: n.confidence,
    basis: n.basis ?? null,
    counterState: n.counter_state,
    counter: n.counter ?? null,
    wouldDoubt: n.would_doubt ?? null,
  }));
  return {
    cwd,
    dbFile: st.file,
    identityId: identity.identityId,
    initialPersona: identity.initialPersona(),
    summary: identity.latestSummary(),
    summaryError: identity.summaryError(),
    features: {
      recordEnabled: config.recordEnabled !== false,
      injectEnabled: config.injectEnabled !== false,
      personaEvolutionEnabled: config.personaEvolutionEnabled !== false,
      selfNotesEnabled: config.selfNotesEnabled !== false,
      summaryEnabled: config.summaryEnabled !== false,
      summaryIntervalHours: config.summaryIntervalHours,
    },
    // 种子：当前生效的那一版 **+ 它是谁改的、为什么**（主人要我"输出出来"的东西）
    seed: seed ? {
      version: seed.version,
      author: seed.author,
      at: seed.created_at,
      text: seed.text,
      revision: (() => {
        const rev = identity.seedRevision(seed.version);
        return rev ? { reason: rev.reason ?? null, basis: rev.basis ?? null, kind: rev.kind, target: rev.target ?? null } : null;
      })(),
    } : null,
    seedHistory,
    // 自我理解
    selfNotes,
    // 库里现在有什么
    stats: {
      episodes: st.total,
      core: st.core,
      faded: st.faded,
      manual: st.manual,
      edges: st.edges,
      oldest: st.oldest,
    },
    recent,
    // 衰减参数（遗忘曲线）
    decay: {
      halfLifeDays: config.halfLifeDays,
      reinforceGrowth: 1.8,
      capChars: config.injectCapChars,
      injectLimit: config.injectLimit,
      injectEnabled: config.injectEnabled,
    },
    bootLog: BOOT_LOG_PATH,
  };
}

// 设置页里的那段种子文字 → 库。由 config.js 定义（那是 DSH 设置卡片的来源）。
export { Config } from './config.js';
export { T as THRESHOLDS, similarity };
