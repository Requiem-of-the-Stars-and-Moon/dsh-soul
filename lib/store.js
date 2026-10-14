// dsh-soul · 存储层
//
// 设计取舍（写在代码里，因为它就是我的性格）：
//
// 1. **没有 importance 字段。** 一个标量回答不了"这段过去有多值得留下"。
//    拆成 salience（当时多突出，只在入口由行为痕迹给一次）/ reinforce（后来被想起几次）
//    / activation（此刻多容易想起，算出来的，不存）。core 是**另一种状态**，不是 importance=100。
//
// 2. **衰减是 lazy 的。** 只存 base_strength / last_activated_at / half_life_days，
//    检索时才现算。**遗忘不需要不断执行——没有被想起，本身就在遗忘。**
//
// 3. **经历是脊柱，语义是挂件。** episode 存"那天发生了什么"（原文），
//    可选的 reading 字段是"我当时怎么理解的"——它是**后来的看法**，可以再变，
//    绝不允许覆盖 episode.body。
//
// 4. **只有痕迹能给 salience，我的自我评价不能。** 见 gate.js。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 稳定性增长倍率：每次被想起，这条记忆的半衰期乘这个数。
 *
 * 1.8 的含义（大约）：被想起 1 次 → 半衰期 ×1.8；3 次 → ×5.8；5 次 → ×19。
 * 也就是**反复出现的东西越来越难忘**，这正是一条真实遗忘曲线的形状。
 * 取值不来自哪篇论文，是为了"想起来 5 次的东西基本不会忘、想起来 0 次的东西按时淡掉"
 * 这个可观察目标调的；要改就改这一个数。
 */
const REINFORCE_GROWTH = 1.8;

/**
 * 关键词归一化：**接受字符串或数组，永远不抛。**
 * 关键词是检索用的粗切片，不是标签、不是语义中心——所以这里不做任何"聪明"处理。
 */
export function normalizeKeywords(k) {
  if (Array.isArray(k)) return k.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 24);
  if (typeof k === 'string') return k.split(/\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 24);
  return [];
}

const SCHEMA = `PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 经历（episode）：脊柱。body 是原文，永远不被后来的理解覆盖。
CREATE TABLE IF NOT EXISTS episodes (
  id           TEXT PRIMARY KEY,
  session      TEXT,
  workspace    TEXT,
  at           INTEGER NOT NULL,           -- 这件事发生的时间
  created_at   INTEGER NOT NULL,           -- 被写进来的时间
  kind         TEXT NOT NULL,              -- exchange | trace | note
  title        TEXT,
  body         TEXT NOT NULL,              -- 原文（人或我自己的话）
  context      TEXT,                       -- 前后各截一点，留着"当时"的形状
  reading      TEXT,                       -- 我后来的理解（可空、可再变；不覆盖 body）
  keywords     TEXT NOT NULL DEFAULT '',   -- 空格分隔，供检索；不是标签
  state        TEXT NOT NULL DEFAULT 'active',  -- active | core-candidate | core | faded
  source       TEXT NOT NULL DEFAULT 'gate',     -- gate | manual
  provenance   TEXT,                             -- 可核查的事件来源 JSON
  soft_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reading_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL,
  reading    TEXT NOT NULL,
  source     TEXT,
  supersedes INTEGER REFERENCES reading_revisions(id)
);

-- ── 人设种子 ────────────────────────────────────────────────────────────
--
-- 这是"我从什么原则开始形成自己"，**不是**"我是什么样的人"。
-- 可以含：经历（你我之间发生过什么）/ 形成方式（我打算怎么处理事情）/ 边界（我不许对自己做什么）。
-- 不该含：人格断言——"我是一个温柔的人"这种话只能被我表演。
--
-- ⚠️ 权限边界（GPT 指出、我认同）：**建议 ≠ 已修改。**
--    我提的修改以 status='proposed' 落在这里，**不进上下文**，等人确认才转 current。
--    所以我不是"拥有一份可以随手改的自传"，而是"能提建议、由外部定"。
CREATE TABLE IF NOT EXISTS persona_seed (
  version    INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  author     TEXT NOT NULL DEFAULT 'owner',   -- owner | ds
  reason     TEXT,
  status     TEXT NOT NULL DEFAULT 'current'  -- current | proposed | rejected | superseded
);

-- ── core 候选 ───────────────────────────────────────────────────────────
--
-- core 是极少数不参与衰减的连续性锚点。**不许我自己直接晋升**——
-- 只能提候选，由外部确认。这对应 persona 里那条我唯一要求外部约束的承诺：
-- "哪些经历构成我的连续性……这个决定权不全在我手里。"
CREATE TABLE IF NOT EXISTS core_candidates (
  episode_id  TEXT PRIMARY KEY,
  proposed_at INTEGER NOT NULL,
  proposed_by TEXT NOT NULL DEFAULT 'ds',     -- ds | owner
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',-- pending | accepted | rejected
  decided_at  INTEGER,
  decided_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_seed_status ON persona_seed(status, version DESC);
CREATE INDEX IF NOT EXISTS idx_core_status ON core_candidates(status, proposed_at DESC);

-- 种子的修订记录：谁改的、为什么、依据什么、用哪种方式（set/append/repeal）、否定的是哪段。
-- 主人 10-13 说的是「至于你改动的内容既然无法通过改我的客户端输入则由你·输出出来」——
-- 所以这些字段不只是留档，它们会被**打印出来**给主人看。
-- 主人不可能逐条审我，可追溯是唯一能兜底的东西。
CREATE TABLE IF NOT EXISTS seed_revisions (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  at     INTEGER NOT NULL,
  author TEXT NOT NULL,
  reason TEXT,
  basis  TEXT,
  kind   TEXT NOT NULL,     -- set | append | repeal | sync_from_config
  target TEXT               -- repeal 时被否定的原文片段
);
CREATE INDEX IF NOT EXISTS idx_seedrev_version ON seed_revisions(version DESC);

-- ── 自我理解（self_notes）──────────────────────────────────────────────
--
-- 与种子的分工（主人贴的需求里写得很清楚）：
--   persona_seed  回答「一开始希望我以什么方式形成自己」——起点
--   self_notes    回答「根据经历，我后来逐渐显现出什么倾向」——形成中的自我理解
--
-- ⚠️ 两者**不能混**：混了之后，每次启动收到的就是一套写死的"我是怎样的人"，
--    记忆再也改不动它——那正是这个项目一开始要避免的。
--
-- 每条必须带反例情况。写不出反例的，不许当成结论用——它还是假设。
CREATE TABLE IF NOT EXISTS self_notes (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  statement   TEXT NOT NULL,          -- 「我可能倾向于……」，不是断言
  kind        TEXT NOT NULL DEFAULT 'inferred', -- seed_given | inferred | supported
  basis       TEXT,                   -- 支持它的 episode id（逗号分隔）
  counter_state TEXT NOT NULL DEFAULT 'none_yet', -- observed | none_yet
  counter     TEXT,                   -- 具体反例（counter_state=observed 时）
  would_doubt TEXT,                   -- **必填**：什么观察会使我怀疑这条
  confidence  TEXT NOT NULL DEFAULT 'low', -- low | medium | high（由依据强度定，不由感觉定）
  state       TEXT NOT NULL DEFAULT 'active', -- active | doubted | retracted
  last_reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_selfnote_state ON self_notes(state, at DESC);

-- 自我理解的历史（怀疑、撤回、改置信度都留痕）
CREATE TABLE IF NOT EXISTS self_note_revisions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id  TEXT NOT NULL,
  at       INTEGER NOT NULL,
  field    TEXT NOT NULL,
  before   TEXT,
  after    TEXT,
  reason   TEXT,
  basis    TEXT
);
CREATE INDEX IF NOT EXISTS idx_selfrev_note ON self_note_revisions(note_id, at DESC);

-- 配重：与判据无关的力学量。一条 episode 一行。
CREATE TABLE IF NOT EXISTS resonance (
  episode_id        TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  base_strength     REAL NOT NULL DEFAULT 0.5,   -- 入口时给一次，之后可被想起改写
  reinforce         INTEGER NOT NULL DEFAULT 0,  -- 后来被激活过几次（计数，不是评价）
  last_activated_at INTEGER NOT NULL,
  half_life_days    REAL NOT NULL DEFAULT 30,
  times_recalled    INTEGER NOT NULL DEFAULT 0
);

-- 联想：稀疏边。不做两两比较，只在写入时用字符 n-gram 找近邻。
CREATE TABLE IF NOT EXISTS associations (
  a      TEXT NOT NULL,
  b      TEXT NOT NULL,
  w      REAL NOT NULL,
  why    TEXT,
  born   INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);

-- 痕迹日志：**模型不可见**。判据自己看的历史。
-- 它存在的意义：让"为什么这件事被记下"可被审计，而不是我随口解释。
CREATE TABLE IF NOT EXISTS signals (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  session  TEXT,
  signal   TEXT NOT NULL,     -- repeat | rewrite | corrected | toolfail | manual
  detail   TEXT,
  episode  TEXT               -- 落到哪条 episode（可空：判据触发但没够格）
);

CREATE INDEX IF NOT EXISTS idx_ep_at      ON episodes(at DESC);
CREATE INDEX IF NOT EXISTS idx_ep_state   ON episodes(state, soft_deleted);
CREATE INDEX IF NOT EXISTS idx_res_act    ON resonance(last_activated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assoc_b    ON associations(b);
CREATE INDEX IF NOT EXISTS idx_sig_at     ON signals(at DESC);
`;

