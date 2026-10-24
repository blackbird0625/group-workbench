/* ============================================================
 * 小组作业工作台 · 后端服务（零依赖，Node.js 原生实现）
 * ------------------------------------------------------------
 * 启动：node server.js   （需 Node.js 18+）
 * 端口：默认 3000，可用环境变量 PORT 修改
 * 数据：保存在 ./data/state.json，重启不丢失
 * 说明：无任何第三方依赖，单文件实现全部 /api 接口 + 静态页面
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const portFlag = process.argv.indexOf('--port');
const CLI_PORT = portFlag === -1 ? null : process.argv[portFlag + 1];
const PORT = process.env.PORT || CLI_PORT || 3000;
const PUB_DIR = path.resolve(process.env.PUB_DIR || path.join(__dirname, 'public'));   // 可用环境变量指定前端目录
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const MAX_BODY = 10 * 1024 * 1024;   // 请求体上限 10MB（6MB 文件 base64 后约 8MB）
const COOKIE_NAME = 'wb_session';
const YEAR_SECONDS = 365 * 24 * 3600;
const SETUP_KEY = process.env.SETUP_KEY || crypto.randomBytes(16).toString('hex');

/* ============ 工具 ============ */
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const now = () => Date.now();
function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
}
function newSalt() {
  return crypto.randomBytes(8).toString('hex');
}

/* ============ 数据状态 ============ */
let DB = null;
let saveTimer = null;

function emptyState() {
  return {
    setupDone: false,
    settings: {},       // 初始化向导保存的配置：{title,subtitle,adminLabel,modules,perms,lines,resCats}
    members: [],        // {id,name,role,isAdmin,pinSalt,pinHash}
    tasks: [],          // {id,title,desc,line,ddl,assigneeId,status,order,createdAt,updatedAt,comments,attachments,doc}
    resources: [],      // {id,name,size,type,cat,desc,dataUrl,uploadedBy,uploadedAt}
    announcements: [],  // {id,title,body,pinned,authorId,authorName,ts}
    literatures: [],    // {id,title,source,note,authorId,authorName,ts,adopted,votes,comments}
    reviews: [],        // {id,taskId,authorId,authorName,content,ts,resolution,resolvedAt,resolvedBy,adminNote}
    dismissed: {},      // dismissed[memberId][key] = ts
    sessions: {}        // token -> {memberId, ts}
  };
}

/* ---------- 存储适配层 ----------
 * file（默认）  ：同步读写 data/state.json，零依赖，行为与 v1 完全一致
 * supabase     ：懒加载 @supabase/supabase-js，数据存 Supabase（云部署重启不丢），
 *                建表脚本 backend/supabase/schema.sql，RLS 只放行 service_role
 * 上层业务代码只认 loadState / loadStateAsync / saveState / persistNow 四个入口 */
const STORAGE = (process.env.STORAGE || 'file').toLowerCase();

function fileLoad() {
  try {
    DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // 兼容缺字段
    const d = emptyState();
    for (const k of Object.keys(d)) if (DB[k] === undefined) DB[k] = d[k];
  } catch (e) {
    DB = emptyState();
  }
}
function filePersistNow() {
  // 原子写：先写临时文件再改名，避免写一半断电损坏
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB));
  fs.renameSync(tmp, DATA_FILE);
}

/* ---- supabase 实现（仅 STORAGE=supabase 时才 require，file 模式不用装依赖）---- */
let _sb = null;
function sb() {
  if (_sb) return _sb;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    throw new Error('STORAGE=supabase 需要设置 SUPABASE_URL 和 SUPABASE_SERVICE_KEY 环境变量');
  const { createClient } = require('@supabase/supabase-js');   // 懒加载
  _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  return _sb;
}
/* 表映射：命名列仅供人工查表，data JSONB 列才是应用读写的权威载荷 */
const SB_TABLES = {
  members:      m => ({ id: m.id, name: m.name, role: m.role, is_admin: !!m.isAdmin, pin_salt: m.pinSalt || null, pin_hash: m.pinHash || null, data: m, updated_at: new Date().toISOString() }),
  tasks:        t => ({ id: t.id, title: t.title, line: t.line, ddl: t.ddl || null, assignee_id: t.assigneeId || null, status: t.status, sort_order: Number(t.order) || 0, comments: t.comments || [], attachments: t.attachments || [], doc: t.doc || { versions: [], comments: [] }, data: t, updated_at: new Date().toISOString() }),
  resources:    r => ({ id: r.id, name: r.name, cat: r.cat, uploaded_by: r.uploadedBy || null, data: r, uploaded_at: new Date(Number(r.uploadedAt) || Date.now()).toISOString() }),
  announcements:a => ({ id: a.id, title: a.title, pinned: !!a.pinned, author_id: a.authorId || null, data: a, ts: new Date(Number(a.ts) || Date.now()).toISOString() }),
  literatures:  x => ({ id: x.id, title: x.title, adopted: !!x.adopted, author_id: x.authorId || null, votes: x.votes || {}, comments: x.comments || [], data: x, ts: new Date(Number(x.ts) || Date.now()).toISOString() }),
  reviews:      r => ({ id: r.id, task_id: r.taskId || null, author_id: r.authorId || null, resolution: r.resolution || 'pending', data: r, ts: new Date(Number(r.ts) || Date.now()).toISOString() })
};

