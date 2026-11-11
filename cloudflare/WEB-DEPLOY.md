# 纯网页部署（不用命令行）

不想装 Node、不用敲 `wrangler` 的话，可以全程在 Cloudflare 控制台 + GitHub 网页上完成部署。
下面两条路线任选一条，**Workers 那条更简单**（自带定时刷新）。

整个过程只需要三样东西：

1. 代码放到 GitHub（网页上传即可）
2. 一个 D1 数据库（控制台点一下创建）
3. 一个 Worker 或 Pages 项目（控制台连接仓库，自动构建）

---

## 第 0 步：把代码放到 GitHub

已经有仓库、或者会用 GitHub Desktop 的，可以跳过。

1. 打开 <https://github.com/new>，新建一个仓库（Private 也行），名字随意，**不要**勾选 "Add a README file"。
2. 进入仓库 → **Add file** → **Upload files**。
3. 打开本地的 `feednest` 文件夹，**只选下面这些**拖进去（共 28 个文件 / 约 400 KB）：

   | 必须 | 说明 |
   | --- | --- |
   | `serverless/` | 云端版后端（**必须有**） |
   | `public/` | 前端页面（**必须有**） |
   | `cloudflare/` | 部署配置和 Pages Functions（**必须有**） |
   | `package.json` | 依赖声明，构建时用它装 wrangler（**必须有**） |
   | `package-lock.json` | 锁定版本，**必须有** |
   | `server/` | Docker 版后端，云端用不到但留着无妨 |
   | `seed/` | 示例 OPML（不会自动导入，可留可删） |
   | `Dockerfile`、`docker-compose.yml`、`README.md` | 可选 |

   ⚠️ **千万不要整个文件夹拖进去**：`node_modules/` 有十几万个文件，GitHub 网页上传会直接卡死或报错。
   同样不要传 `data/`（数据库）、`.shots/`、`.wrangler/`、`*.db`。

4. 底部点 **Commit changes**。

> 上传后仓库根目录应该能看到 `serverless`、`public`、`cloudflare`、`package.json` 这几项。
> 如果多套了一层 `feednest/` 文件夹，后面填 Root directory 时要带上这一层。

---

## 第 1 步：创建 D1 数据库（控制台）

1. 打开 <https://dash.cloudflare.com> → 左侧 **Storage & Databases** → **D1 SQL Database**（有的版本叫 **Workers & Pages → D1**）。
2. **Create database** → 名字填 `feednest-db` → 创建。
3. 创建完成后复制页面上那串 **Database ID**（形如 `a1b2c3d4-....`），下一步要用。
4. 进入这个数据库 → 上方 **Console** 标签 → 把仓库里 `serverless/schema.sql` 的**全部内容**粘贴进输入框 → **Execute**。
   - 执行完应该看到 `users`、`feeds`、`items` 等表出现在 Tables 列表里。

> 这一步相当于"建表"，只做一次。漏做的话，登录时会报 `no such table: users`。

---

## 第 2 步：把 Database ID 填进配置文件

在 GitHub 网页上直接改，两个文件都要改（改完各点一次 **Commit changes**）：

- `cloudflare/worker/wrangler.jsonc`
- `cloudflare/pages/wrangler.jsonc`

把里面的这一行：

```jsonc
"database_id": "REPLACE_WITH_YOUR_D1_ID"
```

换成第 1 步复制的 ID：

```jsonc
"database_id": "a1b2c3d4-1234-5678-9abc-def012345678"
```

> 只部署其中一条路线的话，理论上只改对应那个文件就行；两个都改更省事，以后换路线不用再回来。

---

## 第 3 步（推荐）：部署成 Worker

1. 控制台 → **Workers & Pages** → **Create application**。
2. 选择 **GitHub**（或 GitLab），授权并选中第 0 步的仓库。
3. 在 "Set up builds and deployments" 页面填写：

   | 字段 | 填什么 |
   | --- | --- |
   | **Project name** | `feednest`（⚠️ 必须和 `wrangler.jsonc` 里的 `name` 一致，否则构建报错） |
   | **Production branch** | `main` |
   | **Root directory**（在 Advanced 里） | 仓库根目录就是 feednest 的话留空；如果仓库里还套了一层，填 `feednest` |
   | **Build command** | 留空 |
   | **Deploy command** | `npx wrangler deploy -c cloudflare/worker/wrangler.jsonc` |

