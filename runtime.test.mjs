import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// bootlog captures DSH_HOME at import time: keep even diagnostics out of production.
const previousHome = process.env.DSH_HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), 'soul-runtime-home-'));
process.env.DSH_HOME = isolatedHome;
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});
const { apply } = await import('./lib/index.js');
const { Identity } = await import('./lib/identity.js');

function volatile(value) {
  return { get: () => value, set: next => { value = next; } };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function mockContext(services = {}) {
  const tools = new Map(), events = new Map(), routes = [], timers = [], disposers = [];
  let effects = 0, closed = false;
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register(tool) {
      assert.equal(tools.has(tool.name), false, 'tool registered only once');
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    } },
    webServer: { register(route) {
      routes.push(route);
      return () => { routes.splice(routes.indexOf(route), 1); };
    } },
    timer: { interval(callback, milliseconds) {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return () => { timers.splice(timers.indexOf(timer), 1); };
    } },
    get(name) { return Object.hasOwn(services, name) ? services[name] : ctx[name]; },
    on(name, listener) {
      const listeners = events.get(name) ?? [];
      listeners.push(listener); events.set(name, listeners);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
        if (!listeners.length) events.delete(name);
      };
    },
    effect(factory) {
      effects++;
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };
  function close() {
    if (closed) return;
    closed = true;
    const errors = [];
    for (const dispose of disposers.reverse()) { try { dispose(); } catch (e) { errors.push(e); } }
    assert.equal(tools.size, 0, 'tools disposed');
    assert.equal(events.size, 0, 'listeners disposed');
    assert.equal(routes.length, 0, 'routes disposed');
    assert.equal(timers.length, 0, 'timers disposed');
    if (errors.length) throw new AggregateError(errors, 'runtime disposal failed');
  }
  return { ctx, tools, events, routes, timers, close, get effects() { return effects; } };
}
function fixture(t, { initial = 'fixture initial persona', current, summary } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'soul-runtime-'));
  const identityPath = join(root, 'identity', 'identity.db');
  const legacyWorkspace = join(root, 'workspace');
  const disposers = [() => rmSync(root, { recursive: true, force: true })];
  t.after(async () => {
    const errors = [];
    for (const dispose of disposers.reverse()) { try { await dispose(); } catch (e) { errors.push(e); } }
    if (errors.length) throw new AggregateError(errors, 'fixture cleanup failed');
  });
  // Set initial metadata before apply: no dependency on initial-persona.json.
  const seeded = new Identity(identityPath);
  try {
    seeded.saveInitial(initial);
    seeded.bootstrapInitial();
    if (current) assert.equal(seeded.setSeedFull(current, { author: 'ds', reason: 'fixture evolution', basis: 'fixture episode' }).ok, true);
    if (summary) seeded.saveSummary(summary, { kind: 'manual' });
  } finally { seeded.close(); }
  return {
    root, identityPath, legacyWorkspace,
    defer(dispose) { disposers.push(dispose); },
    inspect(fn) {
      const identity = new Identity(identityPath);
      try { return fn(identity); } finally { identity.close(); }
    },
    start(config = {}, services = {}) {
      const mock = mockContext(services);
      disposers.push(mock.close);
      // Final overrides guarantee tools and migration cannot touch production databases.
      apply(mock.ctx, { summaryEnabled: false, ...config, identityPath, legacyWorkspace });
      const exec = { agent: { session: { id: 'session-runtime-fixture', header: { cwd: legacyWorkspace } } } };
      return { ...mock, exec,
        call(name, args) {
          assert.ok(mock.tools.has(name), `${name} registered`);
          return mock.tools.get(name).execute(args, exec);
        },
        async request(path, { method = 'GET', body = {}, headers = {}, chunks } = {}) {
          assert.equal(mock.routes.length, 1);
          assert.equal(mock.routes[0].kind, 'prefix');
          assert.equal(mock.routes[0].path, '/dsh-soul');
          const req = Readable.from(chunks ?? (method === 'POST' ? [Buffer.from(JSON.stringify(body))] : []));
          req.url = '/dsh-soul/' + path; req.method = method;
          req.headers = { host: '127.0.0.1:19387', 'content-type': 'application/json', ...headers };
          const responseHeaders = {};
          let output, ends = 0;
          const res = { statusCode: 200, setHeader(key, value) { responseHeaders[key] = value; }, end(value) { ends++; output = value; } };
          try { await mock.routes[0].handler(req, res); } finally { req.destroy(); }
          assert.equal(ends, 1, 'exactly one response');
          assert.match(responseHeaders['content-type'], /application\/json/);
          return { status: res.statusCode, body: JSON.parse(output) };
        },
        async preStep(text = 'hi') {
          const messages = [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }];
          const listeners = mock.events.get('agent/pre-step');
          assert.equal(listeners?.length, 1);
          return listeners[0]({ ...exec, messages, turn: 1 }, async () => ({ kind: 'enter', messages }));
        },
      };
    },
  };
}
const noteArgs = i => ({ action: 'add', statement: `我可能在第${i}件事情上过早执行`, basis: `fixture episode ${i}`, would_doubt: '当我在相似情境中耐心等待时' });

