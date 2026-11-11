# FeedNest · 自托管 RSS 订阅服务器

参考 [Feedbro](https://nodetics.com/feedbro) 的三栏阅读体验做的**多用户**自托管 RSS/Atom 阅读器：**Docker 一键启动，浏览器访问 `http://localhost:13786`**，订阅数据存在服务端 SQLite 里，支持登录鉴权、多账号数据隔离、OPML 导入 / 导出、定时与手动刷新、文件夹分组、未读计数、收藏、搜索、多种列表视图。

```
┌──────────────────────────────────────────────────────────────┐
│  FeedNest        [刷新] [添加订阅] [导入] [导出] [主题] [设置] │
├────────────┬──────────────────────┬──────────────────────────┤
│ 全部 / 未读 │  文章列表             │  阅读区（正文渲染）        │
│ 收藏夹      │  标题 / 摘要 / 缩略图  │  收藏 · 标未读 · 原文      │
│ ▾ 文件夹    │                      │                          │
│   · 订阅源  │                      │                          │
└────────────┴──────────────────────┴──────────────────────────┘
```

## 功能

- **多用户 + 登录鉴权**：默认管理员 `admin / admin`；每个账号的订阅、文件夹、已读状态、收藏完全独立；管理员可新增用户、重置密码、禁用/删除账号、调整角色
- **三栏布局**：左侧订阅树（文件夹 + 未读数）、中间文章列表、右侧正文阅读区
- **三种列表视图**：摘要 / 紧凑 / 卡片
- **订阅管理**：添加（自动发现 RSS 地址）、重命名、移动文件夹、删除、右键菜单
- **OPML 导入导出**：兼容 Feedbro / Feedly / Inoreader 等，导入时自动跳过已存在的源（按当前账号判重）
- **刷新**：手动刷新全部 / 当前文件夹 / 单个订阅，后台按间隔自动刷新（默认 30 分钟）
- **订阅状态面板**：点侧栏底部的「N 个订阅 · M 篇未读」可看到每个源的抓取状态、文章数、失败原因，并可单独重试
- **阅读状态**：未读标记、全部标为已读、收藏、搜索标题与摘要
- **正文渲染**：服务端解析 RSS/Atom 全文，前端做白名单清洗后在沙箱 iframe 中渲染，脚本一律不执行
- **PushPlus 推送**：设置里填 Token 并「测试」，之后订阅发现新文章会推送到微信（每次刷新最多汇总 10 条）
- **数据管理**：一键「清空所有订阅」（只影响当前账号）；管理员可「初始化设置」——清空所有账号的订阅并把管理员密码恢复为 admin
- **主题**：浅色 / 深色 / 护眼，偏好存在浏览器本地
- **移动端**：窄屏自动变为单栏 + 抽屉式订阅列表 + 全屏阅读

## 账号与权限

| 能力 | 管理员 | 普通用户 |
| --- | --- | --- |
| 管理自己的订阅 / 文件夹 / 已读 / 收藏 | ✅ | ✅ |
| 修改自己的密码 | ✅ | ✅ |
| 新增用户、重置他人密码、禁用/删除用户、调整角色 | ✅ | ❌（接口返回 403） |
| 查看其他用户的订阅与文章 | ❌（数据按 `user_id` 隔离） | ❌ |

实现要点：

- 密码用 `scrypt`（N=16384, r=8, p=1）+ 每账号随机盐哈希存储，登录用 `timingSafeEqual` 比对
- 会话是 30 天的 HttpOnly Cookie（`SameSite=Lax`，HTTPS 下自动加 `Secure`），服务端只存 token 的 SHA-256
- 改密码 / 重置密码 / 禁用账号会立即销毁该用户的所有会话
- 登录失败 6 次锁定 1 分钟（按 IP + 用户名）
- 非 GET 请求校验 `Origin`，防止 CSRF
- 系统至少保留一个可用管理员，不能删除/降级/禁用最后一个 admin

> 首次启动（或从旧版本升级）会自动创建 `admin / admin`，旧版本的订阅会全部归到该账号名下；登录后顶部会提示尽快改密码。

## 快速开始（Docker）

```bash
cd feednest
docker-compose up -d --build
# 或者：docker compose up -d --build
```

打开 <http://localhost:13786>。

- 端口固定为 `13786`（`docker-compose.yml` 的 `ports` 与容器内 `PORT` 都设好了）
- 数据目录挂载在本机 `./feednest/data`，删掉这个目录即可重置
- **新部署默认是空的**：没有订阅、没有文章，登录后点「导入」选择自己的 OPML 即可（`seed/` 里那份只是示例，不会自动导入）

### 国内网络 / 代理

GitHub Releases 这类源在国内需要代理。容器里的 `127.0.0.1` 指向容器自己，所以要用 `host.docker.internal` 指向宿主机：

```yaml
    environment:
      - HTTPS_PROXY=http://host.docker.internal:10808
      - HTTP_PROXY=http://host.docker.internal:10808
```

改完 `docker-compose up -d` 重建即可。设置弹窗里能看到当前生效的代理地址。

### 不用 Docker（本机直跑）

需要 Node.js ≥ 22.5（用到了内置 `node:sqlite`）：

```bash
cd feednest
npm install
npm start          # 默认 http://localhost:13786
```

环境变量：`PORT`（默认 13786）、`DATA_DIR`（默认 `./data`）、`HTTPS_PROXY`。

## 使用说明

| 操作 | 说明 |
| --- | --- |
| 登录 | 首次用 `admin / admin`；登录后点右上角头像可「修改密码」 |
| 用户管理 | 管理员点头像 →「用户管理」：新增用户、重置密码、设为/取消管理员、禁用、删除 |
| 添加订阅 | 粘贴 RSS/Atom 地址，或直接粘贴网站首页（自动找订阅链接），先「检测」再保存 |
| 导入 OPML | 顶部「导入」，支持拖拽 `.opml` 文件；重复的源自动跳过 |
| 导出 OPML | 顶部「导出」，文件名 `feednest-subscriptions-日期.opml`，可直接导入 Feedbro |
| 右键订阅 / 文件夹 | 刷新、重命名、删除、全部标为已读 |
| 快捷键 | `J`/`K` 上下篇，`M` 切换已读，`S` 收藏，`R` 刷新，`U` 只看未读，`/` 搜索，`Esc` 关闭 |
| PushPlus 推送 | 设置 → 填 Token → 点「测试」收到微信消息 → 勾选「启用」保存；有新文章时推送标题+链接列表 |
| 清空所有订阅 | 设置 → 「清空所有订阅」，输入「清空」确认；只删除当前账号的订阅/文件夹/文章 |
| 初始化设置 | 设置 → 「初始化设置」（仅管理员），输入 `RESET` 确认；清空所有账号的订阅、重置偏好、所有人退出登录、管理员密码恢复 `admin` |

## 1Panel 离线部署

服务器不能上外网、或者用 1Panel 面板管理时，用离线包：`1panel/dist/feednest-1panel-v1.2.0.zip`（约 60 MB）。

包里是一个镜像 + 安装脚本，**解压后**长这样：

```
feednest-1panel-v1.2.0/
├─ feednest-1.2.0.image.tar     ← ★ 镜像，1Panel「导入镜像」选这个
├─ 1panel-app/feednest/         ← 1Panel 本地应用
├─ load-image.sh / install.sh / uninstall.sh
└─ docker-compose.yml
```

```bash
cd /opt
unzip feednest-1panel-v1.2.0.zip
cd feednest-1panel-v1.2.0
./load-image.sh        # ① 导入镜像并校验
./install.sh           # ② 启动，默认 13786；可 ./install.sh 8080
```

在 1Panel 图形界面里装：

1. **容器 → 镜像 → 导入**，选解压目录里的 `feednest-1.2.0.image.tar`
   （⚠️ 别把 `.zip` 丢进去，那不是镜像，会报 `unrecognized image format`）
2. 把 `1panel-app/feednest` 整个目录复制到 `<1Panel安装目录>/resource/apps/local/feednest/`
3. **应用商店** → 勾选「显示本地应用」→ **更新应用列表** → 安装 FeedNest

详细步骤和排查清单见 [`1panel/README.md`](1panel/README.md)。
改了代码重新打包：`cd 1panel && ./build-package.sh`（需要本地已有 `feednest:1.2.0` 镜像）。

## 部署到 Cloudflare（Workers / Pages）

同一份业务代码（`serverless/`）+ D1 数据库，两种部署形态：

- **命令行部署**：见 [`cloudflare/README.md`](cloudflare/README.md)
- **纯网页部署**（不装 Node、不敲命令，全程控制台 + GitHub 网页）：见 [`cloudflare/WEB-DEPLOY.md`](cloudflare/WEB-DEPLOY.md)

| 方案 | 组成 | 定时刷新 | 部署命令 |
| --- | --- | --- | --- |
| **Workers**（推荐） | 一个 Worker：静态资源 + `/api` + Cron | ✅ 每 10 分钟 | `cd cloudflare/worker && npx wrangler deploy` |
| **Pages** | Pages 静态托管 + Pages Functions | ❌ 无 Cron，打开页面时补刷 | `cd cloudflare/pages && node build.mjs && npx wrangler pages deploy` |

三步上手（两套方案通用）：

```bash
cd cloudflare/worker
npx wrangler login
npx wrangler d1 create feednest-db          # 把返回的 database_id 填进两个 wrangler.jsonc
npx wrangler d1 execute feednest-db --remote --file=../../serverless/schema.sql
npx wrangler deploy                          # 打开输出的 workers.dev 地址，admin/admin 登录
```

> 云端版和 Docker 版是两套数据层（D1 / SQLite），订阅可以用 OPML 互相搬，账号密码不通用。
> 免费版每次调用最多 50 个子请求，所以刷新按批进行（默认 45 个/次，`MAX_FEEDS_PER_RUN` 可调）。

## 订阅源很多时（几十 → 几千）

刷新不是「每次从头扫一遍」，而是**按最久未刷新的顺序轮转**：

- 服务端每轮只取 `last_fetch_at` 最早的一批（Node 默认 200 个/轮，Cloudflare 默认 45 个/轮）
- 同一个域名最多 2 个并发请求，几百个源都挂在 GitHub 上时也不会把对方刷到限流
- 前端点一次「刷新」会自动接着跑完剩余批次，直到全部覆盖，不会只刷前 45 个
- 定时任务同样按这个顺序轮转，源再多也不会出现「某些源永远刷不到」

容量参考（Cloudflare）：

| 源数量 | 免费版（45/次，cron 每 10 分钟） | 付费版（`MAX_FEEDS_PER_RUN=500`，cron 每 10 分钟） |
| --- | --- | --- |
| 100 个 | 约 25 分钟轮完一圈 | 约 2 分钟 |
| 500 个 | 约 2 小时 | 约 10 分钟 |
| 2000 个 | 约 7.5 小时（建议付费） | 约 40 分钟 |

建议：

- 源超过 300 个时，把「设置 → 每个订阅保留文章数」调到 100~200，控制 D1 体积（5GB 免费额度下 1000 个源 × 150 篇约 30 万行，很宽松）
- Cloudflare 免费版每天 10 万行写入，首次导入 1000 个源（约 1 万篇）没问题，但别反复删库重导
- 源特别多（2000+）建议用 Docker 版自建，没有子请求限制，一轮能刷完

## 技术栈

- 后端（自建/Docker）：Node.js 22 + 内置 `node:sqlite`（无需编译原生模块），`fast-xml-parser` 解析 RSS 2.0 / Atom / RDF，`undici` 负责抓取与代理
- 后端（Cloudflare）：Workers 运行时 + D1，同一套业务逻辑（`serverless/core.js`），WebCrypto PBKDF2 密码哈希
- 鉴权：`scrypt`（Node）/ PBKDF2（Workers）密码哈希 + 服务端会话表 + HttpOnly Cookie
- 抓取策略：ETag / If-Modified-Since 条件请求，304 不重复入库；失败按指数退避重试；每个源默认保留最新 300 篇
- 前端：原生 JS + CSS，无构建步骤，单页三栏
- 数据表：`users` / `sessions` / `folders` / `feeds` / `items` / `settings`（后三张都带 `user_id` 隔离）

## HTTP 接口（前端用的就是这些）

除登录接口外，全部需要登录态 Cookie；`/api/users*` 仅管理员可用。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` · `/api/auth/logout` | 登录 / 退出 |
| GET | `/api/auth/me` | 当前登录用户（未登录返回 `{user:null}`） |
| POST | `/api/auth/password` | 修改自己的密码（需旧密码，改完强制重新登录） |
| GET/POST | `/api/users` | 用户列表 / 新增用户（管理员） |
| PATCH/DELETE | `/api/users/:id` | 重置密码、改角色、禁用、删除（管理员） |
| GET | `/api/state` | 文件夹、订阅、未读数、设置、刷新进度 |
| GET | `/api/items?scope=all\|starred\|feed:<id>\|folder:<id>&unread=1&q=&sort=&limit=&offset=` | 文章列表 |
| GET | `/api/items/:id` | 单篇正文 |
| POST | `/api/items/:id/read` · `/star` | 标记已读 / 收藏 |
| POST | `/api/mark-read` | 按 scope 全部标为已读 |
| POST | `/api/feeds` · `/api/feeds/preview` | 添加订阅 / 仅检测 |
| PATCH/DELETE | `/api/feeds/:id` | 改名、移动、删除 |
| POST | `/api/feeds/:id/refresh` | 刷新单个订阅 |
| POST | `/api/folders`、`PATCH/DELETE /api/folders/:id` | 文件夹增删改 |
| GET/POST | `/api/opml` | 导出 / 导入 OPML（只含当前账号） |
| POST | `/api/refresh` | 启动刷新（`{scope:"all"\|"feed:id"\|"folder:id"}`） |
| GET | `/api/refresh/status` | 刷新进度 |
| POST | `/api/settings` | 刷新间隔、保留篇数（按账号保存） |
| POST | `/api/push/test` | 用给定（或已保存的）Token 发一条 PushPlus 测试消息 |
| POST | `/api/subscriptions/clear` | 清空当前账号的全部订阅 / 文件夹 / 文章 |
| POST | `/api/admin/reset` | 初始化（管理员）：清空所有订阅、重置设置、管理员密码恢复 admin，body 需 `{"confirm":"RESET"}` |
| GET | `/api/health` | 健康检查（容器 / 反代探活用） |

## 目录结构

```
feednest/
├─ server/         自建 / Docker 版后端（Node + node:sqlite）
│  ├─ index.js     HTTP 服务、路由、鉴权、静态资源
│  ├─ db.js        SQLite 表结构、用户与会话、按用户隔离的查询、版本迁移
│  ├─ parser.js    RSS/Atom/RDF 解析、HTML 发现订阅、清洗
│  ├─ net.js       抓取（代理、条件请求、编码识别）
│  ├─ feeds.js     刷新调度、并发控制、进度
│  └─ opml.js      OPML 导入导出
├─ serverless/     Cloudflare 版后端（Workers + D1，复用 server/parser.js）
│  ├─ core.js      路由与全部接口
│  ├─ db.js        D1 数据层
│  ├─ auth.js      PBKDF2 + 会话
│  ├─ feed.js      抓取与刷新（分批，适配子请求上限）
│  ├─ worker.js    Workers 入口（fetch + scheduled）
│  └─ schema.sql   D1 建表语句
├─ public/         前端（两边共用）index.html / app.css / app.js
├─ seed/           示例 OPML（不会自动导入，需要时在页面里手动导入）
├─ data/           SQLite 数据（挂载卷）
├─ cloudflare/     Cloudflare 部署配置（worker / pages）
├─ 1panel/         1Panel 离线包（应用定义 + 打包脚本 + dist/）
├─ Dockerfile
└─ docker-compose.yml
```

> 安全提示：暴露到公网前请先改掉 `admin` 默认密码；服务自身已带登录与 CSRF 防护，但没有速率限制之外的 WAF 能力，公网部署建议再套一层 Cloudflare 或 Nginx Basic Auth。