async function sbLoad() {
  const c = sb();
  const fresh = emptyState();
  const st = await c.from('settings').select('data').eq('id', 1).maybeSingle();
  if (st.error) throw new Error('读取 settings 失败：' + st.error.message);
  if (st.data && st.data.data && typeof st.data.data === 'object') fresh.settings = st.data.data;
  for (const name of Object.keys(SB_TABLES)) {
    const r = await c.from(name).select('data');
    if (r.error) throw new Error('读取 ' + name + ' 失败：' + r.error.message);
    fresh[name] = (r.data || []).map(x => x && x.data).filter(Boolean);
  }
  const dm = await c.from('dismissed').select('member_id,key,ts');
  if (dm.error) throw new Error('读取 dismissed 失败：' + dm.error.message);
  (dm.data || []).forEach(x => { (fresh.dismissed[x.member_id] = fresh.dismissed[x.member_id] || {})[x.key] = Number(x.ts) || 0; });
  const ss = await c.from('sessions').select('token,member_id,ts');
  if (ss.error) throw new Error('读取 sessions 失败：' + ss.error.message);
  (ss.data || []).forEach(x => { fresh.sessions[x.token] = { memberId: x.member_id, ts: Number(x.ts) || 0 }; });
  DB = fresh;
}

/* 增量同步：只上传内容有变化的行、删除远端多出的行，避免每次全量重传 base64 附件 */
const sbLast = {};
async function sbSyncTable(name, rows) {
  const c = sb(); const toRow = SB_TABLES[name];
  const prev = sbLast[name] || new Map();
  const curr = new Map(rows.map(r => [r.id, JSON.stringify(r)]));
  const upsertRows = [];
  for (const [id, json] of curr) {
    if (prev.get(id) !== json) upsertRows.push(toRow(rows.find(r => r.id === id)));
  }
  if (upsertRows.length) {
    const r = await c.from(name).upsert(upsertRows);
    if (r.error) throw new Error('写入 ' + name + ' 失败：' + r.error.message);
  }
  const del = [...prev.keys()].filter(id => !curr.has(id));
  if (del.length) {
    const r = await c.from(name).delete().in('id', del);
    if (r.error) throw new Error('删除 ' + name + ' 失败：' + r.error.message);
  }
  sbLast[name] = curr;
}

let sbSaveChain = Promise.resolve();   // 串行化保存，避免并发 upsert 交错
async function sbSave() {
  const c = sb();
  const s = await c.from('settings').upsert({ id: 1, data: DB.settings || {}, updated_at: new Date().toISOString() });
  if (s.error) throw new Error('写入 settings 失败：' + s.error.message);
  for (const name of Object.keys(SB_TABLES)) await sbSyncTable(name, DB[name]);
  /* dismissed / sessions 是无独立行 id 的小表：整体重建 */
  const d = await c.from('dismissed').delete().neq('member_id', '');
  if (d.error) throw new Error('清空 dismissed 失败：' + d.error.message);
  const drows = [];
  Object.entries(DB.dismissed || {}).forEach(([mid, keys]) => {
    Object.entries(keys || {}).forEach(([k, ts]) => drows.push({ member_id: mid, key: k, ts: Number(ts) || 0 }));
  });
  if (drows.length) {
    const r = await c.from('dismissed').insert(drows);
    if (r.error) throw new Error('写入 dismissed 失败：' + r.error.message);
  }
  const sv = await c.from('sessions').delete().neq('token', '');
  if (sv.error) throw new Error('清空 sessions 失败：' + sv.error.message);
  const srows = Object.entries(DB.sessions || {}).map(([token, v]) => ({ token, member_id: v.memberId, ts: Number(v.ts) || 0 }));
  if (srows.length) {
    const r = await c.from('sessions').insert(srows);
    if (r.error) throw new Error('写入 sessions 失败：' + r.error.message);
  }
}

/* ---- 统一入口 ---- */
function loadState() { fileLoad(); }                    // file 模式（同步）
async function loadStateAsync() { await sbLoad(); }     // supabase 模式（异步，启动时调用）
function saveState() {
  // 合并写：延迟 200ms 防抖（file 与 supabase 共用）
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 200);
}
function persistNow() {
  saveTimer = null;
  if (STORAGE === 'supabase') {
    sbSaveChain = sbSaveChain.then(sbSave).catch(e => console.error('[保存失败]', e.message));
    return;
  }
  try { filePersistNow(); } catch (e) { console.error('[保存失败]', e.message); }
}

/* 暴露给前端的 state：剥掉 PIN 哈希等敏感字段 */
function publicState() {
  return {
    setupDone: DB.setupDone,
    settings: DB.settings || {},
    members: DB.members.map(m => ({
      id: m.id, name: m.name, role: m.role, isAdmin: !!m.isAdmin, pinBound: !!m.pinHash
    })),
    tasks: DB.tasks,
    resources: DB.resources,
    announcements: DB.announcements,
    literatures: DB.literatures,
    reviews: DB.reviews,
    dismissed: DB.dismissed
  };
}
/* 未登录只能取得登录页需要的最小信息，绝不携带任务、文档或附件。 */
function anonymousState() {
  return {
    setupDone: DB.setupDone,
    settings: DB.settings || {},
    members: DB.members.map(m => ({
      id: m.id, name: m.name, role: m.role, isAdmin: !!m.isAdmin, pinBound: !!m.pinHash
    }))
  };
}

/* 备份导出用：完整数据（含 pinSalt/pinHash），仅排除 sessions */
function backupState() {
  const o = Object.assign({}, DB);
  delete o.sessions;
  return o;
}

/* ============ 会话 ============ */
function createSession(memberId) {
  const token = crypto.randomBytes(24).toString('hex');
  DB.sessions[token] = { memberId, ts: now() };
  saveState();
  return token;
}
function memberFromToken(token) {
  if (!token) return null;
  const s = DB.sessions[token];
  if (!s) return null;
  const m = DB.members.find(x => x.id === s.memberId);
  return m || null;
}
function destroySession(token) {
  if (token && DB.sessions[token]) {
    delete DB.sessions[token];
    saveState();
  }
}

