/**
 * 业务核心 —— 同时被 Workers（serverless/worker.js）和 Pages Functions
 * （functions/api/[[path]].js）复用。所有处理都是 (request, env, ctx) → Response。
 */

import { Db } from './db.js';
import * as auth from './auth.js';
import * as feedLib from './feed.js';
import * as opmlLib from './opml.js';
import { sendPushPlus } from './push.js';

export const VERSION = '1.2.0';

const USERNAME_RE = /^[\w\u4e00-\u9fa5.@-]{2,32}$/;

/* ------------------------------ 工具 ------------------------------ */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function parseScope(value) {
  if (!value || value === 'all') return { type: 'all' };
  const [type, ...rest] = String(value).split(':');
  const id = rest.join(':');
  if (type === 'feed' || type === 'folder') return { type, id };
  if (type === 'starred') return { type: 'starred' };
  return { type: 'all' };
}

function feedWithUnread(feed, perFeed) {
  return {
    id: feed.id,
    folderId: feed.folder_id,
    title: feed.title,
    url: feed.url,
    siteUrl: feed.site_url,
    iconUrl: feed.icon_url,
    lastFetchAt: feed.last_fetch_at,
    lastStatus: feed.last_status,
    lastError: feed.last_error,
    unread: perFeed.get(feed.id) || 0,
  };
}

/* --------------------------- 登录限流 --------------------------- */

const attempts = new Map();
const MAX_ATTEMPTS = 6;
const LOCK_MS = 60 * 1000;

function throttleKey(request, username) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'local';
  return `${ip}|${String(username || '').toLowerCase()}`;
}

function lockedFor(key) {
  const rec = attempts.get(key);
  if (!rec || !rec.until) return 0;
  if (rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000);
  attempts.delete(key);
  return 0;
}

function recordFailure(key) {
  const rec = attempts.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.until = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  attempts.set(key, rec);
}

/* --------------------------- 刷新进度 --------------------------- */

// 刷新进度按用户隔离（Workers 里是 isolate 内的内存态，够用且不影响其他账号）
const progressByUser = new Map();

function getProgress(userId = 'auto') {
  const key = userId || 'auto';
  if (!progressByUser.has(key)) {
    progressByUser.set(key, {
      running: false, total: 0, done: 0, failed: 0, added: 0,
      remaining: 0, startedAt: 0, finishedAt: 0, mode: '',
    });
  }
  return progressByUser.get(key);
}

function publicProgress(userId = 'auto') {
  return { ...getProgress(userId), current: '' };
}

async function runRefresh(db, feeds, mode, userId = 'auto', env) {
  const progress = getProgress(userId);
  if (progress.running) return false;
  Object.assign(progress, {
    running: true,
    mode,
    total: feeds.length,
    done: 0,
    failed: 0,
    added: 0,
    startedAt: Date.now(),
    finishedAt: 0,
  });
  try {
    await feedLib.refreshMany(db, feeds, {
      concurrency: 5,
      notify: mode !== 'import',
      pushUrl: env && env.PUSHPLUS_URL,
      onProgress: ({ done, added, failed }) => {
        progress.done = done;
        progress.added = added;
        progress.failed = failed;
      },
    });
  } finally {
    progress.running = false;
    progress.finishedAt = Date.now();
  }
  return true;
}

/* --------------------------- 首次初始化 --------------------------- */

let adminChecked = false;

async function ensureAdmin(db) {
  if (adminChecked) return;
  const count = await db.countUsers();
  if (count === 0) {
    await db.insertUser({
      id: auth.newId(),
      username: 'admin',
      password_hash: await auth.hashPassword('admin'),
      role: 'admin',
      is_default_password: true,
      created_at: Date.now(),
    });
  }
  adminChecked = true;
}

/* ------------------------------ 路由 ------------------------------ */

const routes = [];
function route(method, pattern, handler, options = {}) {
  routes.push({ method, pattern, handler, auth: options.auth !== false, admin: !!options.admin });
}

/* ---- 认证 ---- */

