# 保姆级部署教程：从零把工作台跑起来，拿到能发给组员的网址

> 本教程面向完全没碰过命令行的同学。跟着做，每一步都有"在哪里输入、会看到什么"。
>
> 两种方案任选其一：
>
> - **方案一：Render + Supabase（推荐）** —— 免费长期用，网址 24 小时在线，**数据重启不丢**
> - **方案二：自己电脑当服务器** —— 10 分钟搞定，但电脑关机网站就下线（试玩 / 临时用）

---

## 第 0 步：下载代码（两种方案都要做）

打开你保存这个项目的 GitHub 仓库页面，点绿色的 **`<> Code`** 按钮 → **Download ZIP** → 解压到你能找到的地方（下文假设解压在 `D:\group-workbench`）。

> 如果你就是仓库主人：也可以不用下载，直接用你本地那份完整文件夹（必须包含 `server.js` 和 `public` 文件夹）。

---

## 方案一：Render + Supabase（推荐：免费长期用，数据不丢）

适合：想要一个 24 小时在线的固定网址，数据放在专业数据库里——平台重启、重新部署、清空磁盘，**数据都不丢**。

原理一句话：**Render 负责"跑程序 + 给你网址"，Supabase 负责"存数据"**。两家都有免费档，小组用绰绰有余。

### 1. 把代码传到 GitHub（Render 从 GitHub 拉代码）

1. 注册/登录 **https://github.com**
2. 右上角 + → **New repository**，名字随意（如 `group-workbench`），选 **Private**（私有，只有你能看）→ Create
3. 在你的项目文件夹（含 `server.js` 的那层）打开 cmd，执行：

```
git init
git add .
git commit -m "init"
git remote add origin https://github.com/你的用户名/group-workbench.git
git push -u origin master
```

> Windows 没装 git 的话先去 **https://git-scm.com** 下载安装（一路 Next）。

### 2. 注册 Supabase 并建项目（它来存数据）

1. 打开 **https://supabase.com** → Get Started → 用 GitHub 账号登录
2. Dashboard 点 **New project**：名字随意（如 `workbench-db`），数据库密码随意，Region 选 **Singapore** → Create new project，等 2 分钟初始化完成

### 3. 建表（复制粘贴一次，30 秒）

SQL 已经在仓库里给人写好了，你只需要复制粘贴，一个字都不用改：

1. 左侧竖排菜单点 **SQL Editor**（图标像终端窗口）
2. 点 **New query**，出现一个大输入框
3. 打开仓库里的 `backend/supabase/schema.sql` 文件，复制它的**全部内容**（两种方式任选）：
   - **下载了 ZIP 的**：进解压后的文件夹 → `backend` → `supabase` → 右键 `schema.sql` → 打开方式 → **记事本** → 在记事本里按 `Ctrl+A` 全选 → `Ctrl+C` 复制
   - **直接看 GitHub 网页的**：点进仓库的 `backend/supabase/schema.sql` → 点代码块右上角的**复制按钮**（两个小方块图标）
4. 回到 Supabase 的大输入框，`Ctrl+V` 粘贴（内容较长，一百多行，粘贴完用滚轮拉到底确认没截断）
5. 点右下角 **RUN**，看到 **Success. Rows affected** 之类的绿色提示 = 建好了

> 建错了也不怕：这段脚本可以**重复执行**（表已存在会跳过），粘错了就清空输入框重来一遍。

### 4. 拿服务端密钥

1. 左侧点 **Project Settings**（齿轮图标）→ **API**
2. 复制两样东西，先存到记事本：
   - **Project URL**（形如 `https://abcdxxxx.supabase.co`）
   - **service_role key**（一长串密钥。注意是 **service_role**，**不是** anon！新版界面可能写作 `service_role (secret)`，点旁边的 **Reveal** 按钮显示后再复制）

> ⚠️ **service_role key 等于你数据库的最高权限**：只填进下一步 Render 的环境变量里，绝不写进代码、不发到群里、不给任何人。