/* ============ HTTP 基础 ============ */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach(pair => {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) });
  res.end(body);
}
class ApiError extends Error {
  constructor(msg, code) { super(msg); this.code = code || 400; }
}

/* ============ 静态文件 ============ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUB_DIR, rel));
  /* 路径穿越防护：必须带路径分隔符比较，否则 "xxx-evil" 这类兄弟目录能骗过字符串前缀判断 */
  if (file !== PUB_DIR && !file.startsWith(PUB_DIR + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // 非 API 的未知路径回落到首页（前端无路由，直接给 404 即可）
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600'
    });
    res.end(data);
  });
}

/* ============ 业务逻辑 ============ */
function getMember(id) { return DB.members.find(m => m.id === id); }
function getTask(id) { return DB.tasks.find(t => t.id === id); }
function requireAuth(req) {
  const token = req.headers['x-session'] || parseCookies(req)[COOKIE_NAME];
  const m = memberFromToken(token);
  if (!m) throw new ApiError('未登录或登录已过期', 401);
  return { token, member: m };
}
function requireAdmin(member) {
  if (!member.isAdmin) throw new ApiError('仅管理员可执行此操作', 403);
}
/* 权限矩阵：初始化向导里定的规则（settings.perms），'all'=所有成员 / 'admin'=仅管理员 */
function permAllows(member, key) {
  const p = (DB.settings && DB.settings.perms && DB.settings.perms[key]) || 'admin';
  return p === 'all' || !!member.isAdmin;
}
function requirePerm(member, key) {
  if (!permAllows(member, key)) throw new ApiError('你没有该操作的权限', 403);
}
function meView(m) {
  return { id: m.id, name: m.name, role: m.role, isAdmin: !!m.isAdmin };
}
function sysComment(content) {
  return { id: uid(), authorId: 'system', authorName: '系统', content, ts: now(), type: 'system' };
}
function normLine(line) {
  // 任务分类由前端 config.js 定义，后端只做基本清洗，不限制具体取值
  const s = String(line || 'other').slice(0, 40);
  return /^[a-zA-Z0-9-]+$/.test(s) ? s : 'other';
}
function normDdl(ddl) {
  const s = String(ddl || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
function validDataUrl(dataUrl) {
  return typeof dataUrl === 'string' && /^data:[\w./+-]*;base64,[A-Za-z0-9+/=]+$/.test(dataUrl);
}

/* ---- 初始化（新版向导：成员数组 + 设置，由持有初始化密钥的人决定） ---- */
function setupKeyMatches(input) {
  const expected = Buffer.from(SETUP_KEY);
  const provided = Buffer.from(String(input || ''));
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}
function apiSetup(body) {
  if (DB.setupDone) throw new ApiError('工作台已初始化过，不能重复初始化', 403);
  if (!setupKeyMatches(body.setupKey)) throw new ApiError('初始化密钥不正确', 403);
  const list = Array.isArray(body.members) ? body.members : [];
  const members = list
    .map(m => ({ name: String((m && m.name) || '').trim().slice(0, 12), admin: !!(m && m.admin) }))
    .filter(m => m.name);
  if (!members.length) throw new ApiError('至少需要一名成员');
  if (!members.some(m => m.admin)) members[0].admin = true;   // 兜底：没人勾管理就把第一个设为管理员
  members.forEach(m => DB.members.push({
    id: uid(), name: m.name, role: m.admin ? '管理员' : '组员', isAdmin: m.admin,
    pinSalt: null, pinHash: null
  }));
  /* settings 只做基本清洗，取值由初始化者定，后端透传 */
  const s = (body.settings && typeof body.settings === 'object') ? body.settings : {};
  DB.settings = {
    title: String(s.title || '小组作业工作台').slice(0, 40),
    subtitle: String(s.subtitle || '').slice(0, 40),
    adminLabel: String(s.adminLabel || '管理员').slice(0, 10),
    modules: (s.modules && typeof s.modules === 'object') ? s.modules : {},
    perms: (s.perms && typeof s.perms === 'object') ? s.perms : {},
    lines: (s.lines && typeof s.lines === 'object') ? s.lines : { other: '其他' },
    resCats: (s.resCats && typeof s.resCats === 'object') ? s.resCats : { other: { name: '其他', icon: '◈' } }
  };
  DB.setupDone = true;
  saveState();
  return { ok: true, state: publicState() };
}

/* ---- 身份验证 ---- */
function apiBind(body) {
  const m = getMember(String(body.memberId || ''));
  const pin = String(body.pin || '');
  if (!m) throw new ApiError('成员不存在', 404);
  if (!/^\d{4,8}$/.test(pin)) throw new ApiError('PIN 需为 4-8 位数字');
  if (m.pinHash) throw new ApiError('该身份已绑定 PIN，请直接登录', 403);
  m.pinSalt = newSalt();
  m.pinHash = hashPin(pin, m.pinSalt);
  const token = createSession(m.id);
  return { token, me: meView(m) };
}
function apiLogin(body) {
  const m = getMember(String(body.memberId || ''));
  const pin = String(body.pin || '');
  if (!m) throw new ApiError('成员不存在', 404);
  if (!m.pinHash) throw new ApiError('该身份尚未设置 PIN，请先设置');
  if (hashPin(pin, m.pinSalt) !== m.pinHash) throw new ApiError('PIN 错误', 403);
  const token = createSession(m.id);
  return { token, me: meView(m) };
}

/* ---- 成员 ---- */
function apiMemberPatch(id, body) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'memberManage');
  const m = getMember(id);
  if (!m) throw new ApiError('成员不存在', 404);
  if (body.resetPin) {
    if (m.pinHash) {
      delete m.pinHash; delete m.pinSalt;
      // 重置 PIN = 该成员所有会话作废
      for (const t of Object.keys(DB.sessions)) {
        if (DB.sessions[t].memberId === m.id) delete DB.sessions[t];
      }
    }
    saveState();
    return { state: publicState() };
  }
  if (body.isAdmin !== undefined) {
    // 授予/撤销管理员；全组至少保留一名
    const target = !!body.isAdmin;
    if (!target && m.isAdmin && DB.members.filter(x => x.isAdmin).length <= 1)
      throw new ApiError('至少需要保留一名管理员');
    m.isAdmin = target;
    saveState();
    return { state: publicState() };
  }
  const name = String(body.name || '').trim().slice(0, 12);
  if (!name) throw new ApiError('名字不能为空');
  m.name = name;
  m.role = String(body.role || '').trim().slice(0, 20);
  saveState();
  return { state: publicState() };
}
function apiMemberAdd(body) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'memberManage');
  const name = String(body.name || '').trim().slice(0, 12);
  if (!name) throw new ApiError('名字不能为空');
  DB.members.push({
    id: uid(), name, role: String(body.role || '').trim().slice(0, 20),
    isAdmin: false, pinSalt: null, pinHash: null
  });
  saveState();
  return { state: publicState() };
}
function apiMemberDel(id) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'memberManage');
  const m = getMember(id);
  if (!m) throw new ApiError('成员不存在', 404);
  if (m.isAdmin && DB.members.filter(x => x.isAdmin).length <= 1)
    throw new ApiError('至少需要保留一名管理员，不能删除最后一名');
  const taskN = DB.tasks.filter(t => t.assigneeId === id).length;
  if (taskN) throw new ApiError('该成员名下还有 ' + taskN + ' 项任务，先转移或删除任务');
  DB.members = DB.members.filter(x => x.id !== id);
  for (const t of Object.keys(DB.sessions)) {
    if (DB.sessions[t].memberId === id) delete DB.sessions[t];
  }
  saveState();
  return { state: publicState() };
}