route(
  'POST',
  /^\/api\/auth\/login$/,
  async ({ request, db }) => {
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return json({ error: '请输入用户名和密码' }, 400);

    const key = throttleKey(request, username);
    const locked = lockedFor(key);
    if (locked) return json({ error: `尝试次数过多，请 ${locked} 秒后再试` }, 429);

    const user = await db.getUserByName(username);
    const ok = user && !user.disabled && (await auth.verifyPassword(password, user.password_hash));
    if (!ok) {
      recordFailure(key);
      return json({ error: '用户名或密码错误' }, 401);
    }

    attempts.delete(key);
    const token = await auth.createSession(db, user.id, request);
    await db.touchLogin(user.id);
    return json({ user: auth.publicUser(user) }, 200, {
      'set-cookie': auth.sessionCookie(request, token),
    });
  },
  { auth: false }
);

route(
  'POST',
  /^\/api\/auth\/logout$/,
  async ({ request, db }) => {
    await auth.destroySession(db, request);
    return json({ ok: true }, 200, { 'set-cookie': auth.clearSessionCookie(request) });
  },
  { auth: false }
);

route(
  'GET',
  /^\/api\/auth\/me$/,
  async ({ request, db }) => {
    const user = await auth.currentUser(db, request);
    return json({ user: auth.publicUser(user) });
  },
  { auth: false }
);

route('POST', /^\/api\/auth\/password$/, async ({ request, db, user }) => {
  const body = await request.json().catch(() => ({}));
  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  if (!(await auth.verifyPassword(current, user.password_hash))) {
    return json({ error: '当前密码不正确' }, 400);
  }
  if (next.length < 4) return json({ error: '新密码至少 4 位' }, 400);
  if (next === current) return json({ error: '新密码不能与当前密码相同' }, 400);
  await db.setPassword(user.id, await auth.hashPassword(next));
  return json({ ok: true, relogin: true }, 200, { 'set-cookie': auth.clearSessionCookie(request) });
});

/* ---- 用户管理（管理员） ---- */

route(
  'GET',
  /^\/api\/users$/,
  async ({ db }) => {
    const users = await db.listUsers();
    const rows = await db.all('SELECT user_id, COUNT(*) AS c FROM feeds GROUP BY user_id');
    const counts = new Map(rows.map((r) => [r.user_id, r.c]));
    return json({
      users: users.map((u) => ({ ...auth.publicUser(u), feedCount: counts.get(u.id) || 0 })),
    });
  },
  { admin: true }
);

route(
  'POST',
  /^\/api\/users$/,
  async ({ request, db }) => {
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) return json({ error: '用户名需为 2-32 位字母、数字、下划线或中文' }, 400);
    if (password.length < 4) return json({ error: '密码至少 4 位' }, 400);
    if (await db.getUserByName(username)) return json({ error: '用户名已存在' }, 400);
    const row = await db.insertUser({
      id: auth.newId(),
      username,
      password_hash: await auth.hashPassword(password),
      role: body.role === 'admin' ? 'admin' : 'user',
      is_default_password: false,
      created_at: Date.now(),
    });
    return json({ user: auth.publicUser(row) });
  },
  { admin: true }
);

route(
  'PATCH',
  /^\/api\/users\/([\w-]+)$/,
  async ({ request, db, params, user: me }) => {
    const body = await request.json().catch(() => ({}));
    const target = await db.getUserById(params[0]);
    if (!target) return json({ error: '用户不存在' }, 404);
    if (target.id === me.id && body.disabled) return json({ error: '不能禁用自己' }, 400);

    if (body.password !== undefined) {
      const pwd = String(body.password);
      if (pwd.length < 4) return json({ error: '密码至少 4 位' }, 400);
      await db.setPassword(target.id, await auth.hashPassword(pwd));
    }
    if (body.role !== undefined) {
      const nextRole = body.role === 'admin' ? 'admin' : 'user';
      if (target.role === 'admin' && nextRole !== 'admin' && (await db.countAdmins()) <= 1) {
        return json({ error: '至少需要保留一个管理员' }, 400);
      }
      await db.updateUser(target.id, { role: nextRole });
    }
    if (body.disabled !== undefined) {
      if (target.role === 'admin' && body.disabled && (await db.countAdmins()) <= 1) {
        return json({ error: '至少需要保留一个可用的管理员' }, 400);
      }
      await db.updateUser(target.id, { disabled: !!body.disabled });
    }
    return json({ user: auth.publicUser(await db.getUserById(target.id)) });
  },
  { admin: true }
);

