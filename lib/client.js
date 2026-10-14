// dsh-soul · 浏览器半。人格阅读窗口与插件运行设置独立。
window.__ModuleLoader__.load({
  id: 'dsh-soul',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const react = require('react');
    const h = react.createElement;
    exports.name = 'dsh-soul';
    exports.inject = ['slots'];
    const ENTRY_ID = 'dsh-soul';
    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', width: '100%', maxWidth: '780px', minWidth: 0, fontSize: '14px', lineHeight: 1.75, color: 'var(--dsw-alias-label-primary, inherit)' },
      compact: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' },
      title: { fontSize: '20px', fontWeight: 600, margin: 0 },
      heading: { fontSize: '15px', fontWeight: 600, margin: 0 },
      meta: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', margin: 0 },
      row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px' },
      box: { border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'var(--dsw-alias-bg-layer-1, transparent)', borderRadius: '10px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
      reading: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', fontSize: '15px', lineHeight: 1.95, margin: 0, height: '240px', overflowY: 'auto', padding: '12px', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', borderRadius: '8px' },
      text: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', lineHeight: 1.8, margin: 0 },
      textarea: { width: '100%', boxSizing: 'border-box', minHeight: '220px', resize: 'vertical', padding: '12px', borderRadius: '8px', font: 'inherit', lineHeight: 1.75, border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit' },
      input: { width: '100px', borderRadius: '6px', padding: '5px 8px', font: 'inherit', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit' },
      button: { padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      primary: { padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'var(--dsw-alias-brand-primary)', font: 'inherit', fontWeight: 600, cursor: 'pointer' },
      error: { color: 'var(--dsw-alias-state-error-primary, inherit)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '13px' },
      details: { borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', paddingTop: '12px' },
      summary: { cursor: 'pointer', fontWeight: 600, marginBottom: '10px' },
    };
    const message = (e) => String(e?.message ?? e);
    const fmtTime = (at) => {
      if (!at) return '尚未生成';
      const date = new Date(at);
      return Number.isNaN(date.getTime()) ? String(at) : date.toLocaleString('zh-CN');
    };
    async function request(path, body, signal) {
      const response = await fetch('/dsh-soul/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
      });
      const json = await response.json();
      if (!response.ok || json?.ok !== true) throw new Error(message(json?.error ?? ('请求失败（HTTP ' + response.status + '）')));
      return json.value;
    }
    function Fold({ title, children }) {
      return h('details', { style: S.details }, h('summary', { style: S.summary }, title), children);
    }
    // 状态只供页面阅读；不注册 agent Tool、不写 persona、不回灌总结。
    function useStatus() {
      const [status, setStatus] = react.useState(null);
      const [error, setError] = react.useState('');
      const [loading, setLoading] = react.useState(false);
      const alive = react.useRef(false);
      const pending = react.useRef(null);
      const load = react.useCallback(async (force = false) => {
        if (!alive.current) return;
        if (pending.current) {
          if (force !== true) return;
          pending.current.abort();
        }
        const controller = new AbortController();
        pending.current = controller;
        setLoading(true);
        try {
          const value = await request('status', undefined, controller.signal);
          if (alive.current && pending.current === controller) { setStatus(value); setError(''); }
        } catch (e) {
          if (alive.current && pending.current === controller && e?.name !== 'AbortError') setError('读取状态失败：' + message(e));
        } finally {
          if (pending.current === controller) {
            pending.current = null;
            if (alive.current) setLoading(false);
          }
        }
      }, []);
      react.useEffect(() => {
        alive.current = true;
        load();
        const timer = setInterval(load, 30000);
        return () => { alive.current = false; clearInterval(timer); pending.current?.abort(); };
      }, [load]);
      return { status, error, loading, load };
    }
    function PersonaWindow() {
      const { status, error, loading, load } = useStatus();
      const [draft, setDraft] = react.useState('');
      const [baseline, setBaseline] = react.useState(null);
      const dirtyRef = react.useRef(false);
      const [busy, setBusy] = react.useState('');
      const [actionError, setActionError] = react.useState('');
      const [notice, setNotice] = react.useState('');
      const action = react.useRef(null);
      const alive = react.useRef(true);
      react.useEffect(() => { alive.current = true; return () => { alive.current = false; action.current?.abort(); }; }, []);
      // 轮询只更新无草稿的初始编辑器，绝不把现行人格或表单变更塞进草稿。
      react.useEffect(() => {
        if (!status || dirtyRef.current) return;
        const text = String(status.initialPersona ?? '');
        setDraft(text); setBaseline(text);
      }, [status]);
      const dirty = baseline !== null && draft !== baseline;
      const run = async (kind) => {
        if (action.current || !status) return;
        if (kind === 'reset' && !window.confirm('将现行人格明确重设为已保存的初始人格？未保存的草稿不会用于重设，旧版本保留在历史中。')) return;
        const controller = new AbortController();
        action.current = controller;
        setBusy(kind); setActionError(''); setNotice('');
        const submitted = draft;
        try {
          await request(kind === 'summary' ? 'summary' : 'persona',
            kind === 'summary' ? {} : kind === 'save-initial' ? { action: kind, text: submitted } : { action: 'reset' }, controller.signal);
          if (!alive.current) return;
          if (kind === 'save-initial') {
            setBaseline(submitted);
            // 用户提交期间仍可编辑；以最新草稿判断是否需要保护。
            setDraft((current) => { dirtyRef.current = current !== submitted; return current; });
          }
          setNotice(kind === 'summary' ? '总结已生成。' : kind === 'reset' ? '现行人格已明确重设。' : '初始人格已保存；现行人格没有改变。');
          await load(true);
        } catch (e) {
          if (alive.current && e?.name !== 'AbortError') setActionError('操作失败：' + message(e));
        } finally { action.current = null; if (alive.current) setBusy(''); }
      };
      const summary = status?.summary;
      const history = Array.isArray(status?.seedHistory) ? status.seedHistory : [];
      const notes = Array.isArray(status?.selfNotes) ? status.selfNotes : [];
      return h('div', { style: S.root },
        h('h2', { style: S.title }, '人格'),
        h('p', { style: S.meta }, '初始人格是起点，现行人格由经历继续形成。总结只供阅读，不回写人格或记忆。'),
        h('section', { style: S.box },
          h('div', { style: S.row }, h('h3', { style: S.heading }, '此刻的人格'),
            h('button', { type: 'button', style: S.button, disabled: loading || !!busy, onClick: load }, loading ? '读取中…' : '刷新'),
            h('button', { type: 'button', style: S.primary, disabled: !status || !!busy, onClick: () => run('summary') }, busy === 'summary' ? '总结中…' : '现在总结')),
          h('div', { style: S.reading }, summary?.text || (status ? '还没有人格总结。可手动生成，也可在插件设置中启用定期总结。' : '正在读取人格…')),
          h('p', { style: S.meta }, summary ? '更新于 ' + fmtTime(summary.at) + (summary.sourceVersion != null ? ' · 根据现行版本 v' + summary.sourceVersion : '') : '只读内容，不替代现行人格原文。'),
          status?.summaryError ? h('div', { role: 'alert', style: S.error }, '最近一次总结失败：' + message(status.summaryError)) : null),
        error ? h('div', { role: 'alert', style: S.error }, error) : null,
        h('section', { style: S.box },
          h('h3', { style: S.heading }, '初始人格'),
          h('p', { style: S.meta }, '保存只更新初始人格。只有明确点击「重设现行人格」，才可以将已保存的初始人格重设为此刻的人格'),
          h('textarea', { 'aria-label': '初始人格', style: S.textarea, spellCheck: false, value: draft, disabled: baseline === null, onChange: (e) => { setDraft(e.target.value); dirtyRef.current = e.target.value !== baseline; setNotice(''); } }),
          status && dirty && String(status.initialPersona ?? '') !== baseline ? h('p', { style: S.meta }, '已保存的初始人格在别处发生了变化；你的草稿仍保留，保存会更新初始人格。') : null,
          h('div', { style: S.row },
            h('button', { type: 'button', style: S.primary, disabled: !status || !!busy || !dirty, onClick: () => run('save-initial') }, busy === 'save-initial' ? '保存中…' : '保存初始人格'),
            h('button', { type: 'button', style: S.button, disabled: !status || !!busy || dirty, onClick: () => run('reset') }, busy === 'reset' ? '重设中…' : '重设现行人格'),
            dirty ? h('span', { style: S.meta }, '有未保存的草稿；请先保存再重设。') : null)),
        actionError ? h('div', { role: 'alert', style: S.error }, actionError) : null,
        notice ? h('p', { role: 'status', style: S.meta }, notice) : null,
        h(Fold, { title: '人格历史' },
          history.map((v, i) => h('details', { key: String(v.version ?? i), style: S.details },
            h('summary', { style: S.summary }, 'v' + (v.version ?? '?') + ' · ' + fmtTime(v.at) + ' · ' + (v.author ?? '')),
            h('pre', { style: S.text }, v.text ?? v.preview ?? '此条状态未提供原文。'),
            v.reason ? h('p', { style: S.meta }, '原因：' + v.reason) : null,
            v.basis ? h('p', { style: S.meta }, '依据：' + v.basis) : null))),
        h(Fold, { title: '自我认识（' + notes.length + '）' }, notes.length ? notes.map((n, i) => h('div', { key: n.id ?? i, style: S.box },
          h('pre', { style: S.text }, n.statement ?? ''),
          h('p', { style: S.meta }, '状态：' + (n.state ?? '未知') + ' · 置信度：' + (n.confidence ?? '未知')),
          n.basis ? h('p', { style: S.meta }, '依据：' + n.basis) : null,
          (n.wouldDoubt ?? n.would_doubt) ? h('p', { style: S.meta }, '会让我怀疑它的是：' + (n.wouldDoubt ?? n.would_doubt)) : null,
          n.counter ? h('p', { style: S.meta }, '反例：' + n.counter) : null)) : h('p', { style: S.meta }, '尚无自我认识。')),
        h(Fold, { title: '技术诊断' }, h('pre', { style: { ...S.text, fontSize: '12px' } }, JSON.stringify(status ? {
          identityId: status.identityId, dbFile: status.dbFile, stats: status.stats, decay: status.decay,
          features: status.features, seedRevision: status.seed?.revision, summaryKind: summary?.kind, bootLog: status.bootLog,
        } : { error: error || '尚未读取状态' }, null, 2))));
    }
    const BOOL_FIELDS = [
      ['recordEnabled', '记录经历'], ['injectEnabled', '注入回忆'],
      ['personaEvolutionEnabled', '允许人格演变'], ['selfNotesEnabled', '维护自我认识'],
      ['summaryEnabled', '定期生成只读人格总结'],
    ];
    const NUM_FIELDS = [
      ['injectCapChars', '每轮注入字符上限', 120, 4000, 1], ['injectLimit', '每轮经历条数上限', 1, 12, 1],
      ['halfLifeDays', '记忆半衰期（天）', 1, 3650, 1], ['minActivation', '最低激活强度', 0, 1, 0.01],
      ['selfNoteCap', '自我认识上限', 1, 200, 1], ['coreCap', 'core 上限', 1, 200, 1],
    ];
    function PluginSettings(props) {
      const form = props?.form ?? null;
      const [snapshot, setSnapshot] = react.useState(() => form?.getSnapshot?.() ?? null);
      const [error, setError] = react.useState('');
      const [pending, setPending] = react.useState('');
      const [saved, setSaved] = react.useState('');
      const saving = react.useRef(false);
      const alive = react.useRef(true);
      react.useEffect(() => {
        alive.current = true;
        if (!form) return () => { alive.current = false; };
        const update = () => { try { setSnapshot(form.getSnapshot()); } catch (e) { setError(message(e)); } };
        update();
        const off = form.subscribe(update);
        return () => { alive.current = false; off?.(); };
      }, [form]);
      const value = snapshot?.value ?? {};
      const disabled = !form || snapshot?.status !== 'ready' || snapshot?.writable !== true || !!pending;
      const write = async (field, next) => {
        if (saving.current || disabled) return;
        saving.current = true; setPending(field); setError(''); setSaved('');
        try {
          const ok = await form.mutate([{ op: 'set', path: [field], value: next }], form.getSnapshot().revision);
          if (ok !== true) throw new Error('宿主未确认保存：' + field);
          if (alive.current) { setSnapshot(form.getSnapshot()); setSaved('设置已保存。'); }
        } catch (e) { if (alive.current) setError('保存失败：' + message(e)); }
        finally { saving.current = false; if (alive.current) setPending(''); }
      };
      const number = ([field, label, min, max, step]) => h('label', { style: S.row, key: field },
        h('span', null, label), h('input', { 'aria-label': label, style: S.input, type: 'number', min, max, step,
          value: value[field] ?? '', disabled,
          onChange: (e) => { const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n) && n >= min && n <= max && (step !== 1 || Number.isInteger(n))) write(field, n); } }));
      // 分支在 hooks 之后；插件折叠摘要不触碰人格 API。
      if (props?.view === 'summary') return h('span', { style: S.meta }, '经历记录、回忆注入、人格演变与只读定期总结');
      if (!form) return h('p', { role: 'alert', style: S.error }, '宿主未提供插件设置表单；无法保存设置。');
      return h('div', { style: S.compact },
        h('p', { style: S.meta }, '人格阅读与初始人格编辑在设置侧栏的「人格」窗口；这里仅配置功能。'),
        BOOL_FIELDS.map(([field, label]) => h('label', { key: field, style: S.row }, h('input', { type: 'checkbox', checked: value[field] !== false, disabled, onChange: (e) => write(field, e.target.checked) }), h('span', null, label))),
        number(['summaryIntervalHours', '总结间隔（小时）', 1, 720, 1]),
        h(Fold, { title: '高级：预算与记忆参数' }, h('div', { style: S.compact }, NUM_FIELDS.map(number))),
        pending ? h('p', { role: 'status', style: S.meta }, '正在保存…') : null,
        error ? h('p', { role: 'alert', style: S.error }, error) : null,
        saved ? h('p', { role: 'status', style: S.meta }, saved) : null);
    }
    function apply(ctx) {
      const register = (slot, options, component) => {
        try {
          ctx.slots.inject(slot, () => {
            try { return ctx.slots.register({ name: slot, ...options }, component); }
            catch (e) { ctx.logger?.warn?.('dsh-soul: 插槽注册失败：' + message(e)); return () => {}; }
          });
        } catch (e) { ctx.logger?.warn?.('dsh-soul: 插槽注入失败：' + message(e)); }
      };
      register('settings.section', { id: ENTRY_ID, order: 152, label: () => '人格' }, PersonaWindow);
      const form = ctx.configForms?.get(ENTRY_ID);
      const settingsOptions = { inject: () => ({ form }) };
      register('plugins.bundle.config', { key: ENTRY_ID, ...settingsOptions }, PluginSettings);
      register('plugins.row.config', { key: ENTRY_ID + '#' + ENTRY_ID, ...settingsOptions }, PluginSettings);
    }
    exports.inject = ['slots', 'configForms'];
    exports.apply = apply;
    exports.PersonaWindow = PersonaWindow;
    exports.PluginSettings = PluginSettings;
    exports.SoulSettingsCard = PersonaWindow;
    return module.exports;
  },
});