/* ---- 任务 ---- */
function apiTaskCreate(body) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'createTask');
  const title = String(body.title || '').trim().slice(0, 100);
  if (!title) throw new ApiError('任务名称不能为空');
  const task = {
    id: uid(), title,
    desc: String(body.desc || '').trim().slice(0, 2000),
    line: normLine(body.line),
    ddl: normDdl(body.ddl),
    assigneeId: (body.assigneeId && getMember(String(body.assigneeId))) ? String(body.assigneeId) : null,
    status: 'unclaimed',
    order: DB.tasks.reduce((mx, t) => Math.max(mx, t.order || 0), 0) + 1,
    createdAt: now(), updatedAt: now(),
    comments: [], attachments: [],
    doc: { versions: [], comments: [] }
  };
  DB.tasks.push(task);
  saveState();
  return { task };
}
function apiTaskPatch(id, body) {
  const { member } = requireAuthProxy();
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  if (!member.isAdmin && t.assigneeId !== member.id) throw new ApiError('仅负责人与管理员可编辑任务', 403);
  if (body.title !== undefined) {
    const title = String(body.title || '').trim().slice(0, 100);
    if (!title) throw new ApiError('任务名称不能为空');
    t.title = title;
  }
  if (body.desc !== undefined) t.desc = String(body.desc || '').trim().slice(0, 2000);
  if (body.line !== undefined) t.line = normLine(body.line);
  if (body.ddl !== undefined) t.ddl = normDdl(body.ddl);
  if (body.assigneeId !== undefined) {
    // 指定/更换负责人：按权限矩阵
    requirePerm(member, 'assignTask');
    t.assigneeId = (body.assigneeId && getMember(String(body.assigneeId))) ? String(body.assigneeId) : null;
  }
  t.updatedAt = now();
  saveState();
  return { task: t };
}
function apiTaskDel(id) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'deleteTask');
  if (!getTask(id)) throw new ApiError('任务不存在', 404);
  DB.tasks = DB.tasks.filter(t => t.id !== id);
  DB.reviews = DB.reviews.filter(r => r.taskId !== id);
  saveState();
  return { ok: true };
}
function apiTaskClaim(id) {
  const { member } = requireAuthProxy();
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  if (t.status !== 'unclaimed') throw new ApiError('任务已被认领或不在待认领状态');
  t.assigneeId = member.id;
  t.status = 'doing';
  t.updatedAt = now();
  t.comments.push(sysComment(member.name + ' 认领了任务'));
  saveState();
  return { task: t };
}
const TASK_TRANSITIONS = {
  unclaimed: ['doing'],
  doing: ['review'],
  review: ['rework', 'done'],
  rework: ['doing'],
  done: []
};
function apiTaskStatus(id, body) {
  const { member } = requireAuthProxy();
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  const from = t.status;
  const to = String(body.status || '');
  if (to === from) throw new ApiError('已经是该状态');
  if (!Object.prototype.hasOwnProperty.call(TASK_TRANSITIONS, to)) throw new ApiError('未知状态');
  if (to === 'unclaimed') throw new ApiError('任务不能被退回待认领');
  if (!(TASK_TRANSITIONS[from] || []).includes(to))
    throw new ApiError('当前状态不能变更为该状态');
  const isOwner = t.assigneeId === member.id;

  if (to === 'doing') {
    if (from === 'rework' && !isOwner && !member.isAdmin)
      throw new ApiError('仅本人或管理员可以调整', 403);
    // 与 claim 接口保持相同语义，避免产生“进行中但无负责人”的任务。
    if (from === 'unclaimed') t.assigneeId = member.id;
  } else if (to === 'review') {
    if (!isOwner && !member.isAdmin) throw new ApiError('仅负责人本人可以提交审核', 403);
    const hasDoc = t.doc && t.doc.versions && t.doc.versions.length > 0;
    if (!(t.attachments && t.attachments.length) && !hasDoc)
      throw new ApiError('规则要求：需先上传附件或完成交付文档');
  } else if (to === 'rework') {
    requirePerm(member, 'markRework');
    const note = String(body.note || '').trim().slice(0, 1000);
    if (!note) throw new ApiError('返工意见必填');
    t.comments.push({ id: uid(), authorId: member.id, authorName: member.name, content: note, ts: now(), type: 'rework' });
  } else if (to === 'done') {
    requirePerm(member, 'markDone');
  }
  t.status = to;
  t.updatedAt = now();
  if (to !== 'rework') {
    const label = from === 'unclaimed' && to === 'doing'
      ? '认领了任务'
      : { doing: '进入进行中', review: '提交了审核', done: '验收通过，任务完成' }[to];
    t.comments.push(sysComment(member.name + ' ' + label));
  }
  saveState();
  return { task: t };
}
function apiTaskComment(id, body) {
  const { member } = requireAuthProxy();
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  if (!member.isAdmin && t.assigneeId !== member.id)
    throw new ApiError('评论区仅负责人与管理员可发言', 403);
  const content = String(body.content || '').trim().slice(0, 2000);
  if (!content) throw new ApiError('内容不能为空');
  t.comments.push({ id: uid(), authorId: member.id, authorName: member.name, content, ts: now() });
  t.updatedAt = now();
  saveState();
  return { task: t };
}
function apiTaskCommentDel(id, cid) {
  const { member } = requireAuthProxy();
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  const c = t.comments.find(x => x.id === cid);
  if (!c) throw new ApiError('评论不存在', 404);
  if (!member.isAdmin && c.authorId !== member.id) throw new ApiError('只能删除自己的评论', 403);
  t.comments = t.comments.filter(x => x.id !== cid);
  saveState();
  return { task: t };
}
function apiTaskAttach(id, body) {
  const { member } = requireAuthProxy();
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  if (!member.isAdmin && t.assigneeId !== member.id) throw new ApiError('仅负责人与管理员可上传附件', 403);
  if (t.status === 'done') throw new ApiError('任务已完成，不能再上传附件');
  const name = String(body.name || '未命名').slice(0, 200);
  const size = Number(body.size) || 0;
  if (size > 6 * 1024 * 1024) throw new ApiError('文件超过 6MB 限制');
  const dataUrl = String(body.dataUrl || '');
  if (!validDataUrl(dataUrl)) throw new ApiError('文件数据格式不正确');
  const att = { id: uid(), name, size, type: String(body.type || '').slice(0, 100), dataUrl, uploadedBy: member.id, uploadedByName: member.name, uploadedAt: now() };
  t.attachments.push(att);
  t.updatedAt = now();
  saveState();
  return { task: t };
}
function apiTaskAttachDel(id, attId) {
  const { member } = requireAuthProxy();
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  const att = t.attachments.find(a => a.id === attId);
  if (!att) throw new ApiError('附件不存在', 404);
  if (!member.isAdmin && att.uploadedBy !== member.id) throw new ApiError('只能删除自己上传的附件', 403);
  t.attachments = t.attachments.filter(a => a.id !== attId);
  saveState();
  return { task: t };
}