route(
  'DELETE',
  /^\/api\/users\/([\w-]+)$/,
  async ({ db, params, user: me }) => {
    if (params[0] === me.id) return json({ error: '不能删除当前登录的账号' }, 400);
    const target = await db.getUserById(params[0]);
    if (!target) return json({ error: '用户不存在' }, 404);
    if (target.role === 'admin' && (await db.countAdmins()) <= 1) {
      return json({ error: '至少需要保留一个管理员' }, 400);
    }
    await db.deleteUser(target.id);
    return json({ ok: true });
  },
  { admin: true }
);

/* ---- 状态 / 文章 ---- */

route('GET', /^\/api\/state$/, async ({ db, user }) => {
  const counts = await db.counts(user.id);
  const folders = (await db.listFolders(user.id)).map((f) => ({ id: f.id, name: f.name }));
  const list = (await db.listFeeds(user.id)).map((f) => feedWithUnread(f, counts.perFeed));
  const folderUnread = {};
  for (const folder of folders) folderUnread[folder.id] = 0;
  for (const feed of list) {
    if (feed.folderId && folderUnread[feed.folderId] !== undefined) folderUnread[feed.folderId] += feed.unread;
  }
  return json({
    user: auth.publicUser(user),
    folders,
    feeds: list,
    folderUnread,
    counts: { unread: counts.totalUnread, items: counts.totalItems, starred: counts.starred },
    settings: await db.getSettings(user.id),
    progress: publicProgress(user.id),
    proxy: null,
    version: VERSION,
    runtime: 'cloudflare',
  });
});

route('GET', /^\/api\/items$/, async ({ db, user, query }) => {
  const result = await db.listItems({
    userId: user.id,
    scope: parseScope(query.get('scope')),
    unread: query.get('unread') === '1',
    q: (query.get('q') || '').trim() || null,
    sort: query.get('sort') === 'oldest' ? 'oldest' : 'newest',
    limit: Math.min(Number(query.get('limit')) || 60, 200),
    offset: Math.max(Number(query.get('offset')) || 0, 0),
  });
  return json({
    total: result.total,
    items: result.items.map((i) => ({
      id: i.id,
      feedId: i.feed_id,
      feedTitle: i.feed_title,
      feedIcon: i.feed_icon,
      title: i.title,
      link: i.link,
      author: i.author,
      publishedAt: i.published_at,
      summary: i.summary,
      thumbnail: i.thumbnail,
      read: !!i.read,
      starred: !!i.starred,
    })),
  });
});

route('GET', /^\/api\/items\/([\w-]+)$/, async ({ db, user, params }) => {
  const item = await db.getItem(user.id, params[0]);
  if (!item) return json({ error: '文章不存在' }, 404);
  return json({
    id: item.id,
    feedId: item.feed_id,
    feedTitle: item.feed_title,
    feedSiteUrl: item.feed_site_url,
    feedIcon: item.feed_icon,
    title: item.title,
    link: item.link,
    author: item.author,
    publishedAt: item.published_at,
    content: item.content,
    summary: item.summary,
    thumbnail: item.thumbnail,
    read: !!item.read,
    starred: !!item.starred,
  });
});

route('POST', /^\/api\/items\/([\w-]+)\/read$/, async ({ request, db, user, params }) => {
  const body = await request.json().catch(() => ({}));
  await db.setRead(user.id, params[0], body.read !== false);
  return json({ ok: true });
});

route('POST', /^\/api\/items\/([\w-]+)\/star$/, async ({ request, db, user, params }) => {
  const body = await request.json().catch(() => ({}));
  await db.setStarred(user.id, params[0], body.starred !== false);
  return json({ ok: true });
});

route('POST', /^\/api\/mark-read$/, async ({ request, db, user }) => {
  const body = await request.json().catch(() => ({}));
  await db.markScopeRead(user.id, parseScope(body.scope));
  return json({ ok: true });
});

/* ---- 订阅 ---- */

