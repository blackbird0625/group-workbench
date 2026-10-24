'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function createHarness() {
  // 只加载服务定义，不启动监听，也不接触真实 data/state.json。
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
    .split('/* ============ 启动 ============ */')[0];
  const context = vm.createContext({
    require,
    console,
    process,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    __dirname: ROOT
  });
  vm.runInContext(source, context, { filename: 'server.js' });
  vm.runInContext(`
    saveState = () => {};
    sendJson = (res, code, obj) => {
      res.statusCode = code;
      res.payload = obj;
    };
    readBody = req => req.delay
      ? new Promise(resolve => setTimeout(() => resolve(req.body || {}), req.delay))
      : Promise.resolve(req.body || {});
  `, context);

  function reset() {
    vm.runInContext(`
      DB = emptyState();
      DB.setupDone = true;
      DB.settings = { perms: { createTask: 'admin', announce: 'admin' } };
      DB.members = [
        { id: 'admin', name: 'Admin', role: '管理员', isAdmin: true },
        { id: 'user', name: 'User', role: '组员', isAdmin: false }
      ];
      DB.sessions = {
        'admin-token': { memberId: 'admin', ts: 1 },
        'user-token': { memberId: 'user', ts: 1 }
      };
    `, context);
  }

  async function request({ token, body = {}, delay = 0, pathname = '/api/tasks', method = 'POST' }) {
    const req = {
      method,
      headers: token ? { 'x-session': token } : {},
      body,
      delay
    };
    const res = {};
    const handleApi = vm.runInContext('handleApi', context);
    await handleApi(req, res, pathname);
    return res;
  }

  function evaluate(expression) {
    return vm.runInContext(expression, context);
  }

  return { reset, request, evaluate };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { createHarness, pause };
