'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/server-harness');

function seedPrivateContent(h) {
  h.evaluate(`
    DB.members[0].pinSalt = 'PRIVATE_SALT';
    DB.members[0].pinHash = 'PRIVATE_HASH';
    DB.tasks.push({
      id: 'task-secret', title: 'SECRET_TASK', status: 'doing', assigneeId: 'user',
      comments: [], attachments: [{ name: 'SECRET_FILE', dataUrl: 'data:text/plain;base64,U0VDUkVU' }],
      doc: { versions: [{ content: 'SECRET_DOCUMENT' }], comments: [] }
    });
    DB.resources.push({ id: 'resource-secret', name: 'SECRET_RESOURCE', dataUrl: 'data:text/plain;base64,U0VDUkVU' });
    DB.announcements.push({ id: 'ann-secret', title: 'SECRET_ANNOUNCEMENT' });
    DB.literatures.push({ id: 'lit-secret', title: 'SECRET_LITERATURE', votes: {}, comments: [] });
    DB.reviews.push({ id: 'review-secret', taskId: 'task-secret', content: 'SECRET_REVIEW' });
  `);
}

function bootstrap(h, token) {
  return h.request({ pathname: '/api/bootstrap', method: 'GET', token });
}

test('匿名 bootstrap 只返回登录摘要，不包含任何业务内容或 PIN 哈希', async () => {
  const h = createHarness();
  h.reset();
  seedPrivateContent(h);

  const result = await bootstrap(h);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.authenticated, false);
  assert.equal(result.payload.state.members.length, 2);
  assert.equal(result.payload.state.members[0].pinBound, true);
  for (const key of ['tasks', 'resources', 'announcements', 'literatures', 'reviews', 'dismissed', 'sessions']) {
    assert.equal(Object.hasOwn(result.payload.state, key), false, key);
  }
  const serialized = JSON.stringify(result.payload.state);
  assert.doesNotMatch(serialized, /SECRET_|PRIVATE_/);
});

test('有效会话可取得完整工作状态，但仍不暴露 PIN 和会话表', async () => {
  const h = createHarness();
  h.reset();
  seedPrivateContent(h);

  const result = await bootstrap(h, 'user-token');
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.authenticated, true);
  assert.equal(result.payload.state.tasks.length, 1);
  assert.equal(result.payload.state.tasks[0].title, 'SECRET_TASK');
  assert.equal(result.payload.state.resources.length, 1);
  assert.equal(Object.hasOwn(result.payload.state, 'sessions'), false);
  assert.equal(Object.hasOwn(result.payload.state.members[0], 'pinHash'), false);
  assert.equal(Object.hasOwn(result.payload.state.members[0], 'pinSalt'), false);
});

test('无效会话不能读取私有工作状态', async () => {
  const h = createHarness();
  h.reset();
  seedPrivateContent(h);

  const result = await bootstrap(h, 'invalid-token');
  assert.equal(result.payload.authenticated, false);
  assert.equal(Object.hasOwn(result.payload.state, 'tasks'), false);
  assert.doesNotMatch(JSON.stringify(result.payload.state), /SECRET_|PRIVATE_/);
});

test('初始化缺少或提供错误密钥时拒绝写入', async () => {
  for (const setupKey of [undefined, 'wrong-key']) {
    const h = createHarness();
    h.reset();
    h.evaluate(`DB.setupDone = false; DB.members = []; DB.sessions = {};`);
    const result = await h.request({
      pathname: '/api/setup',
      body: { members: [{ name: 'Admin', admin: true }], settings: {}, setupKey }
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.payload.error, '初始化密钥不正确');
    assert.equal(h.evaluate('DB.setupDone'), false);
    assert.equal(h.evaluate('DB.members.length'), 0);
  }
});

test('正确初始化密钥只能成功初始化一次', async () => {
  const h = createHarness();
  h.reset();
  h.evaluate(`DB.setupDone = false; DB.members = []; DB.sessions = {};`);
  const setupKey = h.evaluate('SETUP_KEY');
  const body = {
    members: [{ name: 'Admin', admin: true }],
    settings: { title: 'Private workbench' },
    setupKey
  };

  const first = await h.request({ pathname: '/api/setup', body });
  assert.equal(first.statusCode, 200);
  assert.equal(h.evaluate('DB.setupDone'), true);
  assert.equal(h.evaluate('DB.members.length'), 1);
  assert.equal(h.evaluate('DB.members[0].isAdmin'), true);

  const second = await h.request({ pathname: '/api/setup', body });
  assert.equal(second.statusCode, 403);
  assert.equal(second.payload.error, '工作台已初始化过，不能重复初始化');
  assert.equal(h.evaluate('DB.members.length'), 1);
});
