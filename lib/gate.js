// dsh-soul · 入口判据
//
// 判据只有一条：**这件事有没有让我停过一下。**
//
// 问题在于：我对我自己的评价不可靠——我会选安全、好听、不会错的说法。
// 所以落点不在"我觉得这件事重要"，而在**我控制不了的痕迹**上：
//
//   1. repeat     同一个诉求，隔了几轮又出现（次数是计数，不是评价）
//   2. rewrite    我改写了同一件东西（同一路径被重复写；被驳回的改写请求）——有前后两版可 diff
//   3. corrected  主人直接反驳了我的话，而我的口径变了——两句话都在，能对质
//   4. toolfail   工具先失败、之后同一操作成功——坑的形状
//   5. manual     我主动记 / 主人明确说"记住"
//
// ⚠️ 这个判据有一个我自己承认的漏洞：我是被观察者也是观察者。
// **知道判据，我就会为判据优化**（故意重复一件事、被反驳时表演改口）。
// 所以本文件的内容、阈值、以及 signals 表，**都不进我的每轮上下文**。
// 机制待在代码里。这条比我自己的诚实更可靠。
//
// 另一个后果：这个判据**会漏**。漏掉的东西不会留下痕迹——按设计，它就该走。
// 衰减不是故障；漏判也不是。真正免疫遗忘的极少，而"全部留住"等于没有记忆。

export const SIGNALS = ['repeat', 'rewrite', 'corrected', 'toolfail', 'manual'];

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）《》【】,.!?;:()[\]{}<>"'`~@#$%^&*+=|\\/-]+/g, '');

const bigrams = (s) => {
  const t = norm(s);
  const set = new Set();
  for (let i = 0; i + 2 <= t.length; i++) set.add(t.slice(i, i + 2));
  return set;
};

/** 两段话有多像（0~1）。用 bigram Jaccard：零依赖、可解释。 */
export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 「这是不是同一个诉求」的重叠度 —— **重复判据用它，不用 similarity**。
 *
 * 为什么必须这么改（数据逼出来的）：字符 bigram 对**改写**极其敏感。
 *   同一句只差标点        → similarity 1.000
 *   换个说法说同一件事     → similarity 0.452   ← 而"同一个诉求又提了一次"通常是换了说法
 *   同一句后面加了补充     → similarity 0.563
 * 按 0.72 的阈值，repeat 这条判据**只在逐字重复时生效**，也就是最不需要它的时候。
 * 换个说法说同一件事，本来就不是"越像越好"的问题，而是**有没有在说同一件事**。
 *
 * 所以混合两路：
 *   字符 bigram 重叠（60%）—— 抓逐字重复，也容忍标点与语序
 *   实词集合重叠（40%）  —— 抓改写：CJK 切 2~4 字片段 + 拉丁词
 * 这是重叠度，不是语义相似度；它不完美，但它可解释、零依赖，而且**真的能抓改写**。
 */
export function overlapScore(a, b) {
  const bc = similarity(a, b);
  // 实词化：CJK 连续串切 2 字片段（CJK 的最小可辨单位就是双字词），拉丁词/路径整体取
  const tokens = (s) => {
    const t = norm(s);
    const set = new Set();
    for (const m of t.matchAll(/[a-z_][a-z0-9_.:/-]{2,}/g)) set.add(m[0]);
    for (const m of t.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
      const w = m[0];
      for (let i = 0; i + 2 <= w.length; i++) set.add(w.slice(i, i + 2));
    }
    return set;
  };
  const A = tokens(a);
  const B = tokens(b);
  let cont = 0;
  if (A.size && B.size) {
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    cont = inter / Math.min(A.size, B.size); // 用 min 做分母：改写常会补内容，不该因此掉分
  }
  return 0.6 * bc + 0.4 * cont;
}

// 阈值都在这里，集中一处，便于以后回测调整（但别把它们写进给人看的提示词里）
export const T = {
  // ⚠️ 这个阈值配的是 overlapScore（实词重叠 + bigram），不是纯 bigram。
  //    用纯 similarity 时必须 ≥0.72，而那样"换个说法说同一件事"（约 0.45）永远抓不到。
  //    这个是拿真实样本标定的，见 _tools/test-repeat.mjs。
  repeatSim: 0.40,       // 同一个诉求"又提了一次"
  repeatGapTurns: 1,     // 至少要隔一个 turn，同轮反复不算
  minTurnsForRepeat: 3,  // 会话太短不判重复（前几轮本来就在铺陈）
  rewriteHits: 2,        // 同一路径被写/改到第 2 次就算"改写过"
  correctedShiftMin: 0.35, // 口径要变多少才算"我后来改了口径"（1 - overlapScore）
  minTopicLen: 12,       // 太短的话不构成"一件事"
};

