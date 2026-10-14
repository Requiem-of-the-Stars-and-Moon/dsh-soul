import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './lib/store.js';
import { Identity, identityPath, generateSummary } from './lib/identity.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'soul-identity-'));
  const opened = [];
  t.after(() => { opened.forEach(s => s.close()); rmSync(dir, { recursive: true, force: true }); });
  return { dir, open: (Type, name) => { const s = new Type(join(dir, name, '.dsh-soul', 'memory.db')); opened.push(s); return s; } };
}
test('stable shared identity; save initial does not replace current; reset retains history and reset metadata', t => {
  const f = fixture(t), identity = f.open(Identity, 'global');
  assert.equal(identityPath({ identityPath: '/custom/identity.db' }), '/custom/identity.db');
  identity.saveInitial('owner initial');
  identity.bootstrapInitial();
  identity.setSeedFull('ds current', { author: 'ds', reason: 'change', basis: 'episode' });
  identity.saveInitial('new owner initial');
  identity.bootstrapInitial('must not replace');
  assert.equal(identity.currentSeed().text, 'ds current');
  const result = identity.resetPersona();
  assert.equal(identity.currentSeed().text, 'new owner initial');
  assert.equal(identity.seedRevision(result.version).kind, 'reset');
  assert.equal(identity.seedHistory().length, 3);
  const id = identity.identityId;
  const second = new Identity(identity.file);
  assert.equal(second.identityId, id);
  second.close();
});
test('empty initial bootstrap skips seed creation and later explicit initial can bootstrap', t => {
  const f = fixture(t);
  for (const [i, text] of [undefined, '', '  \n '].entries()) {
    const identity = f.open(Identity, `empty-${i}`);
    const writeSeed = t.mock.method(identity, 'setSeedFull');
    assert.deepEqual(identity.bootstrapInitial(text), { ok: true, skipped: true });
    assert.equal(identity.currentSeed(), null);
    assert.equal(identity.seedHistory().length, 0);
    assert.equal(writeSeed.mock.callCount(), 0);
    identity.saveInitial('owner initial');
    assert.equal(identity.bootstrapInitial().ok, true);
    assert.equal(identity.currentSeed().text, 'owner initial');
    assert.equal(identity.seedHistory().length, 1);
  }
});