### 5. 在 Render 创建服务（跑程序）

1. 打开 **https://render.com** → Get Started → 用 GitHub 账号登录（会请求授权，同意）
2. Dashboard 点 **New +** → **Web Service** → 在列表里选中你刚推上去的仓库 → Connect
3. 填配置：

| 配置项 | 填什么 |
|---|---|
| Name | 随意，会成为网址的一部分（如 `my-workbench`） |
| Region | Singapore（离国内最近） |
| Branch | `master`（或 `main`，看你仓库默认分支） |
| Runtime | **Node** |
| Build Command | `npm install @supabase/supabase-js`（本方案唯一需要安装的第三方包，几十秒装完） |
| Start Command | `node server.js` |
| Instance Type | **Free** |

4. **关键一步**：往下找到 **Environment Variables**，添加四条：

| Key | Value |
|---|---|
| `STORAGE` | `supabase` |
| `SUPABASE_URL` | 刚才的 Project URL |
| `SUPABASE_SERVICE_KEY` | 刚才的 service_role key |
| `SETUP_KEY` | 自己生成的一串随机初始化密钥，只首次配置使用，不要发到组员群 |

5. 点 **Create Web Service**，等几分钟部署完成

### 6. 拿到网址

部署完成后，页面顶部会出现你的专属网址，格式如：

```
https://my-workbench.onrender.com
```

这就是登录地址。先自己打开，用刚才设置的 `SETUP_KEY` 完成初始化，再把网址发到组员群。组员任何网络都能打开，你的电脑开不开机都无所谓。

### 7. 验证数据真的存在 Supabase（强烈建议做一次）

1. 打开你的 Render 网址，在初始化向导第一步填写 `SETUP_KEY`，完成配置后随便建一个任务
2. 回到 Supabase 控制台 → 左侧 **Table Editor** → 点 **tasks** 表 → 能看到你刚建的任务 = 数据落库成功
3. **终极测试**：Render 控制台点 Manual Deploy → Restart，刷新网址，数据和登录状态还在 = 配置成功，从此不怕重启

### 方案一的注意事项（提前知道）

- **关于休眠**：免费档在**连续 15 分钟没人访问**时会休眠；一旦有人访问会**自动唤醒**（不需要手动激活），只是唤醒后第一个人要多等 30 秒左右。**正在使用的期间不会休眠**
- **Render 清盘/重启/重新部署，数据都安全在 Supabase** —— 这正是本方案存在的意义
- Supabase 免费项目**长期不活动**可能被暂停（以官网说明为准）：dashboard 点 **Restore** 一键恢复，数据不丢；建议每周打开一次 Supabase 控制台保活
- 免费档数据库 500MB：纯文字够用很久；附件以 base64 存在库内，6MB 上限的文件传几十个就到顶了——**大文件请走网盘链接**，数据量大了以后可迁移 Supabase Storage（进阶操作）
- 依旧建议定期「📥 备份」：Supabase 也是别人的服务器，多一重本地保险永远不亏

---

## 方案二：用自己电脑当服务器（备用：试玩 / 临时用）

适合：小组作业当天临时用一下，电脑开着的时候大家才能访问。**数据只存在你电脑里**。

### 1. 安装 Node.js（一次性，5 分钟）

1. 打开官网 **https://nodejs.org**
2. 点左边的大绿色按钮下载 **LTS 版本**（长期支持版），得到一个 `.msi` 文件
3. 双击安装，**一路点 Next**，全部默认，不用改任何选项，最后点 Finish
4. 验证装好了没有：按键盘 `Win + R`，输入 `cmd` 回车，弹出黑色窗口，输入：

```
node -v
```

   回车。看到 `v22.x.x`（或更高）之类的版本号 = 成功。报"不是内部或外部命令" = 安装没完成，重启电脑再试。

### 2. 启动工作台（1 分钟）