/* ---- 交付文档 ---- */
function apiDocVersion(id, body) {
  const { member } = requireAuthProxy();
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  if (!member.isAdmin && t.assigneeId !== member.id) throw new ApiError('仅负责人与管理员可编辑交付文档', 403);
  const content = String(body.content || '');
  if (!content.trim()) throw new ApiError('文档内容为空');
  if (content.length > 500000) throw new ApiError('文档过长');
  const latest = t.doc.versions[t.doc.versions.length - 1];
  if (latest && content === latest.content) throw new ApiError('内容没有变化');
  const v = {
    id: uid(), num: t.doc.versions.length + 1,
    content, note: String(body.note || '').trim().slice(0, 200),
    editorId: member.id, editorName: member.name, ts: now()
  };
  t.doc.versions.push(v);
  t.updatedAt = now();
  saveState();
  return { task: t, version: v };
}
function apiDocComment(id, body) {
  const { member } = requireAuthProxy();
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  const content = String(body.content || '').trim().slice(0, 2000);
  if (!content) throw new ApiError('内容不能为空');
  t.doc.comments.push({
    id: uid(), authorId: member.id, authorName: member.name,
    quote: String(body.quote || '').slice(0, 200), content,
    ts: now(), resolved: false
  });
  saveState();
  return { task: t };
}
function apiDocCommentResolve(id, cid) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'resolveReview');
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  const c = t.doc.comments.find(x => x.id === cid);
  if (!c) throw new ApiError('意见不存在', 404);
  c.resolved = !c.resolved;
  saveState();
  return { task: t };
}
function apiDocCommentDel(id, cid) {
  const { member } = requireAuthProxy();
  const t = getTask(id);
  if (!t) throw new ApiError('任务不存在', 404);
  const c = t.doc.comments.find(x => x.id === cid);
  if (!c) throw new ApiError('意见不存在', 404);
  if (!member.isAdmin && c.authorId !== member.id) throw new ApiError('只能删除自己提的意见', 403);
  t.doc.comments = t.doc.comments.filter(x => x.id !== cid);
  saveState();
  return { task: t };
}

