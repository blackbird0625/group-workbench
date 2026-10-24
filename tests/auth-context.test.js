'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, pause } = require('./helpers/server-harness');

test('慢速普通成员请求不能借用随后进入的管理员身份', async () => {
  const h = createHarness();
  h.reset();

  const ordinary = h.request({
    token: 'user-token',
    body: { title: 'ordinary must fail' },
    delay: 40
  });
  await pause(5);
  const admin = await h.request({
    token: 'admin-token',
    body: { title: 'admin must succeed' }
  });
  const ordinaryResult = await ordinary;

  assert.equal(admin.statusCode, 200);
  assert.equal(ordinaryResult.statusCode, 403);
  assert.equal(ordinaryResult.payload.error, '你没有该操作的权限');
  assert.equal(h.evaluate('DB.tasks.length'), 1);
  assert.equal(h.evaluate('DB.tasks[0].title'), 'admin must succeed');
});

test('并发写操作保留各自的作者身份', async () => {
  const h = createHarness();
  h.reset();
  h.evaluate(`DB.tasks.push({
    id: 'task-1', title: 'Existing task', status: 'doing',
    comments: [], attachments: [], doc: { versions: [], comments: [] }
  })`);

  const review = h.request({
    token: 'user-token',
    pathname: '/api/reviews',
    body: { taskId: 'task-1', content: 'ordinary review' },
    delay: 40
  });
  await pause(5);
  const announcement = await h.request({
    token: 'admin-token',
    pathname: '/api/announcements',
    body: { title: 'admin announcement', body: 'content' }
  });
  const reviewResult = await review;

  assert.equal(reviewResult.statusCode, 200);
  assert.equal(announcement.statusCode, 200);
  assert.equal(reviewResult.payload.review.authorId, 'user');
  assert.equal(reviewResult.payload.review.authorName, 'User');
  assert.equal(announcement.payload.announcement.authorId, 'admin');
  assert.equal(announcement.payload.announcement.authorName, 'Admin');
});

test('未登录请求即使与其他请求交错也返回 401', async () => {
  const h = createHarness();
  h.reset();

  const anonymous = h.request({
    body: { title: 'anonymous must fail' },
    delay: 40
  });
  await pause(5);
  const admin = await h.request({
    token: 'admin-token',
    body: { title: 'only admin task' }
  });
  const anonymousResult = await anonymous;

  assert.equal(admin.statusCode, 200);
  assert.equal(anonymousResult.statusCode, 401);
  assert.equal(h.evaluate('DB.tasks.length'), 1);
});

test('批量并发评论不会发生作者串线', async () => {
  const h = createHarness();
  h.reset();
  h.evaluate(`
    DB.tasks.push({
      id: 'task-1', title: 'Existing task', status: 'doing',
      comments: [], attachments: [], doc: { versions: [], comments: [] }
    });
    for (let i = 0; i < 20; i++) {
      DB.members.push({ id: 'member-' + i, name: 'Member ' + i, role: '组员', isAdmin: false });
      DB.sessions['token-' + i] = { memberId: 'member-' + i, ts: 1 };
    }
  `);

  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => h.request({
    token: 'token-' + i,
    pathname: '/api/reviews',
    body: { taskId: 'task-1', content: 'review-' + i },
    delay: (19 - i) % 7 + 1
  })));

  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].statusCode, 200);
    assert.equal(results[i].payload.review.authorId, 'member-' + i);
    assert.equal(results[i].payload.review.authorName, 'Member ' + i);
  }
  assert.equal(h.evaluate('DB.reviews.length'), 20);
});
