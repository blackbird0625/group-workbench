'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/server-harness');

const STATUSES = ['unclaimed', 'doing', 'review', 'rework', 'done'];
const LEGAL = new Set([
  'unclaimed>doing',
  'doing>review',
  'review>rework',
  'review>done',
  'rework>doing'
]);

function seedTask(h, status, assigneeId = 'user', withDelivery = true) {
  h.evaluate(`DB.tasks = [{
    id: 'task-1', title: 'Task', desc: '', line: 'other', ddl: '',
    assigneeId: ${JSON.stringify(assigneeId)}, status: ${JSON.stringify(status)},
    order: 1, createdAt: 1, updatedAt: 1, comments: [], attachments: [],
    doc: { versions: ${withDelivery ? "[{ id: 'v1', content: 'delivery' }]" : '[]'}, comments: [] }
  }]`);
}

function changeStatus(h, token, status, note) {
  return h.request({
    token,
    pathname: '/api/tasks/task-1/status',
    body: { status, ...(note === undefined ? {} : { note }) }
  });
}

test('五条合法状态流转均可完成，认领时自动写入负责人', async () => {
  const cases = [
    { from: 'unclaimed', to: 'doing', token: 'user-token' },
    { from: 'doing', to: 'review', token: 'user-token' },
    { from: 'review', to: 'rework', token: 'admin-token', note: '需要修改' },
    { from: 'rework', to: 'doing', token: 'user-token' },
    { from: 'review', to: 'done', token: 'admin-token' }
  ];

  for (const c of cases) {
    const h = createHarness();
    h.reset();
    seedTask(h, c.from, c.from === 'unclaimed' ? null : 'user');
    const result = await changeStatus(h, c.token, c.to, c.note);
    assert.equal(result.statusCode, 200, `${c.from} → ${c.to}`);
    assert.equal(result.payload.task.status, c.to);
    if (c.from === 'unclaimed') assert.equal(result.payload.task.assigneeId, 'user');
  }
});

test('其余十五种跨状态跳转全部被拒绝且原状态不变', async () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from === to || LEGAL.has(`${from}>${to}`)) continue;
      const h = createHarness();
      h.reset();
      seedTask(h, from);
      const result = await changeStatus(h, 'admin-token', to, '返工说明');
      assert.equal(result.statusCode, 400, `${from} → ${to}`);
      assert.equal(h.evaluate('DB.tasks[0].status'), from);
    }
  }
});

test('未知状态、重复状态和退回待认领均被拒绝', async () => {
  const h = createHarness();
  h.reset();
  seedTask(h, 'doing');

  assert.equal((await changeStatus(h, 'admin-token', 'archived')).statusCode, 400);
  assert.equal((await changeStatus(h, 'admin-token', 'doing')).statusCode, 400);
  assert.equal((await changeStatus(h, 'admin-token', 'unclaimed')).statusCode, 400);
  assert.equal(h.evaluate('DB.tasks[0].status'), 'doing');
});

test('提交审核必须先有附件或文档版本', async () => {
  const h = createHarness();
  h.reset();
  seedTask(h, 'doing', 'user', false);

  const result = await changeStatus(h, 'user-token', 'review');
  assert.equal(result.statusCode, 400);
  assert.match(result.payload.error, /需先上传附件或完成交付文档/);
  assert.equal(h.evaluate('DB.tasks[0].status'), 'doing');
});

test('非负责人不能提交审核或从返工恢复，普通成员不能验收', async () => {
  const h = createHarness();
  h.reset();
  h.evaluate(`
    DB.members.push({ id: 'other', name: 'Other', role: '组员', isAdmin: false });
    DB.sessions['other-token'] = { memberId: 'other', ts: 1 };
  `);

  seedTask(h, 'doing');
  assert.equal((await changeStatus(h, 'other-token', 'review')).statusCode, 403);

  seedTask(h, 'rework');
  assert.equal((await changeStatus(h, 'other-token', 'doing')).statusCode, 403);

  seedTask(h, 'review');
  assert.equal((await changeStatus(h, 'user-token', 'rework', '返工')).statusCode, 403);
  assert.equal((await changeStatus(h, 'user-token', 'done')).statusCode, 403);
});

test('返工意见必填，失败时不会写入评论或改变状态', async () => {
  const h = createHarness();
  h.reset();
  seedTask(h, 'review');

  const result = await changeStatus(h, 'admin-token', 'rework', '   ');
  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.error, '返工意见必填');
  assert.equal(h.evaluate('DB.tasks[0].status'), 'review');
  assert.equal(h.evaluate('DB.tasks[0].comments.length'), 0);
});