route('POST', /^\/api\/feeds\/preview$/, async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const url = String(body.url || '').trim();
  if (!url) return json({ error: '请输入订阅地址' }, 400);
  try {
    return json(await feedLib.previewFeed(url));
  } catch (err) {
    return json({ error: String(err.message || err) }, 400);
  }
});

route('POST', /^\/api\/feeds$/, async ({ request, db, user }) => {
  const body = await request.json().catch(() => ({}));
  const url = String(body.url || '').trim();
  if (!url) return json({ error: '请输入订阅地址' }, 400);

  let preview;
  try {
    preview = await feedLib.previewFeed(url);
  } catch (err) {
    return json({ error: String(err.message || err) }, 400);
  }
  if (await db.getFeedByUrl(user.id, preview.url)) return json({ error: '该订阅已经存在' }, 409);

  const folders = await db.listFolders(user.id);
  const folderId = body.folderId && folders.some((f) => f.id === body.folderId) ? body.folderId : null;

  const row = {
    id: auth.newId(),
    user_id: user.id,
    folder_id: folderId,
    title: String(body.title || '').trim() || preview.title || url,
    url: preview.url,
    site_url: preview.siteUrl || null,
    description: preview.description || null,
    icon_url: preview.iconUrl || null,
    sort_order: Date.now(),
    created_at: Date.now(),
  };
  await db.createFeed(row);
  const record = await db.getFeed(user.id, row.id);
  const result = await feedLib.refreshFeed(db, record);
  const counts = await db.counts(user.id);
  return json({
    feed: feedWithUnread(await db.getFeed(user.id, row.id), counts.perFeed),
    added: result.added || 0,
    error: result.status === 'error' ? result.error : null,
  });
});

route('PATCH', /^\/api\/feeds\/([\w-]+)$/, async ({ request, db, user, params }) => {
  const body = await request.json().catch(() => ({}));
  const feed = await db.getFeed(user.id, params[0]);
  if (!feed) return json({ error: '订阅不存在' }, 404);
  const meta = {};
  if (body.title !== undefined) meta.title = String(body.title).trim().slice(0, 200) || feed.title;
  if (body.folderId !== undefined) {
    const folders = await db.listFolders(user.id);
    meta.folder_id = body.folderId && folders.some((f) => f.id === body.folderId) ? body.folderId : null;
  }
  await db.updateFeedMeta(feed.id, meta);
  return json({ ok: true });
});

route('DELETE', /^\/api\/feeds\/([\w-]+)$/, async ({ db, user, params }) => {
  await db.deleteFeed(user.id, params[0]);
  return json({ ok: true });
});

route('POST', /^\/api\/feeds\/([\w-]+)\/refresh$/, async ({ db, user, params }) => {
  const feed = await db.getFeed(user.id, params[0]);
  if (!feed) return json({ error: '订阅不存在' }, 404);
  const result = await feedLib.refreshFeed(db, feed);
  const counts = await db.counts(user.id);
  return json({ ...result, feed: feedWithUnread(await db.getFeed(user.id, feed.id), counts.perFeed) });
});

/* ---- 文件夹 ---- */

route('POST', /^\/api\/folders$/, async ({ request, db, user }) => {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return json({ error: '请输入文件夹名称' }, 400);
  const folder = {
    id: auth.newId(),
    user_id: user.id,
    name: name.slice(0, 120),
    position: Date.now(),
    created_at: Date.now(),
  };
  await db.createFolder(folder);
  return json({ folder: { id: folder.id, name: folder.name } });
});

route('PATCH', /^\/api\/folders\/([\w-]+)$/, async ({ request, db, user, params }) => {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return json({ error: '请输入文件夹名称' }, 400);
  await db.renameFolder(user.id, params[0], name.slice(0, 120));
  return json({ ok: true });
});

route('DELETE', /^\/api\/folders\/([\w-]+)$/, async ({ db, user, params }) => {
  await db.deleteFolder(user.id, params[0]);
  return json({ ok: true });
});

/* ---- OPML ---- */