/* ---- 资料库 ---- */
function apiResourceAdd(body) {
  const { member } = requireAuthProxy();
  const name = String(body.name || '未命名').slice(0, 200);
  const size = Number(body.size) || 0;
  if (size > 6 * 1024 * 1024) throw new ApiError('文件超过 6MB 限制');
  const dataUrl = String(body.dataUrl || '');
  if (!validDataUrl(dataUrl)) throw new ApiError('文件数据格式不正确');
  const resource = {
    id: uid(), name, size, type: String(body.type || '').slice(0, 100),
    cat: normLine(body.cat), desc: String(body.desc || '').trim().slice(0, 500),
    dataUrl, uploadedBy: member.id, uploadedAt: now()
  };
  DB.resources.push(resource);
  saveState();
  return { resource };
}
function apiResourceDel(id) {
  const { member } = requireAuthProxy();
  const r = DB.resources.find(x => x.id === id);
  if (!r) throw new ApiError('资料不存在', 404);
  if (!member.isAdmin && r.uploadedBy !== member.id) throw new ApiError('仅上传者与管理员可删除', 403);
  DB.resources = DB.resources.filter(x => x.id !== id);
  saveState();
  return { ok: true };
}

/* ---- 公告 ---- */
function apiAnnAdd(body) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'announce');
  const title = String(body.title || '').trim().slice(0, 100);
  if (!title) throw new ApiError('标题不能为空');
  const ann = {
    id: uid(), title, body: String(body.body || '').trim().slice(0, 10000),
    pinned: !!body.pinned, authorId: member.id, authorName: member.name, ts: now()
  };
  DB.announcements.push(ann);
  saveState();
  return { announcement: ann };
}
function apiAnnPin(id) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'announce');
  const a = DB.announcements.find(x => x.id === id);
  if (!a) throw new ApiError('公告不存在', 404);
  a.pinned = !a.pinned;
  saveState();
  return { announcement: a };
}
function apiAnnDel(id) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'announce');
  if (!DB.announcements.find(x => x.id === id)) throw new ApiError('公告不存在', 404);
  DB.announcements = DB.announcements.filter(x => x.id !== id);
  saveState();
  return { ok: true };
}

/* ---- 审议意见 ---- */
function apiReviewAdd(body) {
  const { member } = requireAuthProxy();
  const taskId = String(body.taskId || '');
  if (!getTask(taskId)) throw new ApiError('对应任务不存在', 404);
  const content = String(body.content || '').trim().slice(0, 2000);
  if (!content) throw new ApiError('意见内容不能为空');
  const review = {
    id: uid(), taskId, authorId: member.id, authorName: member.name,
    content, ts: now(), resolution: 'pending', resolvedAt: null, resolvedBy: null, adminNote: ''
  };
  DB.reviews.push(review);
  saveState();
  return { review };
}
function apiReviewPatch(id, body) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'resolveReview');
  const r = DB.reviews.find(x => x.id === id);
  if (!r) throw new ApiError('审议意见不存在', 404);
  const res = String(body.resolution || '');
  if (!['pending', 'accepted', 'rejected'].includes(res)) throw new ApiError('无效的处理结果');
  r.resolution = res;
  r.adminNote = String(body.adminNote || '').trim().slice(0, 1000);
  if (res === 'pending') { r.resolvedAt = null; r.resolvedBy = null; }
  else { r.resolvedAt = now(); r.resolvedBy = member.id; }
  saveState();
  return { review: r };
}

/* ---- 文献汇总 ---- */
function apiLitAdd(body) {
  const { member } = requireAuthProxy();
  const title = String(body.title || '').trim().slice(0, 300);
  if (!title) throw new ApiError('题目不能为空');
  const dup = DB.literatures.some(x => x.title.trim().toLowerCase() === title.toLowerCase());
  if (dup) throw new ApiError('清单里已有这条文献（题目重复）');
  const item = {
    id: uid(), title,
    source: String(body.source || '').trim().slice(0, 200),
    note: String(body.note || '').trim().slice(0, 500),
    authorId: member.id, authorName: member.name, ts: now(),
    adopted: false, votes: {}, comments: []
  };
  DB.literatures.push(item);
  saveState();
  return { item };
}
function apiLitPatch(id, body) {
  const { member } = requireAuthProxy();
  const x = DB.literatures.find(v => v.id === id);
  if (!x) throw new ApiError('文献不存在', 404);
  if (body.action === 'vote') {
    const vote = body.vote === 'up' ? 'up' : body.vote === 'down' ? 'down' : null;
    if (!vote) throw new ApiError('无效的投票');
    if (x.votes[member.id] === vote) delete x.votes[member.id];  // 再点一次取消
    else x.votes[member.id] = vote;
  } else if (body.action === 'adopt') {
    requirePerm(member, 'adoptLit');
    x.adopted = !x.adopted;
  } else {
    throw new ApiError('无效的操作');
  }
  saveState();
  return { item: x };
}
function apiLitDel(id) {
  const { member } = requireAuthProxy();
  const x = DB.literatures.find(v => v.id === id);
  if (!x) throw new ApiError('文献不存在', 404);
  if (!member.isAdmin && x.authorId !== member.id) throw new ApiError('仅提交者与管理员可删除', 403);
  DB.literatures = DB.literatures.filter(v => v.id !== id);
  saveState();
  return { ok: true };
}
function apiLitComment(id, body) {
  const { member } = requireAuthProxy();
  const x = DB.literatures.find(v => v.id === id);
  if (!x) throw new ApiError('文献不存在', 404);
  const content = String(body.content || '').trim().slice(0, 2000);
  if (!content) throw new ApiError('内容不能为空');
  x.comments.push({ id: uid(), authorId: member.id, authorName: member.name, content, ts: now() });
  saveState();
  return { item: x };
}
function apiLitCommentDel(id, cid) {
  const { member } = requireAuthProxy();
  const x = DB.literatures.find(v => v.id === id);
  if (!x) throw new ApiError('文献不存在', 404);
  const c = x.comments.find(v => v.id === cid);
  if (!c) throw new ApiError('评论不存在', 404);
  if (!member.isAdmin && c.authorId !== member.id) throw new ApiError('只能删除自己的评论', 403);
  x.comments = x.comments.filter(v => v.id !== cid);
  saveState();
  return { item: x };
}

