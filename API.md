# 后端接口说明书（API.md）

本模板只包含前端。要让它跑起来，你需要**自己实现一个后端**，把下面这些接口按约定实现即可（语言不限：Node.js / Python / Go / 云函数 / Supabase Edge Function 都行）。

前端通过 `fetch('/api/...')` 相对路径访问后端，**推荐把前端页面和 API 部署在同一个域名下**（如反向代理把 `/api` 转发给后端）。如果必须跨域，后端需返回 CORS 头（`Access-Control-Allow-Origin` 等，并处理 `OPTIONS` 预检）。

---

## 一、通用约定

### 1. 数据格式

- 请求体与响应体均为 **JSON**（`Content-Type: application/json`）
- 出错时返回 HTTP 非 2xx 状态码 + `{"error": "中文错误信息"}`，前端会把这句话弹成提示
- 所有 id 为字符串

### 2. 登录凭证（会话）

- 登录成功后，后端生成一个随机 token 返回给前端
- 之后每个需登录的请求，前端会带上 **请求头 `X-Session: <token>`**（同时浏览器会带 Cookie `wb_session`，二选一识别即可）
- `GET /api/bootstrap` 和 `POST /api/setup`、`/api/auth/*` 之外的所有接口都需要验证凭证，无效时返回 `401`

### 3. 权限矩阵（settings.perms）

初始化向导的"权限设置"步骤会生成一份权限矩阵，**所有权限规则由第一个初始化的人定义**。矩阵中每个键的取值：

- `'admin'`：仅管理员（members 中 `isAdmin: true` 的人）可执行
- `'all'`：任何已登录成员都可执行

| 键 | 控制的操作 |
|---|---|
| createTask / deleteTask | 新建 / 删除任务 |
| assignTask | 指定 / 更换任务负责人 |
| markRework / markDone | 标记需返工 / 验收完成 |
| announce | 发布 / 置顶 / 删除公告 |
| resolveReview | 处理审议意见、标记文档意见已处理 |
| adoptLit | 采纳文献条目 |
| memberManage | 成员改名 / 增删 / 授予撤销管理员 |
| backup | 备份 / 恢复数据 |

> 下文各接口标注的"管理员"，均指该接口对应键为 `'admin'` 时仅限管理员；为 `'all'` 时对所有登录成员开放。**后端必须按 settings.perms 执行校验**，不要写死。始终不变的底线规则：PIN 只能本人设置；只能删自己的评论/意见/附件（或拥有对应管理权限）。

### 4. 状态数据模型

后端需要持久化一份"全量状态"（state）。`GET /api/bootstrap` 会把它整个返回给前端（敏感字段除外）。结构如下：

