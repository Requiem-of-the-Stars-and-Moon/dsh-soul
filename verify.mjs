import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gate } from './lib/gate.js';
import { Store } from './lib/store.js';
import { Identity } from './lib/identity.js';
import { apply } from './lib/index.js';
const dir = mkdtempSync(join(tmpdir(), 'soul-verify-'));
const cleanups = [];
try {
  const s = new Store(join(dir, '.dsh-soul', 'memory.db'));
  const g = new Gate({ store: s, session: 'test', workspace: dir });
  g.observeTool('read', { file_path: 'a' }, false, 'missing');
  g.observeTool('read', { file_path: 'a' }, true);
  g.observeTool('read', { file_path: 'a' }, false, 'missing again');
  g.observeTool('read', { file_path: 'a' }, true);
  const failures = g.drain().filter(c => c.signal === 'toolfail');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].base_strength, 0.2);
  assert.equal(failures[0].half_life_days, 7);
  g.observeTool('read', { file_path: 'a/b' }, false, 'missing');
  g.observeTool('read', { file_path: 'ab' }, true);
  assert.equal(g.drain().length, 0, 'distinct paths must not pair');
  s.close();
  const identity = new Identity(join(dir, 'identity.db'));
  identity.bootstrapInitial('初始人格 A');
  identity.setSeedFull('她仍是同一个 ds。', { author: 'ds', reason: '验证跨空间连续性', basis: 'test' });
  const hooks = new Map(), tools = new Map();
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) { return name === 'tools' ? { register(t) { tools.set(t.name, t); return () => {}; } } : undefined; },
    on(name, fn) { hooks.set(name, fn); return () => {}; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose); },
  };
  const toggles = { personaEvolutionEnabled: true };
  apply(ctx, { identityPath: identity.file, legacyWorkspace: dir, summaryEnabled: false, personaEvolutionEnabled: { get: () => toggles.personaEvolutionEnabled } });
  cleanups.unshift(() => identity.close());
  const agent = { session: { id: 'session-test', header: { cwd: dir } } };
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '嗨' }] }];
  const enter = () => Promise.resolve({ kind: 'enter', messages });
  const pre = hooks.get('agent/pre-step');
  const first = await pre({ agent }, enter);
  const seed = first.messages.find(m => m.source?.form === 'persona-seed');
  assert.ok(seed.content[0].text.endsWith('她仍是同一个 ds。'));
  assert.ok(!seed.content[0].text.includes('初始人格 A'));
  const second = await pre({ agent }, () => Promise.resolve(first));
  assert.equal(second.messages.filter(m => m.source?.form === 'persona-seed').length, 1);
  const other = { session: { id: 'session-other', header: { cwd: join(dir, 'other') } } };
  const third = await pre({ agent: other }, enter);
  assert.equal(third.messages.find(m => m.source?.form === 'persona-seed').content[0].text, seed.content[0].text);
  const changed = await tools.get('soul_seed').execute({ action: 'set', text: '修订后的人格 B', reason: '发生了新经历', basis: '测试事件' }, { agent: other });
  assert.equal(changed.ok, true);
  assert.equal(identity.currentSeed().text, '修订后的人格 B');
  identity.saveInitial('新的初始人格 C');
  assert.equal(identity.currentSeed().text, '修订后的人格 B');
  toggles.personaEvolutionEnabled = false;
  assert.equal((await tools.get('soul_seed').execute({ action: 'set', text: '不应生效', reason: '测试', basis: '测试' }, { agent })).ok, false);
  assert.equal(identity.currentSeed().text, '修订后的人格 B');
  assert.equal((await tools.get('soul_seed').execute({ action: 'accept', version: 2 }, { agent })).ok, false);
  assert.equal((await tools.get('soul_core').execute({ action: 'accept', id: 'x' }, { agent })).ok, false);
  const check = new Store(join(dir, '.dsh-soul', 'memory.db'));
  assert.equal(check.currentSeed(), null);
  check.close();
  console.log('PASS: gate dedup, repeated identity injection, cross-session/workspace identity, autonomous revision, live toggle, initial/current separation, core governance, local isolation');
} finally {
  for (const dispose of cleanups.reverse()) dispose();
  rmSync(dir, { recursive: true, force: true });
}