test('migration preserves full source history and revisions, qualifies basis, skips repeat and never overrides current', t => {
  const f = fixture(t), source = f.open(Store, 'main'), other = f.open(Store, 'other'), identity = f.open(Identity, 'global');
  source.setSeedFull('owner old', { basis: 'e1' });
  source.setSeedFull('ds current', { author: 'ds', reason: 'why', basis: 'e2' });
  const note = source.addSelfNote({ statement: '我可能很快执行', basis: 'e2', wouldDoubt: '当我耐心等待时' });
  source.updateSelfNote(note.id, { basis: 'e3', confidence: 'medium' }, { basis: 'e4', reason: 'review' });
  source.addEpisode({ id: 'e2', body: 'local episode' });
  const result = identity.importWorkspace(source);
  assert.equal(result.seeds, 2);
  assert.equal(result.selfNoteRevisions, 2);
  assert.equal(identity.currentSeed().text, 'ds current');
  assert.match(identity.selfNotes()[0].basis, /\[workspace:.*main\] e3/);
  assert.equal(identity.selfNoteHistory(identity.selfNotes()[0].id).length, 2);
  assert.equal(identity.recent().length, 0);
  assert.equal(source.get('e2').body, 'local episode');
  assert.equal(identity.importWorkspace(source).skipped, true);
  other.setSeedFull('other current');
  identity.importWorkspace(other);
  assert.equal(identity.currentSeed().text, 'ds current');
  assert.equal(identity.seedHistory().length, 3);
  assert.equal(other.currentSeed().text, 'other current');
});
test('migration failure rolls all imported rows and marker back; retry succeeds', t => {
  const f = fixture(t), source = f.open(Store, 'main'), identity = f.open(Identity, 'global');
  source.setSeedFull('source current');
  source.addSelfNote({ statement: '我可能尝试执行', wouldDoubt: '当我不急执行时' });
  identity.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON self_notes BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => identity.importWorkspace(source), /test failure/);
  assert.equal(identity.seedHistory().length, 0);
  assert.equal(identity.db.prepare('SELECT COUNT(*) n FROM identity_imports').get().n, 0);
  identity.db.exec('DROP TRIGGER fail_import');
  assert.equal(identity.importWorkspace(source).ok, true);
});
test('summary is view-only, consumes exact text deltas and preserves last successful summary on errors', async t => {
  const f = fixture(t), identity = f.open(Identity, 'global');
  identity.bootstrapInitial('initial');
  let request;
  const ctx = { get: name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'mock', model: 'model' }) } : {
    stream: async function* (options) { request = options; yield { type: 'reasoning-delta', text: 'hidden' };
      yield { type: 'text-delta', text: 'summary' }; yield { type: 'finish', reason: { kind: 'stop' } }; },
  } };
  const summary = await generateSummary(identity, ctx);
  assert.deepEqual(Object.keys(summary).sort(), ['at','kind','sourceVersion','text']);
  assert.equal(summary.text, 'summary');
  assert.equal(summary.sourceVersion, identity.currentSeed().version);
  assert.deepEqual(request.tools, []);
  assert.equal(request.provider, 'mock');
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(identity.selfNotes().length, 0);
  assert.equal(identity.recent().length, 0);
  assert.equal(identity.seedHistory().length, 1);
  await assert.rejects(generateSummary(identity, { get: () => undefined }), /llm/);
  assert.equal(identity.latestSummary().text, 'summary');
  assert.match(identity.summaryError(), /llm/);
  const errorCtx = { get: name => name === 'llm' ? { stream: async function* () {
    yield { type: 'text-delta', text: 'partial' }; yield { type: 'finish', reason: { kind: 'error', failure: { message: 'bad model' } } };
  } } : { currentSelection: () => ({ provider: 'mock', model: 'model' }) } };
  await assert.rejects(generateSummary(identity, errorCtx), /bad model/);
  assert.equal(identity.latestSummary().text, 'summary');
  const noModel = { get: name => name === 'llm' ? ctx.get('llm') : undefined };
  await assert.rejects(generateSummary(identity, noModel), /未配置可用模型/);
});

function summaryContext(stream) {
  return { get: name => name === 'llm' ? { stream } : {
    currentSelection: () => ({ provider: 'mock', model: 'model' }),
  } };
}