```jsonc
{
  "setupDone": true,          // 是否已完成初始化
  "settings": {               // 初始化向导保存的配置（前端据此定制界面）
    "title": "期末视频项目工作台",
    "subtitle": "Group Workbench",
    "adminLabel": "队长",          // 管理员的显示称呼
    "modules": { "resources": true, "announcements": true, "lits": false, "reviews": true },
    "perms": {                     // 权限矩阵：每项 'admin'（仅管理员）或 'all'（所有成员）
      "createTask": "admin", "deleteTask": "admin", "assignTask": "admin",
      "markRework": "admin", "markDone": "admin", "announce": "admin",
      "resolveReview": "admin", "adoptLit": "admin",
      "memberManage": "admin", "backup": "admin"
    },
    "lines":  { "c1": "拍摄", "c2": "剪辑", "c3": "其他" },     // 任务分类 key → 名
    "resCats": { "rc1": { "name": "素材", "icon": "🎬" } }      // 资料分类 key → {name,icon}
  },
  "members": [                // 成员
    {
      "id": "m1",
      "name": "张三",
      "role": "组长",          // 显示用角色（自由文本）
      "isAdmin": true,         // 管理员（组长）
      "pinSalt": "ab12..",     // PIN 盐值（不要发给前端）
      "pinHash": "sha256..."   // PIN 哈希（不要发给前端）
    }
  ],
  "tasks": [
    {
      "id": "t1",
      "title": "完成初稿",
      "desc": "具体要求...",
      "line": "writing",            // 任务分类 key，由前端 config.js 定义
      "ddl": "2026-11-01",          // 截止日期，YYYY-MM-DD 或空串
      "assigneeId": "m2",           // 负责人 id，null = 待认领
      "status": "unclaimed",        // unclaimed|doing|review|rework|done
      "order": 1,                   // 排序序号（创建时自增）
      "createdAt": 1730000000000,   // 毫秒时间戳
      "updatedAt": 1730000000000,
      "comments": [                 // 评论区（含系统与返工记录）
        { "id": "c1", "authorId": "m1", "authorName": "张三",
          "content": "...", "ts": 1730000000000,
          "type": "system" }        // 普通|system|rework
      ],
      "attachments": [              // 交付附件（base64 内嵌）
        { "id": "a1", "name": "初稿.docx", "size": 12345,
          "type": "application/...", "dataUrl": "data:...;base64,...",
          "uploadedBy": "m2", "uploadedByName": "李四", "uploadedAt": 1730000000000 }
      ],
      "doc": {                      // 交付文档
        "versions": [               // 版本历史
          { "id": "v1", "num": 1, "content": "# Markdown...",
            "note": "初版", "editorId": "m2", "editorName": "李四", "ts": 1730000000000 }
        ],
        "comments": [               // 文档意见墙（所有人可提）
          { "id": "dc1", "authorId": "m1", "authorName": "张三",
            "quote": "被引用的原文", "content": "意见内容",
            "ts": 1730000000000, "resolved": false }
        ]
      }
    }
  ],
  "resources": [                    // 资料库
    { "id": "r1", "name": "参考.pdf", "size": 999, "type": "application/pdf",
      "cat": "ref", "desc": "说明", "dataUrl": "data:...;base64,...",
      "uploadedBy": "m1", "uploadedAt": 1730000000000 }
  ],
  "announcements": [                // 公告
    { "id": "an1", "title": "周六开会", "body": "Markdown 内容",
      "pinned": true, "authorId": "m1", "authorName": "张三", "ts": 1730000000000 }
  ],
  "literatures": [                  // 文献汇总
    { "id": "l1", "title": "文献题目", "source": "期刊/作者", "note": "推荐理由",
      "authorId": "m2", "authorName": "李四", "ts": 1730000000000,
      "adopted": false,
      "votes": { "m1": "up", "m3": "down" },   // 成员id -> up|down
      "comments": [ { "id": "lc1", "authorId": "m1", "authorName": "张三",
                      "content": "...", "ts": 1730000000000 } ] }
  ],
  "reviews": [                      // 审议意见
    { "id": "rv1", "taskId": "t1", "authorId": "m3", "authorName": "王五",
      "content": "...", "ts": 1730000000000,
      "resolution": "pending",      // pending|accepted|rejected
      "resolvedAt": null, "resolvedBy": null, "adminNote": "" }
  ],
  "dismissed": {                    // 已关闭的提醒 dismissed[成员id][提醒key]=ts
    "m1": { "sun-2026-10-18": 1730000000000 }
  },
  "sessions": { "token123": { "memberId": "m1", "ts": 1730000000000 } }
}
```

> **给前端的 state 一定要剥掉 `pinSalt` / `pinHash` / `sessions`**，并在每个成员上补一个 `pinBound: true/false` 字段（表示是否已设置 PIN）。

---

## 二、接口清单

### 公开接口（无需登录）

#### `GET /api/bootstrap`
拉取全量状态。前端启动时和每 12 秒轮询都会调用。
```json
// 响应
{ "ok": true, "serverTime": 1730000000000, "state": { ...上面模型，去掉敏感字段 } }
```
> `serverTime` 是服务器当前毫秒时间戳，前端用它校准时差（提醒横幅的"周日 20 点"判断依赖它）。

#### `POST /api/setup`
初始化工作台，只能成功调用一次（`setupDone` 已为 true 时返回 403）。第一个打开页面的人自动成为管理员。
```json
// 请求
{ "adminName": "张三", "memberNames": ["李四", "王五"] }   // memberNames 可为空数组
// 响应
{ "ok": true, "state": { ... } }
```

#### `POST /api/auth/bind`
成员首次设置 PIN（每个身份只能设置一次，已设置过返回 403）。
```json
// 请求  { "memberId": "m2", "pin": "1234" }    // pin: 4-8 位数字
// 响应  { "token": "随机长字符串", "me": { "id":"m2", "name":"李四", "role":"组员", "isAdmin":false } }
```
> **PIN（密码）权限完全在个人**：谁的身份谁自己设，管理员既不能查看也不能代设别人的 PIN，只能调用"重置"清掉对方的 PIN（对方下次登录时重新自己设一个）。
> 建议：登录成功时同时 `Set-Cookie: wb_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`，前端即可一年内免登录。
> PIN 存储务必加盐哈希（如 `sha256(salt + ':' + pin)`），**绝不能明文存**。

#### `POST /api/auth/login`
已绑定 PIN 的成员登录。PIN 错误返回 403。请求/响应同 `bind`。

#### `GET /api/auth/me`
返回当前凭证对应的身份；未登录返回 `{ "me": null }`（不要报错）。