还是在那个黑色窗口（cmd）里，输入（把路径换成你自己的解压位置）：

```
cd /d D:\group-workbench
node server.js
```

> 💡 技巧：输入 `cd /d ` 后面跟一个空格，然后把文件夹直接拖进黑窗口，路径自动填上，回车即可。

看到这样的输出就是成功了：

```
  小组作业工作台已启动
  本机访问:   http://localhost:3000
  局域网访问: http://你的电脑名:3000 （组员连同一 WiFi 可访问）
  存储模式:   file（数据存 ...\data）
  初始化密钥: 一串随机字符（仅首次初始化需要）
```

**保持这个黑窗口开着不要关**（关了网站就下线了）。想最小化可以，别点 × 。

### 3. 自己先打开看看

浏览器地址栏输入：

```
http://localhost:3000
```

能出现初始化向导 = 一切正常。把黑窗口里的**初始化密钥**填进第一步，然后由你完成向导。密钥不要发到组员群。

### 4. 查到你的网址（发给组员用）

`localhost` 只有你自己能打开，组员需要你的**局域网 IP**：

1. 按 `Win + R`，输入 `cmd` 回车
2. 输入：

```
ipconfig
```

3. 在输出里找 **IPv4 地址**（通常在"无线局域网适配器 WLAN"下面），长这样：

```
IPv4 地址 . . . . . . . . . . . . : 192.168.1.100
```

4. 你的网址就是 **`http://192.168.1.100:3000`**（把 IP 换成你查到的）

把这个网址发到小组群里，组员**连上和同一个 WiFi** 后浏览器打开即可。

### 5. 组员打不开？（防火墙放行，一次性）

Windows 第一次运行 Node 时会弹"是否允许访问网络"——必须点**允许**。如果当时点错了，或者组员还是打不开：

1. 按 `Win` 键，输入"防火墙"，打开 **Windows Defender 防火墙** → 左侧 **高级设置**
2. 左侧点 **入站规则** → 右侧 **新建规则**
3. 选 **端口** → 下一步 → 选 **TCP**，输入 **3000** → 下一步
4. 选 **允许连接** → 一路下一步，名字随便填（如 workbench）→ 完成

还不行的话，80% 是不在同一个 WiFi（校园网经常隔离设备，可用手机开热点让全组连）。

### 方案二的坑（提前知道）

- 电脑睡眠/关机 = 网站下线。设置里把睡眠改成"从不"（接电源时）
- 换了 WiFi（比如从宿舍网换到手机热点）IP 会变，网址要重新查、重新发
- 数据存在 `data\state.json`，**记得让管理员定期用页面右上角「📥 备份」导出文件**

---

## 常见问题

**Q：两种方案能混用吗？**
能。先用方案二在自己电脑上试玩，正式使用时迁到方案一（迁移 = 在旧站点「📥 备份」下载 JSON → 到新站点「📤 恢复」导入，数据和登录配置都跟着走）。

**Q：忘了 PIN 怎么办？**
登录页选不了身份、进不去时：找管理员 → 页面右上角「👤 成员」→ 对你的名字点「重置PIN」→ 你下次登录重新设一个新的。

**Q：黑窗口里 node server.js 报错 `Error: listen EADDRINUSE`？**
端口 3000 被别的程序占了。换个端口启动：

```
set PORT=3001
node server.js
```

网址里的 3000 也要相应改成 3001。

**Q：苹果电脑能用方案二吗？**
能。Node.js 官网下载 Mac 版安装；终端（访达 → 应用程序 → 实用工具 → 终端）里 `cd` 到项目目录后 `node server.js`；查 IP 用 `ifconfig | grep inet`；Mac 防火墙在 系统设置 → 网络 → 防火墙。

**Q：不想让任何代码出现在自己电脑上？**
那连方案二都不用——直接走方案一，全程在 GitHub / Render / Supabase 三个网页上操作，你的电脑只用来打开浏览器。