/* ---- 提醒 / 备份 ---- */
function apiDismiss(key) {
  const { member } = requireAuthProxy();
  const k = String(key || '').slice(0, 200);
  if (!DB.dismissed[member.id]) DB.dismissed[member.id] = {};
  DB.dismissed[member.id][k] = now();
  saveState();
  return { ok: true };
}
function apiBackup() {
  const { member } = requireAuthProxy();
  requirePerm(member, 'backup');
  /* 备份要能完整救回数据，必须含 PIN 盐与哈希（否则恢复后所有人都要重设 PIN）。
   * 这是管理员专用接口，备份文件含敏感字段，须妥善保管。会话不导出。 */
  return { state: backupState() };
}
function apiRestore(body) {
  const { member } = requireAuthProxy();
  requirePerm(member, 'backup');
  const st = body.state;
  if (!st || typeof st !== 'object') throw new ApiError('备份文件格式不正确');
  const sessions = DB.sessions;   // 会话保留，恢复后不用重新登录
  DB = {
    setupDone: st.setupDone !== false && Array.isArray(st.members) && st.members.length > 0,
    settings: (st.settings && typeof st.settings === 'object') ? st.settings : (DB.settings || {}),
    members: Array.isArray(st.members) ? st.members.map(m => ({
      id: String(m.id || uid()), name: String(m.name || '?').slice(0, 12),
      role: String(m.role || '').slice(0, 20), isAdmin: !!m.isAdmin,
      pinSalt: m.pinSalt || null, pinHash: m.pinHash || null
    })) : [],
    tasks: Array.isArray(st.tasks) ? st.tasks.map(t => ({
      id: String(t.id || uid()), title: String(t.title || '未命名').slice(0, 100),
      desc: String(t.desc || ''), line: normLine(t.line), ddl: normDdl(t.ddl),
      assigneeId: t.assigneeId || null, status: ['unclaimed','doing','review','rework','done'].includes(t.status) ? t.status : 'unclaimed',
      order: Number(t.order) || 0, createdAt: Number(t.createdAt) || now(), updatedAt: Number(t.updatedAt) || now(),
      comments: Array.isArray(t.comments) ? t.comments : [],
      attachments: Array.isArray(t.attachments) ? t.attachments : [],
      doc: (t.doc && typeof t.doc === 'object') ? t.doc : { versions: [], comments: [] }
    })) : [],
    resources: Array.isArray(st.resources) ? st.resources : [],
    announcements: Array.isArray(st.announcements) ? st.announcements : [],
    literatures: Array.isArray(st.literatures) ? st.literatures : [],
    reviews: Array.isArray(st.reviews) ? st.reviews : [],
    dismissed: (st.dismissed && typeof st.dismissed === 'object') ? st.dismissed : {},
    sessions
  };
  saveState();
  return { state: publicState() };
}

/* 请求身份按异步调用链隔离，不能在进程级全局变量里保存“当前请求”。 */
const requestContext = new AsyncLocalStorage();
function requireAuthProxy() {
  const req = requestContext.getStore();
  if (!req) throw new ApiError('请求上下文不可用', 500);
  return requireAuth(req);
}