// 明确的否定判断。**不用单字 `不` / `别`**——"先别做"里全是那种词，
// 那会把"让我暂停"误读成"我错了"。只认指向"我前面说法"的否定。
const REBUTTAL = /不对|错的|错了|你搞错|不是这(样|个意思)|我说的不是|纠正一下|你理解错|这点不对|说反了|你记错/;

/**
 * 判据的状态机。**纯内存、纯规则、无 IO、不调模型。**
 * 每个会话一个实例，会话结束就丢——判据不需要被记住，只需要当场看得见。
 */
export class Gate {
  constructor({ store, session, workspace, log = () => {} }) {
    this.store = store;
    this.session = session;
    this.workspace = workspace;
    this.log = log;
    this.userTurns = [];      // { text, turn }
    this.assistantTexts = []; // { text, turn }
    this.seenUser = new Set();// 去重用：同一条消息只认一次
    this.seenAssistant = new Set();
    this.writes = new Map();  // path -> [{turn, action}]
    this.toolFail = new Map();// 精确操作签名 -> 最近失败
    this.recoveredTargets = new Set(); // 同一会话、工具和目标只形成一次恢复经历
    this.toolCalls = new Map(); // callId -> { name, args }
    this.rejectedEdits = 0;
    this.pending = [];        // 本次会话里攒下的候选（turn-stopping 时结算）
    this.pendingRebuttal = null; // 待确认的驳回（要等我的口径真的变了）
  }

  // ── 观察点 ───────────────────────────────────────────────────────────

  /** 主人说了话。 */
  observeUser(text, turn) {
    const t = String(text ?? '').trim();
    turn = Number.isFinite(turn) && turn > 0 ? turn : this.userTurns.length + 1;
    if (!t) return;
    // 系统/运行时注入不是主人说的 —— 判据只看真正来自主人的话
    if (/^<system-reminder>|^Current runtime context/.test(t)) return;
    // ⚠️ 同一条消息只认一次。agent 的每一步都会重放整份消息列表，
    //    不去重的话同一条话会被记成"说了好几遍"——repeat 判据会被自己喂出假信号。
    //    （记号放在过滤之后，免得注入消息也占一个坑。）
    const key = turn + '|' + norm(t).slice(0, 200);
    if (this.seenUser.has(key)) return;
    this.seenUser.add(key);
    this.userTurns.push({ text: t, turn });

    // ── 信号 1：repeat —— 同一个诉求又提了一次
    if (this.userTurns.length >= T.minTurnsForRepeat && t.length >= T.minTopicLen) {
      for (let i = this.userTurns.length - 2; i >= 0; i--) {
        const prev = this.userTurns[i];
        if (turn - prev.turn < T.repeatGapTurns) continue;
        const sim = overlapScore(t, prev.text);
        if (sim >= T.repeatSim) {
          this.emit('repeat', {
            sim: Number(sim.toFixed(3)),
            body: t,
            context: prev.text,
            turns: [prev.turn, turn],
            keywords: keywordsOf(t),
          });
          break;
        }
      }
    }

    // ── 信号 3：corrected —— 他直接把我按住/反驳，**而且我随后改了口径**
    //
    // ⚠️ 这条判据改过一次，原因是有证据的：会话里主人说
    //    「……先别做 告诉我你打算怎么写」被记成了 corrected（sim=0.01，两条）。
    //    错在两点：
    //    (1) 锚点里有 "别" "不" 这种单字——"先别做"里全是锚点词；
    //    (2) 更根本的是**结构错**：设计里写的是
    //        「被直接反驳后我的口径变了——两句话都在，能对质」，
    //        关键在"两句话都在"。它需要成对证据，而我写的是单条触发。
    //    现在：锚点收窄到**明确的否定判断**，而且只记"待确认"——
    //    要等我说了下一句、口径真的变了，才落地成 corrected。
    //    代价是漏检变多。按定稿："漏掉的东西不留痕迹，按设计它就该走"——**漏比错好**。
    if (REBUTTAL.test(t) && this.assistantTexts.length && t.length <= 400) {
      const last = this.assistantTexts[this.assistantTexts.length - 1];
      this.pendingRebuttal = {
        turn,
        text: t,
        prev: last.text,
        sim: Number(overlapScore(t, last.text).toFixed(3)),
      };
    }
  }

