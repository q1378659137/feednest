# 部署到 Cloudflare（Workers / Pages）

FeedNest 的云端版本是**纯无服务器**的：业务代码在 `serverless/`，数据在 **D1**（Cloudflare 的 SQLite），
前端还是 `public/` 里那套静态文件。Workers 和 Pages 两种部署方式**共用同一份代码和同一个数据库**。

> 💡 **不想装命令行？** 全程在 Cloudflare 控制台 + GitHub 网页完成部署，见
> **[`WEB-DEPLOY.md`](WEB-DEPLOY.md)**（纯网页部署指南）。
> 下面这份文档是命令行（wrangler）版本，适合本地开发、调试和批量部署。

| | **Workers（推荐）** | **Pages** |
| --- | --- | --- |
| 组成 | 一个 Worker：静态资源 + `/api` + 定时任务 | Pages 静态托管 + Pages Functions |
| 定时刷新 | ✅ Cron Trigger（默认 10 分钟） | ❌ 没有 Cron，靠打开页面时补刷 |
| 部署命令 | `wrangler deploy` | `wrangler pages deploy` |
| 适合 | 长期使用 | 想要 Pages 的预览部署 / 分支预览 |

```
feednest/
├─ public/                前端（两边共用）
├─ serverless/            业务代码（Workers 运行时）
│  ├─ core.js             路由 / 鉴权 / 全部接口
│  ├─ db.js               D1 数据层
│  ├─ auth.js             PBKDF2 密码 + 会话
│  ├─ feed.js             抓取、解析、刷新
│  ├─ opml.js             导入导出
│  ├─ worker.js           Workers 入口（fetch + scheduled）
│  └─ schema.sql          D1 建表语句
└─ cloudflare/
   ├─ worker/wrangler.jsonc       Workers 配置（assets + D1 + cron）
   └─ pages/wrangler.jsonc        Pages 配置
      └─ functions/api/[[path]].js  Pages Functions 入口
```

---

## 0. 前置

- 一个 Cloudflare 账号
- Node.js ≥ 18（仓库里已带 `wrangler` 依赖，用 `npx wrangler` 即可）
- 登录：`npx wrangler login`

## 1. 创建 D1 数据库（两种方案共用）

```bash
cd cloudflare/worker
npx wrangler d1 create feednest-db
```

命令会打印 `database_id`，把它填进**两个**配置文件里的 `REPLACE_WITH_YOUR_D1_ID`：

- `cloudflare/worker/wrangler.jsonc`
- `cloudflare/pages/wrangler.jsonc`

然后建表（只需一次）：

```bash
cd cloudflare/worker
npx wrangler d1 execute feednest-db --remote --file=../../serverless/schema.sql
```

---

## 2A. 部署到 Workers（推荐）

```bash
cd cloudflare/worker
npx wrangler deploy
```

输出形如 `https://feednest.<你的子域>.workers.dev`。这个 Worker 同时干了三件事：

1. 托管 `public/` 静态文件（`assets` 绑定，`run_worker_first: ["/api/*"]`）
2. 处理 `/api/*` 全部接口（D1 绑定 `DB`）
3. Cron Trigger 每 10 分钟刷新一批到期订阅（按最久未刷新优先轮转）

**首次使用**：打开地址 → 用 `admin / admin` 登录 → 点顶部「导入」选 `feedbro-subscriptions-*.opml` → 等后台抓取完成。

常用命令：

```bash
npx wrangler tail                 # 实时日志
npx wrangler deployments list     # 部署历史
npx wrangler d1 export feednest-db --remote --output=backup.sql   # 备份
```

改刷新频率：编辑 `wrangler.jsonc` 里的 `triggers.crons`，例如 `"0 * * * *"` 表示每小时；
改每批数量：`vars.MAX_FEEDS_PER_RUN`（免费版建议 ≤45，付费版可设 500）。

---

## 2B. 部署到 Pages

```bash
cd cloudflare/pages
node build.mjs                              # 把仓库根目录的 public/ 复制成 dist/
npx wrangler pages deploy --project-name feednest
```

`build.mjs` 是必须的一步：Pages 要求「构建输出目录」在项目根目录内，而前端静态文件在仓库根目录，
所以先复制一份到 `cloudflare/pages/dist`（`wrangler.jsonc` 里的 `pages_build_output_dir` 指向它）。
用 Git 集成部署时同理，Build command 填 `node build.mjs`、输出目录填 `dist`。

首次执行会让你确认创建项目。部署完成后：

1. 打开 Cloudflare 控制台 → Workers & Pages → 你的 Pages 项目 → **Settings → Bindings**，
   确认 `DB` 这个 D1 绑定存在（配置文件里已声明，一般会自动带上；没有就手动添加 `feednest-db`）。
2. 访问 `https://feednest.pages.dev`，同样用 `admin / admin` 登录、导入 OPML。