/* ============ 路由 ============ */
async function handleApi(req, res, pathname) {
  return requestContext.run(req, () => handleApiInContext(req, res, pathname));
}
async function handleApiInContext(req, res, pathname) {
  const method = req.method;
  let body = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') body = await readBody(req);
  const seg = pathname.replace(/^\/api/, '').split('/').filter(Boolean);  // ['tasks','xxx','claim']
  const root = seg[0] || '';

  try {
    /* bootstrap 对匿名访问只返回登录页摘要；登录后才返回完整工作状态。 */
    if (root === 'bootstrap' && method === 'GET') {
      const token = req.headers['x-session'] || parseCookies(req)[COOKIE_NAME];
      const authenticated = !!memberFromToken(token);
      return sendJson(res, 200, {
        ok: true, serverTime: now(), authenticated,
        state: authenticated ? publicState() : anonymousState()
      });
    }
    if (root === 'setup' && method === 'POST') {
      return sendJson(res, 200, apiSetup(body));
    }
    if (root === 'auth') {
      if (seg[1] === 'bind' && method === 'POST') {
        const r = apiBind(body);
        return sendJson(res, 200, r, { 'Set-Cookie': COOKIE_NAME + '=' + r.token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + YEAR_SECONDS });
      }
      if (seg[1] === 'login' && method === 'POST') {
        const r = apiLogin(body);
        return sendJson(res, 200, r, { 'Set-Cookie': COOKIE_NAME + '=' + r.token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + YEAR_SECONDS });
      }
      if (seg[1] === 'me' && method === 'GET') {
        const token = req.headers['x-session'] || parseCookies(req)[COOKIE_NAME];
        const m = memberFromToken(token);
        return sendJson(res, 200, { me: m ? meView(m) : null });
      }
      if (seg[1] === 'logout' && method === 'POST') {
        const token = req.headers['x-session'] || parseCookies(req)[COOKIE_NAME];
        destroySession(token);
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
      }
    }

    /* 需要登录的接口 */
    if (root === 'reminders' && seg[1] === 'dismiss' && method === 'POST') {
      return sendJson(res, 200, apiDismiss(body.key));
    }
    if (root === 'members') {
      if (seg.length === 1 && method === 'POST') return sendJson(res, 200, apiMemberAdd(body));
      if (seg.length === 2 && method === 'PATCH') return sendJson(res, 200, apiMemberPatch(seg[1], body));
      if (seg.length === 2 && method === 'DELETE') return sendJson(res, 200, apiMemberDel(seg[1]));
    }
    if (root === 'tasks') {
      if (seg.length === 1 && method === 'POST') return sendJson(res, 200, apiTaskCreate(body));
      if (seg.length === 2 && method === 'PATCH') return sendJson(res, 200, apiTaskPatch(seg[1], body));
      if (seg.length === 2 && method === 'DELETE') return sendJson(res, 200, apiTaskDel(seg[1]));
      if (seg.length === 3 && seg[2] === 'claim' && method === 'POST') return sendJson(res, 200, apiTaskClaim(seg[1]));
      if (seg.length === 3 && seg[2] === 'status' && method === 'POST') return sendJson(res, 200, apiTaskStatus(seg[1], body));
      if (seg.length === 3 && seg[2] === 'comments' && method === 'POST') return sendJson(res, 200, apiTaskComment(seg[1], body));
      if (seg.length === 4 && seg[2] === 'comments' && method === 'DELETE') return sendJson(res, 200, apiTaskCommentDel(seg[1], seg[3]));
      if (seg.length === 3 && seg[2] === 'attachments' && method === 'POST') return sendJson(res, 200, apiTaskAttach(seg[1], body));
      if (seg.length === 4 && seg[2] === 'attachments' && method === 'DELETE') return sendJson(res, 200, apiTaskAttachDel(seg[1], seg[3]));
      if (seg.length === 4 && seg[2] === 'doc' && seg[3] === 'versions' && method === 'POST') return sendJson(res, 200, apiDocVersion(seg[1], body));
      if (seg.length === 4 && seg[2] === 'doc' && seg[3] === 'comments' && method === 'POST') return sendJson(res, 200, apiDocComment(seg[1], body));
      if (seg.length === 5 && seg[2] === 'doc' && seg[3] === 'comments' && method === 'PATCH') return sendJson(res, 200, apiDocCommentResolve(seg[1], seg[4]));
      if (seg.length === 5 && seg[2] === 'doc' && seg[3] === 'comments' && method === 'DELETE') return sendJson(res, 200, apiDocCommentDel(seg[1], seg[4]));
    }
    if (root === 'resources') {
      if (seg.length === 1 && method === 'POST') return sendJson(res, 200, apiResourceAdd(body));
      if (seg.length === 2 && method === 'DELETE') return sendJson(res, 200, apiResourceDel(seg[1]));
    }
    if (root === 'announcements') {
      if (seg.length === 1 && method === 'POST') return sendJson(res, 200, apiAnnAdd(body));
      if (seg.length === 3 && seg[2] === 'pin' && method === 'PATCH') return sendJson(res, 200, apiAnnPin(seg[1]));
      if (seg.length === 2 && method === 'DELETE') return sendJson(res, 200, apiAnnDel(seg[1]));
    }
    if (root === 'reviews') {
      if (seg.length === 1 && method === 'POST') return sendJson(res, 200, apiReviewAdd(body));
      if (seg.length === 2 && method === 'PATCH') return sendJson(res, 200, apiReviewPatch(seg[1], body));
    }
    if (root === 'literatures') {
      if (seg.length === 1 && method === 'POST') return sendJson(res, 200, apiLitAdd(body));
      if (seg.length === 2 && method === 'PATCH') return sendJson(res, 200, apiLitPatch(seg[1], body));
      if (seg.length === 2 && method === 'DELETE') return sendJson(res, 200, apiLitDel(seg[1]));
      if (seg.length === 3 && seg[2] === 'comments' && method === 'POST') return sendJson(res, 200, apiLitComment(seg[1], body));
      if (seg.length === 4 && seg[2] === 'comments' && method === 'DELETE') return sendJson(res, 200, apiLitCommentDel(seg[1], seg[3]));
    }
    if (root === 'backup' && method === 'GET') return sendJson(res, 200, apiBackup());
    if (root === 'restore' && method === 'POST') return sendJson(res, 200, apiRestore(body));

    return sendJson(res, 404, { error: '接口不存在' });
  } catch (e) {
    if (e instanceof ApiError) return sendJson(res, e.code, { error: e.message });
    console.error('[接口错误]', method, pathname, e);
    return sendJson(res, 500, { error: '服务器内部错误' });
  }
}

/* ============ 启动 ============ */
/* 退出前把防抖挂起的写盘刷出去，避免 Ctrl+C 丢最后 200ms 的改动 */
function flushAndExit() {
  if (saveTimer) { clearTimeout(saveTimer); persistNow(); }
  if (STORAGE === 'supabase') {
    // 等串行保存链落完（5 秒兜底）再退出
    const guard = setTimeout(() => process.exit(0), 5000);
    sbSaveChain.finally(() => { clearTimeout(guard); process.exit(0); });
    return;
  }
  process.exit(0);
}
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);

function startListen() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname).catch(e => {
        console.error('[请求失败]', e);
        try { sendJson(res, 400, { error: e.message }); } catch (_) {}
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end('Method Not Allowed'); return;
    }
    serveStatic(req, res, pathname);
  });

  server.listen(PORT, () => {
    console.log('');
    console.log('  小组作业工作台已启动');
    console.log('  本机访问:   http://localhost:' + PORT);
    console.log('  局域网访问: http://' + (require('os').hostname() || '本机IP') + ':' + PORT + ' （组员连同一 WiFi 可访问）');
    console.log('  存储模式:   ' + STORAGE + (STORAGE === 'supabase' ? '（数据存 Supabase，重启不丢）' : '（数据存 ' + DATA_DIR + '）'));
    if (!DB.setupDone) console.log('  初始化密钥: ' + SETUP_KEY + ' （仅首次初始化需要，请勿发到组员群）');
    console.log('');
  });
}

if (STORAGE === 'supabase') {
  loadStateAsync()
    .then(startListen)
    .catch(e => { console.error('[启动失败] Supabase 连接或读取异常：' + e.message); process.exit(1); });
} else {
  loadState();        // file 模式：同步加载，行为与 v1 完全一致
  startListen();
}