  /** 我说了话。 */
  observeAssistant(text, turn) {
    const t = String(text ?? '').trim();
    turn = Number.isFinite(turn) && turn > 0 ? turn : this.assistantTexts.length + 1;
    if (!t) return;
    // 同 observeUser：每一步都会重放，去重免得"我上一句"被自己顶掉。
    const key = turn + '|' + norm(t).slice(0, 200);
    if (this.seenAssistant.has(key)) return;
    this.seenAssistant.add(key);
    // 只留最近 40 句（判据只需要"上一句"和少量上下文，留太多是浪费）
    this.assistantTexts.push({ text: t, turn });
    if (this.assistantTexts.length > 40) this.assistantTexts.shift();

    // ── 在这里确认"待定的驳回"：我刚说完话，正好能看出我的口径变没变。
    //    放在 observeUser 里是错的——那时我的下一句还没发出来，
    //    比较的永远是同一条，shift 恒为 0（第一版就是这么废掉的）。
    if (this.pendingRebuttal) {
      const pr = this.pendingRebuttal;
      const shift = 1 - overlapScore(pr.prev, t); // 口径变了多少
      const confirmed = shift >= T.correctedShiftMin;
      this.store.noteSignal(
        this.session,
        'corrected',
        JSON.stringify({
          stage: confirmed ? 'confirmed' : 'dropped',
          sim: pr.sim,
          shift: Number(shift.toFixed(3)),
          rebuttalTurn: pr.turn,
          myTurn: turn,
        }).slice(0, 1200),
        null,
      );
      if (confirmed) {
        this.emit('corrected', {
          sim: pr.sim,
          shift: Number(shift.toFixed(3)),
          body: pr.text,
          context: pr.prev,
          turns: [pr.turn, turn],
          keywords: keywordsOf(pr.text),
        });
      }
      this.pendingRebuttal = null;
    }
  }

  /** 工具调用（用于 rewrite / toolfail）。 */
  observeToolCall(callId, name, args) {
    if (!callId) return;
    this.toolCalls.set(String(callId), { name: String(name ?? 'tool'), args: args ?? {} });
  }

  observeToolResult(callId, ok, errorText) {
    const call = callId ? this.toolCalls.get(String(callId)) : null;
    if (callId) this.toolCalls.delete(String(callId));
    this.observeTool(call?.name ?? 'tool', call?.args ?? {}, ok, errorText);
  }

  observeTool(name, args, ok, errorText) {
    const a = args ?? {};
    const path = a.file_path || a.path || a.notebook_path || '';

    if (ok && /write|edit|replace|patch/i.test(name) && path) {
      const n = (this.writes.get(path)?.length ?? 0) + 1;
      const list = this.writes.get(path) ?? [];
      list.push({ turn: this.userTurns.length, action: name });
      this.writes.set(path, list);
      if (n === T.rewriteHits) {
        this.emit('rewrite', {
          path,
          hits: n,
          body: `同一处被我改了 ${n} 次：${path}`,
          keywords: keywordsOf(path),
        });
      }
    }
    // 编辑被拒（old_string 找不到等）——这是"我以为的"和"实际的"不一致
    if (!ok && /write|edit|replace/i.test(name)) {
      this.rejectedEdits++;
      if (this.rejectedEdits === T.rewriteHits) {
        this.emit('rewrite', {
          path: path || '(未知)',
          hits: this.rejectedEdits,
          rejected: true,
          body: `我的改写被驳回了 ${this.rejectedEdits} 次：${path || '(未知)'}`,
          keywords: keywordsOf(String(errorText ?? '').slice(0, 120)),
        });
      }
    }

    // ── 信号 4：toolfail —— 先失败，之后同一操作成功
    //
    // ⚠️ 这里改过一次，原因是**数据**：库里出现过 15 条正文一模一样的
    //    「tool 先失败了，后来同一处成了。」——既没有"什么失败"，也没有"什么成了"，
    //    而且签名只用「工具名 + 路径」，不同命令撞在一起就互相算作"恢复了"。
    //    设计第一条是"记那天，不记道理"，那句话连"那天"都没有。
    // 现在：签名收窄到**完整参数**，正文给出具体动作与原话。
    // 不用 norm：它会抹掉路径分隔符、标点，令不同参数碰撞。
    const sig = JSON.stringify([name, Object.entries(a).sort(([x], [y]) => x.localeCompare(y))]);
    if (!ok) {
      this.toolFail.set(sig, { at: Date.now(), name, args: a, err: clip1(String(errorText ?? ''), 300) });
    } else if (this.toolFail.has(sig)) {
      const f = this.toolFail.get(sig);
      this.toolFail.delete(sig);
      const target = describeTarget(name, a);
      const recoveryKey = JSON.stringify([name, path || sig]);
      if (this.recoveredTargets.has(recoveryKey)) return;
      this.recoveredTargets.add(recoveryKey);
      this.emit('toolfail', {
        tool: name,
        body: `${name} 在 ${target} 上先失败了，后来同一处成了。`,
        context: `失败原话：${f.err.replace(/\s+/g, ' ').slice(0, 240)}`,
        keywords: keywordsOf(`${name} ${target} ${f.err ?? ''}`),
      });
    }
  }