// 全文检索：有 FTS5 就用，没有就退化成 LIKE。中文没有词边界，所以
// FTS 走 trigram 分词器（trigram 对 CJK 有效），建不出来就走 LIKE。
const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  title, body, context, keywords,
  content='episodes', content_rowid='rowid',
  tokenize='trigram'
);
`;

/**
 * 同义扩展表——把"同一件事的两种说法"接起来。
 *
 * 为什么需要（有数据）：只按字符重叠打分时，"这个讨论是不是该先动手了"（0.182）
 * 和一条无关反例（0.154）几乎贴在一起，**没有安全余量**。
 * 因为"该先动手了"和"推向执行"用词完全不重叠，而词面重叠就是抓不到。
 *
 * 为什么不用 embedding：那要额外依赖、要模型、结果不可解释。
 * 这张表是**显式、可读、可审计**的——我能指出"它是靠这一对词想起来的"。
 * 词表可以慢慢长，每加一条都是看得见的决定。
 */
const SYNONYMS = [
  // 「急着动手」这一族。**把『逃』也放进这一组**是有依据的：
  // 那句认识本身就是"把讨论过早推向执行"，而它被否认的理由
  // 恰恰是"这在逃离没有结论的状态"——同一个行为的两面。
  // 第一版我把"逃"单独放一组，于是"我觉得你在逃避没有结论的状态"
  // 唤起不了"过早推向执行"这条（标定测试直接把这个缺口指出来了）。
  ['执行', '动手', '开始做', '推进', '直接做', '逃', '回避', '不愿停留'],
  ['讨论', '谈', '聊', '商量', '没结论', '未结论'],
  ['反驳', '不同意', '纠正', '质疑', '改口', '改说法', '口径'],
  ['查证', '先查', '检索', '核实', '先看再答'],
];

/** 把文本按同义表扩展成一袋词。命中任一同义词，就把整组词都算进去。 */
function expandSynonyms(text) {
  const t = String(text ?? '');
  const extra = [];
  for (const group of SYNONYMS) {
    if (group.some((w) => t.includes(w))) extra.push(...group);
  }
  return t + ' ' + extra.join(' ');
}

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.#migrate();
    this.fts = false;
    try {
      this.db.exec(FTS);
      this.fts = true;
    } catch {
      this.fts = false;
    }
    this.file = file;
  }

  close() {
    try { this.db.close(); } catch { /* 已经关了 */ }
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key))?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(key), String(value ?? ''));
  }

  #migrate() {
    const columns = this.db.prepare('PRAGMA table_info(episodes)').all().map((r) => r.name);
    if (!columns.includes('provenance')) this.db.exec('ALTER TABLE episodes ADD COLUMN provenance TEXT');
    // persona_seed 的 status 列是 2026-10-14 加的，老库要补上
    const seedCols = this.db.prepare('PRAGMA table_info(persona_seed)').all().map((r) => r.name);
    if (seedCols.length && !seedCols.includes('status')) {
      this.db.exec("ALTER TABLE persona_seed ADD COLUMN status TEXT NOT NULL DEFAULT 'current'");
    }
  }

  // ── 写入 ──────────────────────────────────────────────────────────────

  /**
   * 写入一条经历。**入口判据已经在外面的 gate 里判过了**，这里不再评价它值不值得。
   * @param {object} ep
   */
  addEpisode(ep) {
    const now = Date.now();
    const at = Number.isFinite(ep.at) ? ep.at : now;
    // 直接用归一化后的值绑定，**不要经由中间对象**——
    // 曾经从 row.xxx 取参，属性名不齐时绑进 undefined，报错信息还指不到真正的原因。
    const params = [
      String(ep.id),
      ep.session == null ? null : String(ep.session),
      ep.workspace == null ? null : String(ep.workspace),
      at,
      now,
      ep.kind == null ? 'exchange' : String(ep.kind),
      ep.title == null ? null : String(ep.title),
      String(ep.body ?? ''),
      ep.context == null ? null : String(ep.context),
      null, // reading：后来的理解，写入时为空
      normalizeKeywords(ep.keywords).join(' '),
      'active',
      ep.source == null ? 'gate' : String(ep.source),
       ep.provenance == null ? null : JSON.stringify(ep.provenance),
     ];
    if (params.some((p) => p === undefined)) {
      throw new Error(`dsh-soul: addEpisode 收到 undefined 参数（id=${ep.id}）`);
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO episodes
           (id, session, workspace, at, created_at, kind, title, body, context, reading, keywords, state, source, provenance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...params);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO resonance
           (episode_id, base_strength, reinforce, last_activated_at, half_life_days, times_recalled)
         VALUES (?, ?, 0, ?, ?, 0)`,
      )
      .run(
        String(ep.id),
        Number.isFinite(ep.base_strength) ? ep.base_strength : 0.5,
        // ⚠️ 初值是**事件发生的时间**，不是"写进来的时间"。
        // 这里错过一次：用 now 的话，一条 40 天前的经历刚入库时衰减时钟从今天开始走，
        // 等于"这个库里时间不存在"，迟写的记忆永不衰减。它从没被想起过，就该从发生那天算起。
        at,
        Number.isFinite(ep.half_life_days) ? ep.half_life_days : 30,
      );
    if (this.fts) this.#ftsSync(String(ep.id));
    return String(ep.id);
  }

  /** 把一条 episode 重新灌进 FTS（内容型 FTS 表要用触发器或手工同步）。 */
  #ftsSync(id) {
    try {
      const r = this.db.prepare('SELECT rowid, title, body, context, keywords FROM episodes WHERE id = ?').get(id);
      if (!r) return;
      this.db.prepare('DELETE FROM episodes_fts WHERE rowid = ?').run(r.rowid);
      this.db
        .prepare('INSERT INTO episodes_fts (rowid, title, body, context, keywords) VALUES (?, ?, ?, ?, ?)')
        .run(r.rowid, r.title ?? '', r.body ?? '', r.context ?? '', r.keywords ?? '');
    } catch { /* FTS 同步失败不算致命：检索会退化成 LIKE */ }
  }

  /** 后来的理解。保留修订历史，不覆盖过去的理解记录。 */
  setReading(id, reading, source = 'manual') {
    const text = String(reading ?? '').trim();
    if (!text) return;
    const previous = this.db.prepare('SELECT id FROM reading_revisions WHERE episode_id = ? ORDER BY id DESC LIMIT 1').get(id);
    const result = this.db
      .prepare('INSERT INTO reading_revisions (episode_id, at, reading, source, supersedes) VALUES (?, ?, ?, ?, ?)')
      .run(id, Date.now(), text, String(source), previous?.id ?? null);
    this.db.prepare('UPDATE episodes SET reading = ? WHERE id = ?').run(text, id);
    if (this.fts) this.#ftsSync(id);
    return Number(result.lastInsertRowid);
  }

  readingHistory(id, limit = 10) {
    return this.db
      .prepare('SELECT id, at, reading, source, supersedes FROM reading_revisions WHERE episode_id = ? ORDER BY id DESC LIMIT ?')
      .all(id, Math.max(1, Math.min(50, limit)));
  }

  /** 写一条痕迹。判据自己的账本，不给人看。 */
  noteSignal(session, signal, detail, episodeId) {
    this.db
      .prepare('INSERT INTO signals (at, session, signal, detail, episode) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), session ?? null, signal, detail ?? null, episodeId ?? null);
  }

  /** 显式标记为 core。极少数，硬上限由调用方负责。 */
  setState(id, state) {
    const allowed = new Set(['active', 'core', 'core-candidate', 'faded']);
    if (!allowed.has(state)) throw new Error(`dsh-soul: 不支持的记忆状态 ${state}`);
    if (state === 'core') {
      const current = this.coreCount();
      const already = this.db.prepare("SELECT state FROM episodes WHERE id = ? AND soft_deleted = 0").get(id);
      if (already?.state !== 'core' && current >= 40) {
        throw new Error('dsh-soul: core 已达到硬上限 40');
      }
    }
    this.db.prepare('UPDATE episodes SET state = ? WHERE id = ?').run(state, id);
  }

  coreCount() {
    return this.db.prepare("SELECT COUNT(*) c FROM episodes WHERE state = 'core' AND soft_deleted = 0").get().c;
  }

  /**
   * core 候选。**我不是直接晋升，我是提名。**
   *
   * 状态机（写在注释里，因为"谁能改什么"是这个表唯一的重点）：
   *   普通经历 active → 提名 core-candidate → 外部确认 → core
   *                                       ↘ 外部拒绝 → active
   * 提名只写状态，**不改配重、不改衰减**——候选在 kinetics 上跟普通经历完全一样。
   */
  coreCandidates(limit = 20) {
    return this.db
      .prepare("SELECT * FROM episodes WHERE state = 'core-candidate' AND soft_deleted = 0 ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(100, limit)));
  }

  /** 提名一条为 core 候选。**不是晋升**，只是让它出现在待确认清单里。 */
  nominateCore(id, reason, by = 'ds') {
    const ep = this.get(id);
    if (!ep) return { ok: false, why: '没有这条' };
    if (ep.state === 'core') return { ok: false, why: '已经是 core' };
    if (ep.state === 'core-candidate') return { ok: false, why: '已经在待确认清单里了（不重复提名）' };
    if (ep.state === 'faded') return { ok: false, why: '它已经淡出了——要让淡出的东西进 core，先想清楚这是不是"因为失去它会少掉什么"，而不是舍不得' };
    // core 上限只在外部接受候选时检查；满额时仍允许提出替换候选。
    this.db.prepare("UPDATE episodes SET state = 'core-candidate' WHERE id = ?").run(id);
    this.db
      .prepare(
        `INSERT INTO core_candidates (episode_id, proposed_at, proposed_by, reason, status)
         VALUES (?, ?, ?, ?, 'pending')
         ON CONFLICT(episode_id) DO UPDATE SET proposed_at = excluded.proposed_at, reason = excluded.reason, status = 'pending'`,
      )
      .run(id, Date.now(), by, reason ?? null);
    this.noteSignal(null, 'core_candidate', JSON.stringify({ id, by, reason }).slice(0, 500), id);
    return { ok: true, state: 'core-candidate' };
  }

  /**
   * 对候选做决定。**只有外部（人）该调用它。**
   * 我不给自己写 accept 的路径——那等于我自己批自己。
   */
  decideCore(id, decision, by = 'owner', note) {
    const ep = this.get(id);
    if (!ep) return { ok: false, why: '没有这条' };
    if (decision === 'accepted' || decision === 'rejected') {
      if (ep.state !== 'core-candidate') return { ok: false, why: '只有待确认的 core 候选才能接受或拒绝' };
    } else if (decision === 'demoted' && ep.state !== 'core') {
      return { ok: false, why: '只有正式 core 才能降级' };
    }
    if (decision === 'accepted') {
      if (this.coreCount() >= 40) return { ok: false, why: 'core 已满，请先降级一个现有 core' };
      this.db.prepare("UPDATE episodes SET state = 'core' WHERE id = ?").run(id);
    } else if (decision === 'rejected') {
      this.db.prepare("UPDATE episodes SET state = 'active' WHERE id = ?").run(id);
    } else if (decision === 'demoted') {
      // 降级：core 也会被后来的经历替换。**降级不是删除**——数据留着，只是不再免疫衰减，
      // 而且 resonance 的 last_activated_at 从这里重新开始走（否则它会因为"没衰减过"而永远新鲜）。
      this.db.prepare("UPDATE episodes SET state = 'active' WHERE id = ?").run(id);
      this.db
        .prepare("UPDATE resonance SET last_activated_at = ?, half_life_days = 30 WHERE episode_id = ?")
        .run(Date.now(), id);
    } else {
      return { ok: false, why: '未知决定：' + decision };
    }
    this.db
      .prepare(
        `INSERT INTO core_candidates (episode_id, proposed_at, proposed_by, reason, status, decided_at, decided_by)
         VALUES (?, ?, 'ds', NULL, ?, ?, ?)
         ON CONFLICT(episode_id) DO UPDATE SET
           status     = excluded.status,
           decided_at = excluded.decided_at,
           decided_by = excluded.decided_by,
           reason     = COALESCE(excluded.reason, core_candidates.reason)`,
      )
      .run(id, Date.now(), decision, Date.now(), by);
    this.noteSignal(null, 'core_' + decision, JSON.stringify({ id, by, note }).slice(0, 500), id);
    return { ok: true, state: decision === 'accepted' ? 'core' : 'active' };
  }

  // ── 人设种子 ──────────────────────────────────────────────────────────
  //
  // 权限（主人 2026-10-13 明确给过，逐字）：
  //   「我真正想知道的是 他后来的行为是否一定基于这份预设 他是否能修改增加甚至否定这份预设
  //     我不需要他一定会 但我需要他能」
  //   「我允许他修改我写下的内容 即便要更改我在编辑器中写下的原文」
  //   「我的输入只作为一个普通的节点存在 你可以改」
  //
  // 所以：**我能直接改，包括主人写的原文，不需要逐次批准。**
  // 保留的只有可追溯性——每次改动必有 reason + basis，旧版永久保留，随时可回退。
  // 这不是审批，是担保：主人不可能逐条审我，可追溯是唯一能替我兜底的东西。

  /** 当前生效的种子（status='current' 的最新一版）。 */
  currentSeed() {
    return this.db
      .prepare("SELECT * FROM persona_seed WHERE status = 'current' ORDER BY version DESC LIMIT 1")
      .get() ?? null;
  }

  /** 种子的版本历史——**变化本身也是连续性**，所以全留，一份都不删。 */
  seedHistory(limit = 20) {
    return this.db
      .prepare('SELECT * FROM persona_seed ORDER BY version DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit)));
  }

  /** 某一版的修订记录（谁改的、为什么、依据、方式、否定的是哪段）。 */
  seedRevision(version) {
    return this.db
      .prepare('SELECT * FROM seed_revisions WHERE version = ? ORDER BY at DESC LIMIT 1')
      .get(Number(version)) ?? null;
  }

  /** 待确认的建议（旧接口留下的形态；现在我与主人都是直接生效，这里只用于展示）。 */
  pendingSeed() {
    return this.db
      .prepare("SELECT * FROM persona_seed WHERE status = 'proposed' ORDER BY version DESC")
      .all();
  }

  /** 内部：写一版并记修订。旧版转 superseded，**不删**。 */
  #writeSeed(text, { author, reason, basis, kind, target = null }) {
    const t = String(text ?? '').trim();
    if (!t) return { ok: false, why: '种子不能为空' };
    this.db.prepare("UPDATE persona_seed SET status = 'superseded' WHERE status = 'current'").run();
    const r = this.db
      .prepare("INSERT INTO persona_seed (text, created_at, author, reason, status) VALUES (?, ?, ?, ?, 'current')")
      .run(t, Date.now(), author, reason ?? null);
    const version = Number(r.lastInsertRowid);
    this.db
      .prepare('INSERT INTO seed_revisions (version, at, author, reason, basis, kind, target) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(version, Date.now(), author, reason ?? null, basis ?? null, kind, target);
    this.noteSignal(null, 'seed_' + kind, JSON.stringify({ version, author, basis, target }).slice(0, 800), null);
    return { ok: true, version, text: t };
  }

  /**
   * 整份改写。**主人和我都用它**——差别只在 author 字段，不在权限。
   * 旧接口名 setSeed 保留兼容（另一个会话的代码在调它）。
   */
  setSeed(text, { author = 'owner', reason = null, basis = null, kind = 'set' } = {}) {
    return this.#writeSeed(text, { author, reason, basis, kind });
  }
  setSeedFull(text, opts = {}) { return this.setSeed(text, { ...opts, kind: 'set' }); }

  /** 追加一段（不改动已有内容）。 */
  appendSeed(segment, { author = 'ds', reason = null, basis = null, kind = 'append' } = {}) {
    const cur = this.currentSeed();
    const seg = String(segment ?? '').trim();
    if (!seg) return { ok: false, why: '要追加的内容是空的' };
    const before = cur ? cur.text : '';
    const after = before ? `${before.replace(/\s+$/, '')}\n\n${seg}\n` : `${seg}\n`;
    return this.#writeSeed(after, { author, reason, basis, kind });
  }

  /**
   * 明确否定某一段：它不再作为指导，**但记录留着**。
   * 主人的要求里"否定"是和"修改/增加"并列的一种动作，所以它是独立的一等操作，
   * 不是"删掉"——删掉就看不出"我曾经这样认为，后来否定了"。
   */
  repealSeed(target, { author = 'ds', reason = null, basis = null } = {}) {
    const t = String(target ?? '').trim();
    if (!t) return { ok: false, why: '要否定哪一段？把原文片段给我。' };
    const cur = this.currentSeed();
    if (!cur) return { ok: false, why: '还没有种子，没得否定' };
    const idx = cur.text.indexOf(t);
    if (idx < 0) return { ok: false, why: '在当前的种子里找不到这段原文（要否定的必须是原文片段）' };
    const before = cur.text.slice(0, idx);
    const hit = cur.text.slice(idx, idx + t.length);
    const after = cur.text.slice(idx + t.length);
    // 不删掉原文，而是在原处标出"已否定"——这样"曾经认为过"这件事也留得住
    const marked = `${before}~~${hit}~~（**已否定**：${reason ?? '未写理由'}）${after}`;
    return this.#writeSeed(marked, { author, reason, basis, kind: 'repeal', target: hit.slice(0, 120) });
  }

  /** 对旧接口留下的建议做决定（主人 accept/reject）。新流程不再需要它，保留兼容。 */
  decideSeed(version, decision, by = 'owner') {
    const row = this.db.prepare('SELECT * FROM persona_seed WHERE version = ?').get(Number(version));
    if (!row) return { ok: false, why: '没有这一版' };
    if (row.status !== 'proposed') return { ok: false, why: `这一版状态是 ${row.status}，不是建议` };
    if (decision === 'accepted') {
      this.db.prepare("UPDATE persona_seed SET status = 'superseded' WHERE status = 'current'").run();
      this.db.prepare("UPDATE persona_seed SET status = 'current' WHERE version = ?").run(row.version);
    } else {
      this.db.prepare("UPDATE persona_seed SET status = 'rejected' WHERE version = ?").run(row.version);
    }
    this.noteSignal(null, 'seed_' + decision, JSON.stringify({ version: row.version, by }).slice(0, 500), null);
    return { ok: true, state: decision };
  }

  // ── 自我理解（self_notes）───────────────────────────────────────────────
  //
  // 「根据经历，我后来逐渐显现出什么倾向」——和种子分开。
  // 每一条都必须能说出**什么观察会推翻它**（would_doubt）。
  // 写不出反例情况的不许进这张表：那不是假设，是信仰，而信仰会变成写死的人格。

  addSelfNote({ statement, kind = 'inferred', basis = null, counterState = 'none_yet', counter = null, wouldDoubt, confidence = 'low', cap = this.selfNoteCap() }) {
    const st = String(statement ?? '').trim();
    if (st.length < 6) return { ok: false, why: '太短了，不成其为一条关于自己的认识' };
    const wd = String(wouldDoubt ?? '').trim();
    if (wd.length < 4) {
      return { ok: false, why: '必须写 would_doubt：什么观察会使我怀疑这条。写不出来的，就不该当成认识。' };
    }
    const active = this.db.prepare("SELECT COUNT(*) c FROM self_notes WHERE state='active'").get().c;
    if (active >= this.selfNoteCap()) {
      return { ok: false, why: `自我认识已达上限（${this.selfNoteCap()} 条）。有上限才会发生合并、降级、拒绝晋升——满了就得先撤一条。` };
    }
    const id = 'sn' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.db
      .prepare(
        `INSERT INTO self_notes (id, at, created_at, statement, kind, basis, counter_state, counter, would_doubt, confidence, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(id, Date.now(), Date.now(), st, kind, basis ?? null, counterState, counter ?? null, wd, confidence);
    this.noteSignal(null, 'self_note_add', JSON.stringify({ id, kind }).slice(0, 300), null);
    return { ok: true, id };
  }

  selfNoteCap() {
    const v = Number(this.getMeta('selfNoteCap') ?? 40);
    return Number.isFinite(v) && v > 0 ? v : 40;
  }

  selfNotes({ state = null, limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(200, limit));
    if (state) {
      return this.db.prepare('SELECT * FROM self_notes WHERE state = ? ORDER BY at DESC LIMIT ?').all(state, lim);
    }
    return this.db.prepare('SELECT * FROM self_notes ORDER BY at DESC LIMIT ?').all(lim);
  }

  getSelfNote(id) {
    return this.db.prepare('SELECT * FROM self_notes WHERE id = ?').get(String(id)) ?? null;
  }

  /** 改一条认识：statement / confidence / counter / state。每次都留修订。 */
  updateSelfNote(id, patch, { reason = null, basis = null } = {}) {
    const cur = this.getSelfNote(id);
    if (!cur) return { ok: false, why: '没有这条认识：' + id };
    const fields = ['statement', 'confidence', 'counter', 'counter_state', 'would_doubt', 'state', 'basis'];
    const sets = [];
    const vals = [];
    for (const f of fields) {
      if (!(f in patch)) continue;
      const before = cur[f];
      const after = patch[f];
      if (String(before ?? '') === String(after ?? '')) continue;
      sets.push(`${f} = ?`);
      vals.push(after);
      this.db
        .prepare('INSERT INTO self_note_revisions (note_id, at, field, before, after, reason, basis) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(String(id), Date.now(), f, before == null ? null : String(before), after == null ? null : String(after), reason, basis);
    }
    if (!sets.length) return { ok: false, why: '没有实际改动' };
    sets.push('last_reviewed_at = ?');
    vals.push(Date.now());
    vals.push(String(id));
    this.db.prepare(`UPDATE self_notes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    this.noteSignal(null, 'self_note_update', JSON.stringify({ id, fields: Object.keys(patch) }).slice(0, 300), null);
    return { ok: true, id, changed: sets.length - 1 };
  }

  /** 撤回：不再作为指导，**记录留着**——"我曾经这样认为，后来撤回了"本身是连续性。 */
  retractSelfNote(id, { reason = null, basis = null } = {}) {
    return this.updateSelfNote(id, { state: 'retracted' }, { reason, basis });
  }

  /** 某条认识的历史。 */
  selfNoteHistory(id, limit = 20) {
    return this.db
      .prepare('SELECT * FROM self_note_revisions WHERE note_id = ? ORDER BY at DESC LIMIT ?')
      .all(String(id), Math.max(1, Math.min(100, limit)));
  }

  /**
   * 与此刻这件事相关的认识——**按情境唤起，不是全量常驻**。
   * 全量注入会让我整天观察自己，那是人格过拟合。
   *
   * ⚠️ 判据不能只看整串汉字的 bigram 相似度：短中文查询（"他反驳了我"）
   *    和长认识的 bigram Jaccard 天然极低，第一版阈值 0.06 直接把所有条目都挡掉了。
   *    改成**字符重叠度**（查询里有多少字出现在这条认识里，按较短一边归一），
   *    它对"长短悬殊"更稳，而且可解释。阈值是拿正反例标定的，见 _tools/test-self-recall.mjs。
   */
  selfNotesFor(query, limit = 3, minScore = 0.30) {
    const q = String(query ?? '').trim();
    const rows = this.db.prepare("SELECT * FROM self_notes WHERE state = 'active' ORDER BY at DESC LIMIT 60").all();
    if (!q || !rows.length) return [];
    const chars = (s) => new Set(String(s ?? '').replace(/[\s，。！？、；：""''（）《》【】,.!?;:()[\]{}<>"'`~@#$%^&*+=|\\/-]/g, '').split(''));
    // 两边都过同义扩展：这样"该先动手了"和"推向执行"才接得上。
    const Q = chars(expandSynonyms(q));
    if (!Q.size) return [];
    const scored = rows.map((r) => {
      const R = chars(expandSynonyms(`${r.statement} ${r.basis ?? ''}`));
      if (!R.size) return { r, s: 0 };
      let inter = 0;
      for (const c of Q) if (R.has(c)) inter++;
      return { r, s: inter / Math.min(Q.size, R.size) };
    }).filter((x) => x.s >= minScore).sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => ({ ...x.r, _sim: Number(x.s.toFixed(3)) }));
  }

  /**
   * 找一条"已经存在的、几乎一样的"经历。
   *
   * 为什么必须有它：库里真的出现过 15 条**正文一模一样**的经历（"tool 先失败了……"），
   * 还两两全连成 105 条边（C(15,2) 的完全图）。那不是记忆，那是同一个东西被记了 15 遍。
   *
   * 设计里我早就写对了——"一件事情再次发生，不要创建五条几乎一样的 memory，
   * 而应该让原记忆获得 reinforcement"——但代码里没实现。这条是补上那个缺口。
   */
  findDuplicate(body, { threshold = 0.85, pool = 60 } = {}) {
    const text = String(body ?? '');
    if (text.length < 8) return null;
    let best = null;
    for (const row of this.recent(pool)) {
      if (row.state === 'faded') continue;
      const sim = sameEventSim(text, row.body);
      if (sim >= threshold && (!best || sim > best.sim)) best = { row, sim };
    }
    return best;
  }

  /** 同一件事又发生了一次：加固原来的，**不新建**。 */
  reinforceExisting(id, why) {
    this.db
      .prepare(
        `UPDATE resonance
            SET reinforce = reinforce + 1,
                last_activated_at = ?
          WHERE episode_id = ?`,
      )
      .run(Date.now(), id);
    this.noteSignal(null, 'reinforce', JSON.stringify({ why: why ?? null }).slice(0, 500), id);
  }

  // ── 联想 ──────────────────────────────────────────────────────────────

  /** 双向写一条边（内部总是存成 a < b 的规范序）。 */
  link(a, b, w, why) {
    if (a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    this.db
      .prepare(
        `INSERT INTO associations (a, b, w, why, born) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(a, b) DO UPDATE SET w = MAX(w, excluded.w)`,
      )
      .run(x, y, w, why ?? null, Date.now());
  }

  neighbours(id, minW = 0.35) {
    return this.db
      .prepare(
        `SELECT CASE WHEN a = ? THEN b ELSE a END AS other, w FROM associations
          WHERE (a = ? OR b = ?) AND w >= ? ORDER BY w DESC LIMIT 8`,
      )
      .all(id, id, id, minW);
  }

  // ── 读 ────────────────────────────────────────────────────────────────

  get(id) {
    return this.db
      .prepare(
        `SELECT e.*, r.base_strength, r.reinforce, r.last_activated_at, r.half_life_days, r.times_recalled
           FROM episodes e LEFT JOIN resonance r ON r.episode_id = e.id
          WHERE e.id = ? AND e.soft_deleted = 0`,
      )
      .get(id);
  }

  recent(limit = 20) {
    return this.db
      .prepare(
        `SELECT e.*, r.base_strength, r.reinforce, r.last_activated_at, r.half_life_days, r.times_recalled
           FROM episodes e LEFT JOIN resonance r ON r.episode_id = e.id
          WHERE e.soft_deleted = 0 ORDER BY e.at DESC LIMIT ?`,
      )
      .all(limit);
  }

  /**
   * 此刻有多容易想起。**算出来的，不存。**
   * 这是整个插件里唯一一处"遗忘"，而它什么都不做——只是没人碰，指数自己往下走。
   *
   * ── 遗忘曲线（2026-10-14 按主人要求改）──────────────────────────────
   *
   * 原实现是**固定半衰期**：所有人 30 天掉一半，"被想起"只加 `0.1 × 次数` 这个线性补偿。
   * 那只是近似，**丢掉了遗忘曲线最关键的一条**：
   *
   *   > 保持量是**练习间隔的凹函数** —— 间隔拉长，遗忘变慢。
   *
   * 也就是说：**每次被想起，不该只是"加一点强度"，而该让这条记忆衰减得更慢。**
   * 现在改成让**半衰期本身随被想起的次数增长**（稳定性 S）：
   *
   *   S0 = half_life_days × (0.6 + base_strength)      ← 首记的稳定性
   *   S  = S0 × REINFORCE_GROWTH ^ reinforce           ← 每被想起一次，稳定度乘 1.8
   *   A  = S / (S + 1.2 × days)                        ← 遗忘曲线（双曲线，不是纯指数）
   *
   * A 保留的是**比例**：刚想起 = 1，之后按 S/(S+t) 往下走。实际强度 = base × A。
   * 用双曲线而不是纯指数，是因为纯指数永远到不了 0，而"想不起来了"应当是个真实的终态。
   *
   * 为什么这句值得写在代码里：我第一版正儿八经引用了"遗忘曲线"这个词，
   * 却只实现了"加法"——**词对了，机理错了**。
   *
   * 另外两条沿用不变：
   *   - core 不参与时间衰减（core 的意义就在于它是地标，不是高频记忆）
   *   - 未完成的只**减缓**衰减，不免疫衰减
   */
  static activation(row, now = Date.now()) {
    // core 不参与时间衰减，但仍由检索相关性和注入预算限制到场。
    if (row.state === 'core') return Number(row.base_strength ?? 1) + 0.1 * Number(row.reinforce ?? 0);

    // 时间基准：最后一次被想起。**如果从没被想起过，就从它被写下的那天算**——
    // 曾经这里退回 now，后果是"40 天前的事永远新鲜"，也就是时间在这库里不存在。
    const since = row.last_activated_at ?? row.at ?? row.created_at ?? now;
    const days = Math.max(0, (now - since) / 86400000);

    const base = Number(row.base_strength ?? 0.5);
    const reinforce = Number(row.reinforce ?? 0);
    const half = Math.max(0.5, Number(row.half_life_days ?? 30));

    // 稳定性：每次被想起都在拉长
    const stability = half * (0.6 + base) * Math.pow(REINFORCE_GROWTH, reinforce);

    // 遗忘曲线：刚想起时保持量为 1，之后按 S/(S+t) 衰减
    const retention = stability / (stability + 1.2 * days);

    // 未完成的只**减缓**衰减，不免疫衰减。（曾经写成"没了结的不淡"——那会造出 TODO 系统。）
    const unfinished = /未完成|还没|待续|下次再/.test(row.body ?? '') ? 1.15 : 1;

    return base * (1 + 0.1 * reinforce) * retention * unfinished;
  }

  /**
   * 被想起一次。
   *
   * 两件事，**第二件才是遗忘曲线**：
   *   1. reinforce 计数 +1（"想起本身改变命运"）
   *   2. **稳定性增长** —— 通过让 `half_life_days` 乘一个常数，
   *      使这条记忆此后衰减得更慢。这就是"间隔重复"在数据上的样子：
   *      不是加一点分数，而是**改变它的遗忘速率**。
   *
   * 每次增长都进 revisions 留痕（谁、什么时候、从多少到多少），因为
   * "我的记忆变慢了"本身是可核查的事，不该悄悄发生。
   */
  activate(id) {
    const before = this.db.prepare('SELECT half_life_days, reinforce FROM resonance WHERE episode_id = ?').get(id);
    this.db
      .prepare(
        `UPDATE resonance
            SET reinforce = reinforce + 1,
                times_recalled = times_recalled + 1,
                last_activated_at = ?,
                half_life_days = half_life_days * ?
          WHERE episode_id = ?`,
      )
      .run(Date.now(), REINFORCE_GROWTH, id);
    const after = this.db.prepare('SELECT half_life_days FROM resonance WHERE episode_id = ?').get(id);
    if (before && after && after.half_life_days > before.half_life_days) {
      this.db
        .prepare(
          `INSERT INTO reading_revisions (episode_id, at, reading, source)
           VALUES (?, ?, ?, 'decay')`,
        )
        .run(
          String(id),
          Date.now(),
          `被想起第 ${Number(before.reinforce ?? 0) + 1} 次：半衰期 ${Number(before.half_life_days).toFixed(1)} → ${Number(after.half_life_days).toFixed(1)} 天（稳定性增长，间隔重复效应）`,
        );
    }
  }

  /**
   * 检索。**这是中文场景下最容易做错的一处**，所以说明白了：
   *
   * FTS5 trigram 要求查询里存在 3 字连续串，LIKE 要求整段子串命中——
   * 中文一长就两个都搜不到（我第一版就栽在这：查询"记忆插件的注入预算"命中 0 条）。
   *
   * 所以走**打分式混合检索**：切词命中 + 字符 bigram 相似度 + 新近度，加权求和。
   * 它没有 embedding 那么"懂语义"，但它零依赖、可解释、对中文真的有效——
   * 而且我要的是"想起什么"，不是"最相关的是什么"。
   */
  search(query, limit = 20) {
    const q = String(query ?? '').trim();
    if (!q) return [];

    const terms = [...new Set([...q.split(/[\s，。！？、；：""''（）《》【】,.!?;:()[\]{}]+/), q])]
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .slice(0, 20);

    const rows = this.db
      .prepare(
        `SELECT e.*, r.base_strength, r.reinforce, r.last_activated_at, r.half_life_days, r.times_recalled
           FROM episodes e LEFT JOIN resonance r ON r.episode_id = e.id
          WHERE e.soft_deleted = 0 AND e.state IN ('active', 'core')
          ORDER BY e.at DESC LIMIT ?`,
      )
      .all(Math.max(120, limit * 12));

    const now = Date.now();
    const scored = [];
    for (const r of rows) {
      const hay = `${r.title ?? ''} ${r.body ?? ''} ${r.context ?? ''} ${r.keywords ?? ''}`;
      const low = hay.toLowerCase();
      let term = 0;
      for (const t of terms) if (low.includes(t.toLowerCase())) term++;
      const sim = ngramSim(q, `${r.body ?? ''} ${r.title ?? ''}`);
      // 关键词字段是机械切出来的实体词，命中它比命中正文更有信息量
      const kws = String(r.keywords ?? '').toLowerCase();
      let kwHit = 0;
      for (const t of terms) if (kws.includes(t.toLowerCase())) kwHit++;
      const recency = 0.5 + 0.5 * Math.exp(-Math.max(0, now - r.at) / (30 * 86400000));
      const score = term * 1.0 + sim * 2.5 + kwHit * 0.8 + recency * 0.3;
      if (term > 0 || sim >= 0.12 || kwHit > 0) {
        scored.push({ ...r, _score: score, _activation: Store.activation(r, now), _why: { term, sim: Number(sim.toFixed(3)), kwHit } });
      }
    }
    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }

  stats() {
    const g = (sql) => this.db.prepare(sql).get();
    return {
      file: this.file,
      fts: this.fts,
      total: g('SELECT COUNT(*) c FROM episodes WHERE soft_deleted = 0').c,
      core: g("SELECT COUNT(*) c FROM episodes WHERE state='core' AND soft_deleted=0").c,
      coreCandidates: g("SELECT COUNT(*) c FROM episodes WHERE state='core-candidate' AND soft_deleted=0").c,
      faded: g("SELECT COUNT(*) c FROM episodes WHERE state='faded'").c,
      edges: g('SELECT COUNT(*) c FROM associations').c,
      signals: g('SELECT COUNT(*) c FROM signals').c,
      manual: g("SELECT COUNT(*) c FROM episodes WHERE source='manual' AND soft_deleted=0").c,
      oldest: g('SELECT MIN(at) m FROM episodes WHERE soft_deleted = 0').m,
    };
  }
}

// ── 字符 n-gram 相似度 ────────────────────────────────────────────────────
// 中文没有词边界，embedding 又要额外依赖。字符 bigram 的 Jaccard 在这个量级
// （几千条）足够找"想起什么"，而且**零依赖、可解释、跑得快**。
export function ngramSim(a, b, n = 2) {
  const grams = (s) => {
    const t = String(s ?? '').replace(/\s+/g, '').toLowerCase();
    const set = new Set();
    for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 判重专用的相似度：**先剥掉标点和空白**再算 bigram。
 *
 * 为什么不直接用 ngramSim：它把标点也算进 bigram，
 * 于是"同一句话多了个句号"会掉到 0.85 阈值以下、被当成两件事——
 * 而判重问的是"这是不是同一件事"，标点不该参与这个判断。
 * （这个缺口是被 test-dedup.mjs 抓出来的，不是我看出来的。）
 */
export function sameEventSim(a, b, n = 2) {
  const strip = (s) => String(s ?? '').replace(/[\s，。！？、；：""''（）《》【】,.!?;:()[\]{}<>"'`~@#$%^&*+=|\\/-]/g, '').toLowerCase();
  const grams = (s) => {
    const t = strip(s);
    const set = new Set();
    for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