test('pre-aborted or closed summary rejects AbortError without reading services or writing errors', async t => {
  const f = fixture(t), identity = f.open(Identity, 'global');
  const controller = new AbortController();
  const reason = new Error('plugin disposed');
  controller.abort(reason);
  const save = t.mock.method(identity, 'saveSummary');
  const error = t.mock.method(identity, 'setSummaryError');
  const ctx = { get() { assert.fail('cancelled generation must not read services'); } };
  await assert.rejects(generateSummary(identity, ctx, { signal: controller.signal }), e => {
    assert.equal(e.name, 'AbortError'); assert.equal(e.cause, reason); return true;
  });
  identity.close();
  await assert.rejects(generateSummary(identity, ctx), { name: 'AbortError' });
  assert.equal(save.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});

for (const lateFailure of [false, true]) {
  test(`abort then close with pending stream and late ${lateFailure ? 'failure' : 'success'} has no writes or unhandled errors`, async t => {
    const f = fixture(t), identity = f.open(Identity, 'global');
    identity.bootstrapInitial('initial');
    identity.saveSummary('previous');
    identity.setSummaryError('previous error');
    const save = t.mock.method(identity, 'saveSummary');
    const error = t.mock.method(identity, 'setSummaryError');
    const controller = new AbortController();
    const add = t.mock.method(controller.signal, 'addEventListener');
    const remove = t.mock.method(controller.signal, 'removeEventListener');
    const reason = new Error('plugin disposed');
    let release, streamSignal, ended = false;
    const gate = new Promise(resolve => { release = resolve; });
    const unhandled = [];
    const onUnhandled = e => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtExceptionMonitor', onUnhandled);
    t.after(() => {
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtExceptionMonitor', onUnhandled);
    });
    const promise = generateSummary(identity, summaryContext(async function* (options) {
      streamSignal = options.signal;
      try {
        await gate; // Deliberately ignore abort while next() is pending.
        if (lateFailure) throw new Error('late stream failure');
        yield { type: 'text-delta', text: 'late summary' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally { ended = true; }
    }), { signal: controller.signal });
    const rejected = assert.rejects(promise, e => {
      assert.equal(e.name, 'AbortError'); assert.equal(e.cause, reason); return true;
    });
    assert.ok(streamSignal instanceof AbortSignal);
    controller.abort(reason);
    assert.equal(streamSignal.aborted, true);
    assert.equal(streamSignal.reason, reason);
    identity.close();
    await rejected; // Must settle before the uncooperative stream releases.
    assert.equal(ended, false);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ended, true);
    assert.equal(save.mock.callCount(), 0);
    assert.equal(error.mock.callCount(), 0);
    assert.equal(add.mock.callCount(), 1);
    assert.equal(remove.mock.callCount(), 1);
    assert.equal(remove.mock.calls[0].arguments[1], add.mock.calls[0].arguments[1]);
    assert.deepEqual(unhandled, []);
    const reopened = new Identity(identity.file);
    try {
      assert.equal(reopened.latestSummary().text, 'previous');
      assert.equal(reopened.summaryError(), 'previous error');
    } finally { reopened.close(); }
  });
}

test('successful summary detaches external abort listener', async t => {
  const f = fixture(t), identity = f.open(Identity, 'global');
  identity.bootstrapInitial('initial');
  const controller = new AbortController();
  const add = t.mock.method(controller.signal, 'addEventListener');
  const remove = t.mock.method(controller.signal, 'removeEventListener');
  const result = await generateSummary(identity, summaryContext(async function* () {
    yield { type: 'text-delta', text: 'summary' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), { signal: controller.signal });
  assert.equal(result.text, 'summary');
  assert.equal(add.mock.callCount(), 1);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(remove.mock.calls[0].arguments[1], add.mock.calls[0].arguments[1]);
  controller.abort();
  assert.equal(identity.latestSummary().text, 'summary');
  assert.equal(identity.summaryError(), '');
});

test('90 second timeout rejects a pending stream and persists only its timeout error', async t => {
  const f = fixture(t), identity = f.open(Identity, 'global');
  identity.bootstrapInitial('initial');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, streamSignal;
  const gate = new Promise(resolve => { release = resolve; });
  const save = t.mock.method(identity, 'saveSummary');
  const error = t.mock.method(identity, 'setSummaryError');
  const promise = generateSummary(identity, summaryContext(async function* (options) {
    streamSignal = options.signal;
    await gate;
    throw new Error('late timeout stream failure');
  }));
  const rejected = assert.rejects(promise, /人格摘要生成超时（90秒）/);
  t.mock.timers.tick(89999);
  assert.equal(streamSignal.aborted, false);
  assert.equal(error.mock.callCount(), 0);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(streamSignal.aborted, true);
  assert.equal(error.mock.callCount(), 1);
  assert.match(identity.summaryError(), /90秒/);
  identity.close();
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(error.mock.callCount(), 1);
  assert.equal(save.mock.callCount(), 0);
});

test('close during stream without external abort also suppresses summary and error writes', async t => {
  const f = fixture(t), identity = f.open(Identity, 'global');
  identity.bootstrapInitial('initial');
  const save = t.mock.method(identity, 'saveSummary');
  const error = t.mock.method(identity, 'setSummaryError');
  await assert.rejects(generateSummary(identity, summaryContext(async function* () {
    yield { type: 'text-delta', text: 'summary' };
    identity.close();
    yield { type: 'finish', reason: { kind: 'stop' } };
  })), { name: 'AbortError' });
  assert.equal(save.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});