route('GET', /^\/api\/opml$/, async ({ db, user }) => {
  const xml = await opmlLib.buildOpml(db, user.id);
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(xml, {
    headers: {
      'content-type': 'text/x-opml; charset=utf-8',
      'content-disposition': `attachment; filename="feednest-subscriptions-${stamp}.opml"`,
      'cache-control': 'no-store',
    },
  });
});

route('POST', /^\/api\/opml$/, async ({ request, db, user, ctx }) => {
  const raw = await request.text();
  if (!raw.trim()) return json({ error: '文件内容为空' }, 400);
  let entries;
  try {
    entries = opmlLib.parseOpml(raw);
  } catch (err) {
    return json({ error: String(err.message || err) }, 400);
  }
  if (!entries.length) return json({ error: '没有在文件中找到订阅' }, 400);

  const result = await opmlLib.importEntries(db, user.id, entries, auth.newId);
  if (result.newFeedIds.length) {
    const ids = new Set(result.newFeedIds);
    const list = (await db.listFeeds(user.id)).filter((f) => ids.has(f.id));
    ctx.waitUntil(runRefresh(db, list, 'import', user.id, env).catch(() => {}));
  }
  return json({ added: result.added, skipped: result.skipped, foldersCreated: result.foldersCreated, total: entries.length });
});

/* ---- 刷新 ---- */

route('POST', /^\/api\/refresh$/, async ({ request, db, user, ctx, env }) => {
  const body = await request.json().catch(() => ({}));
  const target = String(body.scope || 'all');
  const since = Number(body.since) || 0;
  const userProgress = getProgress(user.id);
  if (userProgress.running) return json({ started: false, progress: publicProgress(user.id) });

  // Workers 免费版每次调用最多 50 个子请求，所以按批刷新；剩余部分交给下一轮（cron 或前端续批）
  const maxPerRun = Math.max(5, Math.min(Number(env.MAX_FEEDS_PER_RUN) || 45, 500));

  let list = await db.listFeeds(user.id);
  if (target === 'due') {
    const settings = await db.getSettings(user.id);
    list = list.filter((f) => feedLib.isDue(f, settings));
  } else {
    const scope = parseScope(target);
    if (scope.type === 'feed') list = list.filter((f) => f.id === scope.id);
    if (scope.type === 'folder') list = list.filter((f) => f.folder_id === scope.id);
  }
  // 前端续批时会带上本轮开始时间：只处理这之前没刷过的源，保证每批都在推进、剩余数会归零
  if (since > 0) list = list.filter((f) => (f.last_fetch_at || 0) < since);

  if (!list.length) return json({ started: false, progress: publicProgress(user.id), empty: true });

  // 最久没刷新的优先：这样连续点几次（或前端自动续批）能覆盖全部源，不会反复刷同一批
  list.sort((a, b) => (a.last_fetch_at || 0) - (b.last_fetch_at || 0));
  const batch = list.slice(0, maxPerRun);
  userProgress.remaining = Math.max(0, list.length - batch.length);

  ctx.waitUntil(runRefresh(db, batch, target === 'due' ? 'due' : 'manual', user.id, env).catch(() => {}));
  return json({ started: true, progress: publicProgress(user.id), remaining: userProgress.remaining });
});

route('GET', /^\/api\/refresh\/status$/, async ({ user }) => json(publicProgress(user.id)));

/* ---- 设置 / 统计 ---- */

route('POST', /^\/api\/settings$/, async ({ request, db, user }) => {
  const body = await request.json().catch(() => ({}));
  if (body.refreshInterval !== undefined) {
    await db.setSetting(user.id, 'refreshInterval', Math.max(300, Math.min(Number(body.refreshInterval) || 1800, 86400)));
  }
  if (body.maxItemsPerFeed !== undefined) {
    await db.setSetting(user.id, 'maxItemsPerFeed', Math.max(20, Math.min(Number(body.maxItemsPerFeed) || 300, 5000)));
  }
  if (body.pushEnabled !== undefined) {
    await db.setSetting(user.id, 'pushEnabled', !!body.pushEnabled);
  }
  if (body.pushToken !== undefined) {
    await db.setSetting(user.id, 'pushToken', String(body.pushToken || '').trim().slice(0, 200));
  }
  if (body.language !== undefined) {
    await db.setSetting(user.id, 'language', ['zh-CN', 'zh-TW', 'en'].includes(body.language) ? body.language : 'zh-CN');
  }
  return json({ settings: await db.getSettings(user.id) });
});