**和 Workers 版的唯一差别：Pages 没有 Cron。** 为了不让订阅停更，前端做了兜底——
每次打开页面会调用 `POST /api/refresh {scope:"due"}`，把已经到期的订阅补刷一遍（不打扰，除非有新文章）。

如果你需要严格的后台定时刷新，有两个选择：

- 同时部署方案 A 的 Worker（只当定时器用，前端仍然用 Pages 的地址），两个部署指向同一个 D1；
- 或者用 GitHub Actions / cron-job.org 每 30 分钟请求一次你的站点接口。

---

## 3. 消息推送（PushPlus）

在设置里填 PushPlus Token 并勾选「启用」后，**手动刷新和 Cron 定时刷新都会推送**新文章
（每个用户按自己的设置推，导入 OPML 时不推）。

- 想指向自建代理/中转：在 `wrangler.jsonc` 的 `vars` 里加 `"PUSHPLUS_URL": "https://你的地址/send"`
- 推送失败只写日志（`[push] ...`），不会影响刷新本身
- Pages 版没有 Cron，只有「打开页面补刷」和手动刷新会触发推送

---

## 4. 本地开发 / 调试（已实测可用）

Workers：

```bash
cd cloudflare/worker
npx wrangler d1 execute feednest-db --local --file=../../serverless/schema.sql
npx wrangler dev                        # http://127.0.0.1:8787
curl http://127.0.0.1:8787/cdn-cgi/local/scheduled    # 手动触发一次 cron
```

Pages：

```bash
cd cloudflare/pages
npx wrangler d1 execute feednest-db --local --file=../../serverless/schema.sql
npx wrangler pages dev --d1 DB=feednest-db --port 8788
```

> 注意：`pages dev` 不会读取 `wrangler.jsonc` 里的 D1 绑定，必须显式带 `--d1 DB=feednest-db`；
> 而且它的本地 D1 文件和 `d1 execute` 用的不是同一个（bind 名称不同会生成不同的库文件），
> 如果报 `no such table: users`，重新执行一次上面的 `d1 execute`，或直接用 `--persist-to` 指定同一目录。

---

## 5. 必须知道的限制

**配额**

| | 免费版 | 付费版（$5/月起） |
| --- | --- | --- |
| Worker 子请求 | 50 / 次 | 1000 / 次 |
| Worker CPU | 10 ms / 次 | 30 s / 次 |
| D1 读 | 500 万行 / 天 | 250 亿行 / 月 |
| D1 写 | 10 万行 / 天 | 5000 万行 / 月 |

所以**刷新是分批的**：默认每次最多刷 45 个源（`wrangler.jsonc` 里的 `MAX_FEEDS_PER_RUN`）。
分批不会漏源——服务端每批都挑**最久没刷新**的那一批，前端点一次「刷新」会自动连着跑完剩余批次，
定时任务也按同样的顺序轮转。付费版可以把 `MAX_FEEDS_PER_RUN` 调到 500 甚至更大。

轮转速度参考（免费版 45/次、cron 每 10 分钟）：

| 源数量 | 轮完一圈约需 |
| --- | --- |
| 100 个 | 25 分钟 |
| 500 个 | 2 小时 |
| 2000 个 | 7.5 小时（建议付费版或自建） |

**首次导入很费写配额**：导入 700 篇文章 ≈ 700 次写入，免费版每天 10 万行足够，但别反复删库重导。
源很多时把「设置 → 每个订阅保留文章数」调到 100~200，控制 D1 体积（免费 5GB 很宽松）。

**密码哈希不通用**：Workers 运行时没有 `scrypt`，这里用的是 PBKDF2-SHA256（10 万次迭代）。
Docker 版用的是 scrypt，两边的 `users` 表**不能互相导入**；订阅数据（OPML）可以随便搬。

**没有本地磁盘**：所有状态都在 D1，容器/实例重启不影响数据。备份用 `wrangler d1 export`。

---

## 6. 常见问题

**Q：登录后一直跳回登录页？**
确认访问的是 `https://`（Workers/Pages 默认就是），并且浏览器没有禁用 Cookie。会话是 HttpOnly Cookie，
有效期 30 天。

**Q：`no such table: users`**
D1 还没建表，执行第 1 步的 `d1 execute ... --file=../../serverless/schema.sql`。

**Q：改了 `MAX_FEEDS_PER_RUN` 没生效？**
它是 `vars` 里的字符串，需要重新 `wrangler deploy`（Pages 则是重新 deploy）。

**Q：忘记 admin 密码？**
在 Cloudflare 控制台 → D1 → `feednest-db` → Console 里执行（把 `<hash>` 换成本地用
`serverless` 同款算法生成的 PBKDF2 串比较麻烦，最简单是删掉 `users` 里那条记录，
下次访问会重新创建 `admin/admin`）：

```sql
DELETE FROM users WHERE username = 'admin';
```

**Q：能不能 Workers 和 Pages 同时对外？**
可以，但它们指向同一个 D1 时，会话表是共享的，登录状态互不影响；建议只对外暴露一个入口。
