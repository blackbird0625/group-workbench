-- ============================================================
-- 小组作业工作台 · Supabase 表结构（配合 STORAGE=supabase 使用）
-- 用法：Supabase 控制台 → SQL Editor → New query → 粘贴本文件全部内容 → RUN
-- ------------------------------------------------------------
-- 设计约定：
--   * 每表的 data JSONB 列是应用读写的完整行数据（权威来源）；
--     其余命名列只是常用字段的镜像，便于人工查表，应用不依赖它们
--   * 附件以 base64 存在 tasks.data / resources.data 里
--     （免费档 500MB 数据库够小组用；大文件建议贴网盘链接，
--      未来版本可迁移 Supabase Storage 对象存储）
--   * 全部表开启 RLS 且不建任何 policy：anon / authenticated 一概
--     读不到，只有持有 service_role key 的服务端（server.js）能访问
-- ============================================================

-- 全局设置：初始化向导保存的 {title, subtitle, adminLabel, modules, perms, lines, resCats}
create table if not exists settings (
  id          int primary key default 1,             -- 恒为 1，单行
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
insert into settings (id, data) values (1, '{}')
  on conflict (id) do nothing;

-- 成员：pin_salt / pin_hash 只在服务端参与校验，任何接口都不外发
create table if not exists members (
  id         text primary key,
  name       text,
  role       text,
  is_admin   boolean not null default false,
  pin_salt   text,
  pin_hash   text,
  data       jsonb not null default '{}'::jsonb,     -- 完整成员对象（权威）
  updated_at timestamptz not null default now()
);

-- 任务：comments（评论区/系统记录）、attachments（含 base64 dataUrl）、
-- doc（版本历史 + 意见墙）按 API.md 模型整体存 JSONB 列
create table if not exists tasks (
  id          text primary key,
  title       text,
  line        text,                                  -- 任务分类 key（初始化向导自定义）
  ddl         text,                                  -- YYYY-MM-DD 或 null
  assignee_id text,
  status      text not null default 'unclaimed',     -- unclaimed|doing|review|rework|done
  sort_order  int not null default 0,
  comments    jsonb not null default '[]'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  doc         jsonb not null default '{"versions":[],"comments":[]}'::jsonb,
  data        jsonb not null default '{}'::jsonb,    -- 完整任务对象（权威）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 资料库
create table if not exists resources (
  id          text primary key,
  name        text,
  cat         text,
  uploaded_by text,
  data        jsonb not null default '{}'::jsonb,    -- 含 base64 dataUrl、desc
  uploaded_at timestamptz not null default now()
);

-- 公告
create table if not exists announcements (
  id        text primary key,
  title     text,
  pinned    boolean not null default false,
  author_id text,
  data      jsonb not null default '{}'::jsonb,      -- 含 body（Markdown）、authorName
  ts        timestamptz not null default now()
);

-- 文献汇总：votes {成员id: up|down}、comments 审稿意见
create table if not exists literatures (
  id        text primary key,
  title     text,
  adopted   boolean not null default false,
  author_id text,
  votes     jsonb not null default '{}'::jsonb,
  comments  jsonb not null default '[]'::jsonb,
  data      jsonb not null default '{}'::jsonb,
  ts        timestamptz not null default now()
);

-- 审议意见
create table if not exists reviews (
  id         text primary key,
  task_id    text,
  author_id  text,
  resolution text not null default 'pending',        -- pending|accepted|rejected
  data       jsonb not null default '{}'::jsonb,     -- 含 content、adminNote、resolvedBy
  ts         timestamptz not null default now()
);

-- 已关闭的提醒：dismissed[成员id][提醒key] = 毫秒时间戳
create table if not exists dismissed (
  member_id text not null,
  key       text not null,
  ts        bigint not null default 0,
  primary key (member_id, key)
);

-- 会话令牌（API.md 状态模型的一部分，仅服务端读写）
create table if not exists sessions (
  token     text primary key,
  member_id text not null,
  ts        bigint not null default 0
);

-- 安全：全部表开启行级安全且不建 policy —— anon / authenticated 全部拒绝，
-- 只有 service_role（服务端持有）可读写。service_role key 等于数据库最高权限，
-- 只能放进部署平台的环境变量，绝不写进代码、不发给任何人。
alter table settings      enable row level security;
alter table members       enable row level security;
alter table tasks         enable row level security;
alter table resources     enable row level security;
alter table announcements enable row level security;
alter table literatures   enable row level security;
alter table reviews       enable row level security;
alter table dismissed     enable row level security;
alter table sessions      enable row level security;

-- 常用查询索引（可选，量小时无感）
create index if not exists tasks_status_idx   on tasks (status);
create index if not exists tasks_assignee_idx on tasks (assignee_id);
create index if not exists reviews_task_idx   on reviews (task_id);