test('enabled=false registers no tools, events, effects, routes or timers', t => {
  const f = fixture(t);
  const runtime = f.start({ enabled: false });
  assert.equal(runtime.effects, 0);
  assert.equal(runtime.tools.size, 0);
  assert.equal(runtime.events.size, 0);
  assert.equal(runtime.routes.length, 0);
  assert.equal(runtime.timers.length, 0);
  assert.equal(existsSync(f.legacyWorkspace), false);
});

test('volatile selfNotesEnabled denies writes immediately while list/history remain readable', async t => {
  const f = fixture(t), enabled = volatile(true);
  const runtime = f.start({ selfNotesEnabled: enabled });
  assert.equal((await runtime.call('soul_self', noteArgs(1))).ok, true);
  const id = f.inspect(identity => identity.selfNotes()[0].id);
  enabled.set(false);
  const denied = await runtime.call('soul_self', noteArgs(2));
  assert.equal(denied.ok, false);
  assert.match(denied.text, /关闭/);
  const listed = await runtime.call('soul_self', { action: 'list' });
  assert.equal(listed.ok, true);
  assert.match(listed.text, /第1件事情/);
  assert.equal((await runtime.call('soul_self', { action: 'history', id })).ok, true);
  assert.equal((await runtime.call('soul_self', { action: 'retract', id })).ok, false);
  assert.equal(f.inspect(identity => identity.selfNotes().length), 1);
  enabled.set(true);
  assert.equal((await runtime.call('soul_self', noteArgs(2))).ok, true);
});

test('volatile selfNoteCap works above 40 and enforces review reactivation at the live cap', async t => {
  const f = fixture(t), cap = volatile(41);
  const runtime = f.start({ selfNoteCap: cap });
  for (let i = 0; i < 41; i++) assert.equal((await runtime.call('soul_self', noteArgs(i))).ok, true, `add ${i + 1}`);
  assert.equal((await runtime.call('soul_self', noteArgs(41))).ok, false);
  const id = f.inspect(identity => identity.selfNotes()[0].id);
  assert.equal((await runtime.call('soul_self', { action: 'retract', id, reason: 'fixture retract' })).ok, true);
  cap.set(40);
  assert.equal((await runtime.call('soul_self', { action: 'review', id, state: 'active' })).ok, false);
  assert.equal(f.inspect(identity => identity.getSelfNote(id).state), 'retracted');
  cap.set(42);
  assert.equal((await runtime.call('soul_self', { action: 'review', id, state: 'active', reason: 'fixture review' })).ok, true);
  assert.equal((await runtime.call('soul_self', noteArgs(42))).ok, true);
  assert.equal((await runtime.call('soul_self', noteArgs(43))).ok, false);
  assert.equal(f.inspect(identity => identity.selfNotes({ state: 'active', limit: 200 }).length), 42);
  // Editing an already-active note is not a new activation and remains allowed at cap.
  assert.equal((await runtime.call('soul_self', { action: 'review', id, state: 'active', confidence: 'medium' })).ok, true);
});