4. 点 **Save and Deploy**，等 1～3 分钟。
5. 构建成功后打开 `https://feednest.<你的子域>.workers.dev`。

部署完可以顺手确认两处：

- **Settings → Bindings**：应该能看到 `DB`（D1 → feednest-db）和 `ASSETS`（静态资源）
- **Settings → Triggers → Cron Triggers**：应该有 `*/10 * * * *`（每 10 分钟刷新一批订阅，配置里自带，部署时自动生效）

以后改代码只要往 GitHub 提交，Cloudflare 会自动重新构建部署。

---

## 第 3 步（备选）：部署成 Pages

Pages 的好处是每个分支都有预览地址；代价是**没有定时任务**，只能靠打开页面时自动补刷。

1. 控制台 → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**。
2. 选中仓库 → **Install & Authorize** → **Begin setup**。
3. 填写：

   | 字段 | 填什么 |
   | --- | --- |
   | **Project name** | `feednest` |
   | **Production branch** | `main` |
   | **Framework preset** | `None` |
   | **Build command** | `node build.mjs` |
   | **Build output directory** | `dist` |
   | **Root directory**（Advanced → Path） | `feednest/cloudflare/pages`（仓库根就是 feednest 时填 `cloudflare/pages`） |

4. **Save and Deploy**，完成后打开 `https://feednest.pages.dev`。
5. 部署完成后进入项目 → **Settings → Bindings**，确认有一条 `DB` → D1 → `feednest-db` 的绑定；
   没有的话点 **Add → D1 database** 手动加一个，变量名必须是 `DB`，加完重新部署一次。

> `build.mjs` 只是把仓库根目录的 `public/` 复制到 `dist/`，因为 Pages 要求输出目录在项目根目录内。

---

## 第 4 步：首次使用

1. 打开部署好的网址，用 **`admin` / `admin`** 登录。
2. 顶部黄色提示条会提醒你改默认密码 → 点「修改密码」。
3. 点顶部 **导入** → 选择 `feedbro-subscriptions-*.opml` → 等待后台抓取（93 个源大约 1 分钟）。
4. 想加人：右上角头像 → **用户管理** → 填用户名/密码 → 新增。

---

## 这套流程验证过什么

- 按上面第 0 步的文件清单（28 个文件 / 393 KB）复制到一个干净目录，执行 `npm ci` +
  `npx wrangler deploy --dry-run -c cloudflare/worker/wrangler.jsonc`：构建通过，
  产物 149.73 KiB（gzip 33.19 KiB），静态资源 3 个文件，`DB`、`ASSETS`、`MAX_FEEDS_PER_RUN` 绑定都正确。
- `node cloudflare/pages/build.mjs` 生成的 `dist/` 完整（index.html / app.css / app.js），
  本地用 `wrangler pages dev` 跑通了静态页面 + `/api` 接口 + 登录。

也就是说：**照着这份清单传文件，控制台里的两条构建流程都能直接成功**，不会因为少文件而失败。

---

## 常见问题

**构建报错 `Could not find wrangler.jsonc` / Worker 名称不匹配**
- Worker 的 Project name 必须等于配置文件里的 `name`（`feednest`）；想用别的名字就把两个 `wrangler.jsonc` 里的 `name` 一起改掉。
- Deploy command 里的 `-c cloudflare/worker/wrangler.jsonc` 路径要相对 **Root directory**，仓库根就是 feednest 时保持原样。

**构建报错 `database_id` 无效**
第 2 步没改或改错了文件，回到 GitHub 网页重新编辑提交。

**打开页面能登录但一直转圈 / 报 `no such table: users`**
第 1 步的 schema 没执行。去 D1 的 Console 再执行一次 `serverless/schema.sql`。

**Pages 上登录报 `D1_ERROR: no such table` 或绑定找不到**
Pages 的绑定没生效：Settings → Bindings 手动加 `DB` → `feednest-db`，然后 **Deployments → Retry deployment**。

**没有命令行怎么更新代码**
GitHub 网页直接编辑文件 → Commit → Cloudflare 自动重新构建。

**仓库能私有吗**
可以，Cloudflare 连接 GitHub 时授权私有仓库即可；构建时用的是它自己的凭据。

**为什么 Workers 版还要设置 Cron**
Workers 的定时任务（Cron Trigger）写在 `wrangler.jsonc` 里，部署时自动注册，不需要额外操作；
Pages 没有这个能力，所以 Pages 版靠"打开页面时补刷到期订阅"。
