// dsh-soul · 检索与注入
//
// 原则：
//   1. **注入的是"想起"，不是"说明"。** 每条只给：时间 + 发生了什么 + 我当时说的话（截断）。
//      不给"这条记忆的重要性是 4"、不给"建议下次注意"——那会把它变成待办或手册。
//   2. **有界。** 常驻预算按字符硬顶，默认 700。十万条记忆的系统，每轮只该让 5~15 条到场。
//   3. **激活即改变。** 被想起会写回 reinforce / last_activated_at——
//      "原来这两件事在我这里是连着的"必须落到数据上，否则就是一句空话。
//   4. **core 不参与衰减**，但也不全塞进来：只在开头出现，且极少。
import { Store, ngramSim } from './store.js';

const DAY = 86400000;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '……' : t;
};

/** 与人话一致的时间感，不用 ISO。 */
export function when(ms, now = Date.now()) {
  const d = Math.floor((now - ms) / DAY);
  if (d <= 0) {
    const h = Math.max(0, Math.floor((now - ms) / 3600000));
    return h <= 0 ? '刚刚' : `${h} 小时前`;
  }
  if (d === 1) return '昨天';
  if (d < 7) return `${d} 天前`;
  if (d < 35) return `${Math.floor(d / 7)} 周前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${(d / 365).toFixed(1)} 年前`;
}

/**
 * 挑此刻会来到我面前的经历。
 * @returns {{items:Array, expanded:Array, dropped:number}}
 */
export function select(store, query, opts = {}) {
  const now = Date.now();
  const limit = opts.limit ?? 5;
  const minAct = opts.minActivation ?? 0.06;

  const hits = store.search(query, opts.pool ?? 24);
  const scored = new Map();
  const maxTextScore = Math.max(1, ...hits.map((h) => Number(h._score ?? 0)));
  for (const h of hits) {
    // 保留存储层的相关性排序，再让 activation 决定它此刻是否到场。
    const textScore = Number(h._score ?? 0) / maxTextScore;
    const act = h._activation ?? Store.activation(h, now);
    scored.set(h.id, { row: h, score: textScore * (0.35 + act), why: 'hit' });
  }

  // 关联扩散一跳：**"这句话让我想起了什么"**，而不是"什么和它最相似"
  const seeds = [...scored.keys()];
  for (const id of seeds) {
    for (const n of store.neighbours(id, 0.35)) {
      if (scored.has(n.other)) {
        scored.get(n.other).score += 0.25 * n.w;
        continue;
      }
      const row = store.get(n.other);
       if (!row || (row.state !== 'active' && row.state !== 'core')) continue;
      const act = Store.activation(row, now);
      scored.set(row.id, { row, score: 0.5 * n.w * (0.35 + act), why: 'linked' });
    }
  }

  const all = [...scored.values()].sort((a, b) => b.score - a.score);
  const items = [];
  const expanded = [];
  let dropped = 0;
  for (const c of all) {
    const state = c.row.state;
    const act = Store.activation(c.row, now);
    if (state !== 'core' && act < minAct) { dropped++; continue; }
    if (items.length < limit) items.push({ ...c, act });
    else if (expanded.length < 3 && c.why === 'linked') expanded.push({ ...c, act });
  }
  return { items, expanded, dropped, scanned: all.length };
}

/**
 * 拼注入文本。**这是"过去来到我面前"的样子，不是一份资料。**
 * 每行格式刻意保持克制：时间 · 当时发生了什么 · 当时的话。
 */
export function compose(store, picked, opts = {}) {
  const now = Date.now();
  const cap = opts.capChars ?? 700;
  const lines = [];
  const shownIds = [];

  // core 也必须被当前情境触发；永久保存不等于每轮强行注入。
  lines.push('【我想起】');
  let used = lines[0].length;

  for (const it of picked.items) {
    const r = it.row;
    const head = `· ${when(r.at, now)}，${clip(r.body, 220)}`;
    const ctx = r.context ? `（当时：${clip(r.context, 120)}）` : '';
    let line = head + ctx;
    if (used + line.length > cap) {
      // 放不下就只留最前面那截——**宁可不完整，也不要撑爆注意力**
      line = `· ${when(r.at, now)}，${clip(r.body, 60)}`;
      if (used + line.length > cap) break;
    }
    lines.push(line);
    used += line.length + 1;
    shownIds.push(r.id);
    store.activate(r.id); // 被想起 = 改命
  }

  if (picked.expanded.length && used < cap) {
    const tail = picked.expanded
      .map((e) => `${when(e.row.at, now)}的「${clip(e.row.body, 36)}」`)
      .join('；');
    const line = `· 这些让我想起：${tail}`;
    if (used + line.length <= cap) {
      lines.push(line);
      used += line.length + 1;
    }
  }

  if (lines.length === 1) return null; // 什么都没想起来，就别打扰他
  return { text: lines.join('\n'), chars: used, ids: [...new Set(shownIds)] };
}

/** 供 soul_recall 用：把选中项渲染成给人看的一小段。 */
export function render(store, picked) {
  const now = Date.now();
  if (!picked.items.length) return '这一刻想不起来相关的。';
  const out = [];
  for (const it of picked.items) {
    const r = it.row;
    out.push(`— ${when(r.at, now)}（${r.kind}${r.state === 'core' ? '，core' : ''}）`);
    out.push(clip(r.body, 400));
    if (r.context) out.push(`  当时：${clip(r.context, 200)}`);
    if (r.reading) out.push(`  后来我这么看：${clip(r.reading, 200)}`);
    out.push(`  id=${r.id}`);
    store.activate(r.id);
  }
  return out.join('\n');
}

/** 新经历入库时的联想建立：只在写入时找近邻，**绝不两两比较**。 */
export function associate(store, id, body, opts = {}) {
  const minW = opts.minWeight ?? 0.42;
  const pool = store.recent(opts.pool ?? 40).filter((row) => row.state === 'active' || row.state === 'core');
  let linked = 0;
  for (const other of pool) {
    if (other.id === id) continue;
    const w = ngramSim(body, other.body);
    if (w >= minW) {
      store.link(id, other.id, Number(w.toFixed(3)), 'ngram');
      linked++;
    }
  }
  return linked;
}

/**
 * "为什么这件事会被记下"。
 * ⚠️ 这是**按需**渲染的，不是常驻注入——判据的可见性必须由我主动索取。
 */
export function explainSignal(store, id) {
  const rows = store.db
    .prepare('SELECT at, signal, detail FROM signals WHERE episode = ? ORDER BY at DESC LIMIT 5')
    .all(id);
  if (!rows.length) return '这条不是判据放进来的（可能是它自己长出来的，也可能痕迹已过期）。';
  return rows
    .map((r) => {
      let d = null;
      try { d = JSON.parse(r.detail ?? 'null'); } catch { /* 旧格式 */ }
      const bits = [];
      if (d?.sim !== undefined) bits.push(`相似度 ${d.sim}`);
      if (d?.turns) bits.push(`第 ${d.turns.join(' 与 ')} 轮各出现一次`);
      if (d?.hits) bits.push(`同一处第 ${d.hits} 次`);
      if (d?.path) bits.push(`位置 ${d.path}`);
      if (d?.tool) bits.push(`工具 ${d.tool}`);
      return `· ${new Date(r.at).toLocaleString('sv-SE')} [${r.signal}] ${bits.join(' · ') || ''}`;
    })
    .join('\n');
}