route('POST', /^\/api\/reorder$/, async ({ request, db, user }) => {
  const body = await request.json().catch(() => ({}));
  const type = String(body.type || '');
  const id = String(body.id || '');
  if (!id) return json({ error: '缺少 id' }, 400);
  try {
    if (type === 'folder') {
      return json({ ok: true, ...(await db.reorderFolder(user.id, id, body.beforeId || null)) });
    }
    if (type !== 'feed') return json({ error: 'type 只能是 feed 或 folder' }, 400);
    return json({
      ok: true,
      ...(await db.reorderFeed(user.id, id, body.folderId || null, body.beforeId || null)),
    });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
});

route('POST', /^\/api\/push\/test$/, async ({ request, db, user, env }) => {
  const body = await request.json().catch(() => ({}));
  const settings = await db.getSettings(user.id);
  const token = String(body.token || '').trim() || settings.pushToken;
  if (!token) return json({ error: '请先填写 PushPlus Token' }, 400);
  try {
    await sendPushPlus(
      token,
      'FeedNest 推送测试',
      '<p>收到这条消息说明 PushPlus 配置成功。</p><p>以后订阅有新文章时会按这个格式推送。</p>',
      env && env.PUSHPLUS_URL
    );
    return json({ ok: true });
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 400);
  }
});

route('GET', /^\/api\/stats$/, async ({ db, user }) => {
  const rows = await db.feedStats(user.id);
  return json({
    feeds: rows.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      total: r.total || 0,
      unread: r.unread || 0,
      lastFetchAt: r.last_fetch_at,
      lastStatus: r.last_status,
      lastError: r.last_error,
    })),
  });
});

/* ---- 清空 / 初始化 ---- */

route('POST', /^\/api\/subscriptions\/clear$/, async ({ db, user }) => {
  const removed = await db.clearUserSubscriptions(user.id);
  return json({ ok: true, removed });
});

route(
  'POST',
  /^\/api\/admin\/reset$/,
  async ({ request, db }) => {
    const body = await request.json().catch(() => ({}));
    if (String(body.confirm || '') !== 'RESET') {
      return json({ error: '确认口令不正确，请输入 RESET' }, 400);
    }
    const adminHash = await auth.hashPassword('admin');
    const result = await db.resetInstance(adminHash);
    return json({ ok: true, ...result }, 200, { 'set-cookie': auth.clearSessionCookie(request) });
  },
  { admin: true }
);

route('GET', /^\/api\/health$/, async () => json({ ok: true, version: VERSION, runtime: 'cloudflare' }), {
  auth: false,
});

/* ------------------------------ 分发 ------------------------------ */

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const db = new Db(env.DB);

  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (mutating && !sameOrigin(request)) return json({ error: '非法来源' }, 403);

  try {
    await ensureAdmin(db);

    for (const r of routes) {
      if (r.method !== request.method) continue;
      const match = r.pattern.exec(url.pathname);
      if (!match) continue;

      let user = null;
      if (r.auth || r.admin) {
        user = await auth.currentUser(db, request);
        if (!user) return json({ error: '未登录', needLogin: true }, 401);
        if (r.admin && user.role !== 'admin') return json({ error: '需要管理员权限' }, 403);
      }
      return await r.handler({ request, env, ctx, db, user, params: match.slice(1), query: url.searchParams });
    }
    return json({ error: '接口不存在' }, 404);
  } catch (err) {
    console.error('[api]', request.method, url.pathname, err);
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export async function runScheduledRefresh(env, ctx) {
  const db = new Db(env.DB);
  try {
    await ensureAdmin(db);
    const result = await feedLib.refreshDue(db, Number(env.MAX_FEEDS_PER_RUN) || 45, env.PUSHPLUS_URL);
    console.log(`[cron] 刷新 ${result.total} 个订阅，新增 ${result.added} 篇，失败 ${result.failed} 个`);
    return result;
  } catch (err) {
    console.error('[cron]', err);
    return null;
  }
}