#### `POST /api/auth/logout`
注销当前会话。响应 `{ "ok": true }`。

---

### 成员管理（管理员）

#### `POST /api/members`
```json
// 请求  { "name": "赵六", "role": "剪辑" }     // role 可为空
// 响应  { "state": { ...更新后的全量状态（同 bootstrap 的 state） } }
```

#### `PATCH /api/members/:id`
改名/改角色、授予或撤销管理员、或重置 PIN（分开调用）。
```json
// 请求（改信息）    { "name": "张三", "role": "组长" }
// 请求（调整权限）  { "isAdmin": true }    // 授予/撤销管理员；至少保留一名管理员
// 请求（重置PIN）   { "resetPin": true }   // 清除该成员 PIN 并吊销其所有会话
// 响应  { "state": { ... } }
```

#### `DELETE /api/members/:id`
删除成员。规则：管理员不可删；名下还有任务时返回错误。
```json
// 响应  { "state": { ... } }
```

---

### 任务

#### `POST /api/tasks`（管理员）
```json
// 请求
{ "title": "完成初稿", "desc": "要求...",
  "line": "writing", "ddl": "2026-11-01", "assigneeId": "m2" }   // assigneeId 可为 null
// 响应  { "task": { ...新任务完整对象（含空 comments/attachments/doc） } }
```

#### `PATCH /api/tasks/:id`（负责人或管理员）
字段均可选，只更新传入的。**更换 assigneeId 仅管理员**。
```json
// 请求  { "title": "...", "desc": "...", "line": "...", "ddl": "...", "assigneeId": "..." }
// 响应  { "task": { ...更新后的任务 } }
```

#### `DELETE /api/tasks/:id`（管理员）
连带头附件、评论、关联的审议意见一并删除。响应 `{ "ok": true }`。

#### `POST /api/tasks/:id/claim`
认领任务：任何人可认领 `unclaimed` 状态的任务，认领后成为负责人并进入 `doing`。
```json
// 响应  { "task": { ... } }
```
> 建议：自动往 comments 里加一条 `type: "system"` 的记录（"XX 认领了任务"）。

#### `POST /api/tasks/:id/status`（状态流转，权限见下表）
```json
// 请求  { "status": "doing" }
// 请求（转到 rework 时必填意见）  { "status": "rework", "note": "第三章需要重写" }
// 响应  { "task": { ... } }
```

| 目标状态 | 谁可以 | 附加规则 |
|---|---|---|
| doing | 当前为 unclaimed 任何人；rework 时本人或管理员 | — |
| review | 负责人或管理员 | **必须已有附件，或交付文档至少 1 个版本**，否则拒绝 |
| rework | 仅管理员 | `note` 返工意见必填，且应写入评论区（`type: "rework"`） |
| done | 仅管理员 | — |

其余转换（如退回 unclaimed）一律拒绝。

#### `POST /api/tasks/:id/comments`
```json
// 请求  { "content": "进度 50%" }
// 响应  { "task": { ... } }
```
> 评论区仅负责人与管理员可发言，其他人返回 403。

#### `DELETE /api/tasks/:id/comments/:cid`
删自己的评论；管理员可删任何人的。响应 `{ "task": { ... } }`。

#### `POST /api/tasks/:id/attachments`
上传附件（负责人或管理员；任务已 done 拒绝）。
```json
// 请求
{ "name": "初稿.docx", "size": 12345, "type": "application/...",
  "dataUrl": "data:application/...;base64,...." }
// 响应  { "task": { ... } }
```
> 单文件 ≤ 6MB（前端已限制，后端务必再校验：size ≤ 6291456 且 dataUrl 合法）。
> 附件以 base64 存在数据里即可满足模板需求；数据量大时可改存对象存储，把 `dataUrl` 换成下载 URL（前端"下载"按钮直接用这个字段）。

#### `DELETE /api/tasks/:id/attachments/:attId`
上传者或管理员可删。响应 `{ "task": { ... } }`。

---

### 交付文档

#### `POST /api/tasks/:id/doc/versions`（负责人或管理员）
```json
// 请求  { "content": "# 新版本内容（Markdown）", "note": "修改说明（选填）" }
// 响应  { "task": { ... }, "version": { "id":"v2", "num":2, ... } }
```
> 规则：内容为空拒绝；与上一版本完全相同拒绝（返回"内容没有变化"）；`num` 自动递增。

#### `POST /api/tasks/:id/doc/comments`（所有人）
```json
// 请求  { "quote": "被引用的原文（选填，≤200字）", "content": "意见内容" }
// 响应  { "task": { ... } }
```