  /** 我主动要记住的东西。 */
  manual(body, keywords = []) {
    return this.#candidate({
      signal: 'manual',
      body: String(body ?? '').trim(),
      keywords: keywords.length ? keywords : keywordsOf(body),
      context: null,
      base_strength: 0.8,
    });
  }

  // ── 结算 ─────────────────────────────────────────────────────────────

  emit(signal, payload) {
    this.store.noteSignal(this.session, signal, JSON.stringify(payload).slice(0, 2000), null);
    const c = this.#candidate({ signal, ...payload });
    if (c) this.pending.push(c);
    return c;
  }

  #candidate(p) {
    const body = String(p.body ?? '').trim();
    if (body.length < 8) return null; // 太短的不构成"一件事"
    return {
      signal: p.signal,
      body,
      context: p.context ? String(p.context).slice(0, 1200) : null,
      keywords: p.keywords ?? [],
      base_strength: p.base_strength ?? strengthFor(p.signal),
      half_life_days: p.signal === 'toolfail' ? 7 : 30,
      detail: p,
    };
  }

  /** 取走攒下的候选（结算时调用）。 */
  drain() {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/** 痕迹决定初始配重。**不是"这件事多重要"，只是"留下它的痕迹有多硬"。** */
function strengthFor(signal) {
  switch (signal) {
    case 'manual': return 0.8;
    case 'corrected': return 0.7;  // 被他按住过，通常比我自己说的准
    case 'repeat': return 0.6;
    case 'rewrite': return 0.55;
    case 'toolfail': return 0.2; // 技术恢复痕迹默认短暂，避免占据连续性记忆
    default: return 0.4;
  }
}

/** 截断，用于把工具原话收进痕迹里。 */
function clip1(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 一句话说清"在哪件事上"——工具不同，能说清的粒度不同。 */
function describeTarget(name, a) {
  const path = a.file_path || a.path || a.notebook_path;
  if (path) return String(path);
  if (typeof a.command === 'string' && a.command.trim()) return '命令「' + clip1(a.command, 80) + '」';
  if (typeof a.pattern === 'string' && a.pattern.trim()) return '检索「' + clip1(a.pattern, 60) + '」';
  const keys = Object.keys(a ?? {});
  return keys.length ? '参数 ' + keys.slice(0, 4).join('/') : '（无参数）';
}

/**
 * 关键词：**不提取"语义中心"，只切实体词**。
 * 因为一旦我参与"这条该打什么标签"，判据就被我污染了。
 * 粗糙、机械、可复现——这正是它该有的样子。
 */
export function keywordsOf(text, max = 14) {
  const s = String(text ?? '');
  const out = new Set();
  // 拉丁词 / 路径 / 标识符
  for (const m of s.matchAll(/[A-Za-z_][A-Za-z0-9_.:/-]{2,}/g)) {
    if (out.size >= max) break;
    out.add(m[0].slice(0, 48));
  }
  // CJK：连续汉字串里切 2~4 字片段（取开头、结尾与最长片段，够检索用）
  for (const m of s.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const w = m[0];
    if (out.size >= max) break;
    out.add(w.slice(0, 4));
    if (w.length > 6) out.add(w.slice(-4));
  }
  return [...out].slice(0, max);
}