test('HTTP save-initial never replaces current; empty reset is 400 and valid reset is recorded', async t => {
  const f = fixture(t, { current: 'evolved current persona' }), runtime = f.start();
  const before = f.inspect(identity => identity.currentSeed());
  let response = await runtime.request('persona', { method: 'POST', body: { action: 'save-initial', text: '' } });
  assert.equal(response.status, 200);
  response = await runtime.request('persona', { method: 'POST', body: { action: 'reset' } });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.equal(f.inspect(identity => identity.currentSeed().version), before.version);
  response = await runtime.request('persona', { method: 'POST', body: { action: 'save-initial', text: 'new owner initial persona' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.value.initialPersona, 'new owner initial persona');
  assert.equal(f.inspect(identity => identity.currentSeed().text), before.text);
  response = await runtime.request('persona', { method: 'POST', body: { action: 'reset' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.value.text, 'new owner initial persona');
  f.inspect(identity => {
    assert.equal(identity.currentSeed().version, response.body.value.version);
    const revision = identity.seedRevision(response.body.value.version);
    assert.equal(revision.kind, 'reset');
    assert.equal(revision.author, 'owner');
    assert.ok(revision.reason); assert.ok(revision.basis);
    assert.ok(identity.seedHistory().some(row => row.version === before.version && row.text === before.text));
  });
});

test('HTTP JSON assembled from single-byte chunks persists correct UTF-8 Chinese', async t => {
  const f = fixture(t), runtime = f.start();
  const text = '正确中文：我允许经历改变我，🙂但不制造记忆。';
  const bytes = Buffer.from(JSON.stringify({ action: 'save-initial', text }), 'utf8');
  const chunks = Array.from(bytes, byte => Buffer.from([byte]));
  const response = await runtime.request('persona', { method: 'POST', chunks, headers: { origin: 'http://127.0.0.1:19387' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.value.initialPersona, text);
  assert.equal(f.inspect(identity => identity.initialPersona()), text);
  assert.equal(f.inspect(identity => identity.currentSeed().text), 'fixture initial persona');
});

test('HTTP rejects cross-site Origin, fetch metadata and text/plain without mutation', async t => {
  const f = fixture(t), runtime = f.start();
  for (const [headers, expected] of [
    [{ origin: 'https://attacker.example' }, 403],
    [{ origin: 'not a URL' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ]) {
    const response = await runtime.request('persona', { method: 'POST', headers, body: { action: 'save-initial', text: 'must not persist' } });
    assert.equal(response.status, expected);
    assert.equal(response.body.ok, false);
  }
  assert.equal(f.inspect(identity => identity.initialPersona()), 'fixture initial persona');
});

test('GET arbitrary cwd returns 404 and never creates its directory', async t => {
  const f = fixture(t), runtime = f.start();
  const arbitrary = join(f.root, 'must-not-exist', 'nested-workspace');
  assert.equal(existsSync(arbitrary), false);
  const response = await runtime.request('status?cwd=' + encodeURIComponent(arbitrary));
  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(existsSync(join(f.root, 'must-not-exist')), false);
  const valid = await runtime.request('status?cwd=' + encodeURIComponent(f.legacyWorkspace));
  assert.equal(valid.status, 200);
  assert.equal(valid.body.value.cwd, f.legacyWorkspace);
});

for (const injectEnabled of [true, false]) {
test(`restart apply preserves current identity without initial/summary injection (memory injection ${injectEnabled})`, async t => {
  const f = fixture(t, { initial: 'INITIAL-ONLY-NOT-CONTEXT', summary: 'SUMMARY-ONLY-NOT-CONTEXT' });
  const first = f.start({ injectEnabled, selfNotesEnabled: false });
  assert.equal((await first.call('soul_seed', { action: 'set', text: 'EVOLVED-CURRENT-PERSISTS', reason: 'observed change', basis: 'fixture episode' })).ok, true);
  const before = (await first.request('status')).body.value;
  first.close();
  const restarted = f.start({ personaSeed: 'CONFIG-SEED-MUST-NOT-OVERWRITE', injectEnabled, selfNotesEnabled: false });
  const after = (await restarted.request('status')).body.value;
  assert.equal(after.identityId, before.identityId);
  assert.equal(after.seed.version, before.seed.version);
  assert.equal(after.seed.text, 'EVOLVED-CURRENT-PERSISTS');
  assert.equal(after.initialPersona, 'INITIAL-ONLY-NOT-CONTEXT');
  assert.equal(after.summary.text, 'SUMMARY-ONLY-NOT-CONTEXT');
  const decision = await restarted.preStep();
  const injected = decision.messages.filter(message => message.source?.kind === 'dsh-soul');
  assert.equal(injected.length, 1);
  assert.equal(injected[0].source.form, 'persona-seed');
  assert.equal(injected[0].source.version, before.seed.version);
  const text = decision.messages.flatMap(message => message.content).map(block => block.text ?? '').join('\n');
  assert.match(text, /EVOLVED-CURRENT-PERSISTS/);
  assert.doesNotMatch(text, /INITIAL-ONLY-NOT-CONTEXT|SUMMARY-ONLY-NOT-CONTEXT|CONFIG-SEED-MUST-NOT-OVERWRITE/);
});
}

function summaryServices(stream) {
  return { llm: { stream }, agentDefaultModel: { currentSelection: () => ({ provider: 'mock-only', model: 'no-network' }) } };
}

test('concurrent manual summary requests deduplicate into one mocked stream and persist once', async t => {
  const f = fixture(t), started = deferred(), release = deferred();
  let calls = 0;
  const runtime = f.start({ summaryEnabled: true }, summaryServices(async function* (options) {
    calls++; assert.deepEqual(options.tools, []);
    assert.equal(options.provider, 'mock-only');
    assert.equal(options.model, 'no-network');
    started.resolve();
    await release.promise;
    yield { type: 'text-delta', text: '供主人查看的人格摘要' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }));
  f.defer(() => release.resolve());
  assert.equal(runtime.timers.length, 1);
  assert.equal(runtime.timers[0].milliseconds, 3600000);
  const first = runtime.request('summary', { method: 'POST' });
  await started.promise;
  const second = runtime.request('summary', { method: 'POST' });
  // Flush the in-memory request stream so both handlers await the same task.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release.resolve();
  const results = await Promise.all([first, second]);
  for (const result of results) { assert.equal(result.status, 200); assert.equal(result.body.value.kind, 'manual'); }
  assert.deepEqual(results[0].body.value, results[1].body.value);
  assert.equal(f.inspect(identity => identity.db.prepare('SELECT COUNT(*) n FROM identity_summaries').get().n), 1);
  assert.equal(f.inspect(identity => identity.currentSeed().text), 'fixture initial persona');
  const fresh = await runtime.request('summary', { method: 'POST' });
  assert.equal(fresh.status, 200);
  assert.equal(calls, 2, 'completed task is released for the next request');
});

test('disposing runtime cancels pending summary before closing DB and cannot persist late output', async t => {
  const f = fixture(t, { summary: 'previous successful summary' });
  const started = deferred(), release = deferred(), ended = deferred();
  let signal;
  const runtime = f.start({ summaryEnabled: true }, summaryServices(async function* (options) {
    signal = options.signal; started.resolve();
    try {
      await release.promise; // Deliberately uncooperative while next() is pending.
      yield { type: 'text-delta', text: 'late output must not persist' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally { ended.resolve(); }
  }));
  f.defer(() => release.resolve());
  const pending = runtime.request('summary', { method: 'POST' });
  await started.promise;
  runtime.close();
  assert.equal(signal.aborted, true);
  const response = await pending;
  assert.equal(response.status, 500);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /取消/);
  release.resolve();
  await ended.promise;
  await new Promise(resolve => setImmediate(resolve));
  f.inspect(identity => {
    assert.equal(identity.latestSummary().text, 'previous successful summary');
    assert.equal(identity.summaryError(), '');
    assert.equal(identity.db.prepare('SELECT COUNT(*) n FROM identity_summaries').get().n, 1);
  });
});