#### `PATCH /api/tasks/:id/doc/comments/:cid`（管理员）
切换该意见的 `resolved` 布尔值。响应 `{ "task": { ... } }`。

#### `DELETE /api/tasks/:id/doc/comments/:cid`
意见作者或管理员可删。响应 `{ "task": { ... } }`。

---

### 资料库

#### `POST /api/resources`（所有人）
```json
// 请求  { "name": "...", "size": 123, "type": "...", "cat": "ref", "desc": "说明", "dataUrl": "data:..." }
// 响应  { "resource": { ...新资料对象 } }
```
> `cat` 是分类 key，由前端 config.js 定义（后端无需校验具体取值，做基本字符串清洗即可）。

#### `DELETE /api/resources/:id`
上传者或管理员可删。响应 `{ "ok": true }`。

---

### 公告（管理员）

#### `POST /api/announcements`
```json
// 请求  { "title": "周六开会", "body": "Markdown 内容", "pinned": false }
// 响应  { "announcement": { ...新公告 } }
```

#### `PATCH /api/announcements/:id/pin`
切换置顶状态。响应 `{ "announcement": { ... } }`。

#### `DELETE /api/announcements/:id`
响应 `{ "ok": true }`。

---

### 审议意见

#### `POST /api/reviews`（所有人）
```json
// 请求  { "taskId": "t1", "content": "建议把 DDL 提前" }   // taskId 必须存在
// 响应  { "review": { ...新意见，resolution 初始为 "pending" } }
```
> `authorId` / `authorName` 必须由后端从会话里取，**不能信请求体里的**（前端也不传）。

#### `PATCH /api/reviews/:id`（管理员）
```json
// 请求  { "resolution": "accepted", "adminNote": "备注说明" }   // pending|accepted|rejected
// 响应  { "review": { ... } }
```
> 设为 accepted/rejected 时记录 `resolvedAt` / `resolvedBy`；改回 pending 时清空。

---

### 文献汇总

#### `POST /api/literatures`（所有人）
```json
// 请求  { "title": "文献题目（必填）", "source": "来源（选填）", "note": "推荐理由（选填）" }
// 响应  { "item": { ...新条目 } }
```
> 题目查重：与已有条目（忽略大小写、首尾空格）重复时返回错误。

#### `PATCH /api/literatures/:id`
```json
// 请求（投票，所有人；再点同方向 = 取消投票）  { "action": "vote", "vote": "up" }   // up|down
// 请求（采纳，管理员，切换状态）              { "action": "adopt" }
// 响应  { "item": { ... } }
```

#### `DELETE /api/literatures/:id`
提交者或管理员可删。响应 `{ "ok": true }`。

#### `POST /api/literatures/:id/comments`（所有人）
```json
// 请求  { "content": "值得一读，用在第二章" }
// 响应  { "item": { ... } }
```

#### `DELETE /api/literatures/:id/comments/:cid`
评论作者或管理员可删。响应 `{ "item": { ... } }`。

---

### 其他

#### `POST /api/reminders/dismiss`
当前登录成员关闭一条提醒。
```json
// 请求  { "key": "sun-2026-10-18" }   // 提醒 key，原样记录即可
// 响应  { "ok": true }
```

#### `GET /api/backup`（管理员）
导出全部数据（含附件与 **pinSalt/pinHash**——恢复备份必须带上，否则恢复后所有人都要重设 PIN；不含会话）。
```json
// 响应  { "state": { ...全量状态（比 bootstrap 多 PIN 字段，妥善保管备份文件） } }
```

#### `POST /api/restore`（管理员）
用备份覆盖当前全部数据。**建议保留现有 sessions**（恢复后大家不用重新登录），并对各字段做类型清洗。
```json
// 请求  { "state": { ...备份文件里解析出的对象 } }
// 响应  { "state": { ...恢复后的状态 } }
```

---

## 三、实现要点清单（后端自查）

- [ ] 所有写接口都做了**权限校验**（401 未登录 / 403 越权），不要只依赖前端隐藏按钮
- [ ] 权限按 `settings.perms` 动态执行（初始化者定的规则），不要在后端写死"仅管理员"
- [ ] PIN 加盐哈希存储，明文不落盘、不外发
- [ ] 附件与请求体大小限制（单文件 6MB；请求体建议 ≤ 10MB，base64 会膨胀约 33%）
- [ ] `authorId`、`authorName` 一律从会话取，不信任请求体
- [ ] 状态流转规则在后端强制执行（尤其 review 需先有附件/文档；rework 需 note）
- [ ] 数据持久化：写盘建议"先写临时文件再改名"，避免断电写坏
- [ ] 同源部署（或配好 CORS）；`bootstrap` 是全量拉取，数据量大时可自行改造成增量
