'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const opml = require('./opml');
const { previewFeed, proxyUrl } = require('./net');
const feeds = require('./feeds');
const push = require('./push');

const PORT = Number(process.env.PORT || 13786);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = '1.2.0';
const COOKIE_NAME = 'fn_session';
const SESSION_MAX_AGE = 30 * 24 * 3600;

/* ----------------------------- http utils ----------------------------- */

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求数据格式错误');
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || '';
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

/* --------------------------- login throttling --------------------------- */

const attempts = new Map();
const MAX_ATTEMPTS = 6;
const LOCK_MS = 60 * 1000;

function throttleKey(req, username) {
  return `${clientIp(req)}|${String(username || '').toLowerCase()}`;
}

function isLocked(key) {
  const rec = attempts.get(key);
  if (!rec) return 0;
  if (rec.until && rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000);
  if (rec.until && rec.until <= Date.now()) attempts.delete(key);
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

/* ------------------------------- routes ------------------------------- */

const routes = [];
function route(method, pattern, handler, options = {}) {
  routes.push({ method, pattern, handler, auth: options.auth !== false, admin: !!options.admin });
}

/* ---- auth ---- */

route('POST', /^\/api\/auth\/login$/, async (req, res) => {
  const body = await readJson(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return json(res, 400, { error: '请输入用户名和密码' });

  const key = throttleKey(req, username);
  const locked = isLocked(key);
  if (locked) return json(res, 429, { error: `尝试次数过多，请 ${locked} 秒后再试` });

  const user = db.getUserByName(username);
  if (!user || user.disabled || !db.verifyPassword(password, user.password_hash)) {
    recordFailure(key);
    return json(res, 401, { error: '用户名或密码错误' });
  }

  attempts.delete(key);
  const token = db.createSession(user.id, { userAgent: req.headers['user-agent'], ip: clientIp(req) });
  db.touchLogin(user.id);
  setSessionCookie(req, res, token);
  json(res, 200, { user: db.publicUser(user) });
}, { auth: false });

route('POST', /^\/api\/auth\/logout$/, async (req, res) => {
  db.destroySession(parseCookies(req)[COOKIE_NAME]);
  clearSessionCookie(req, res);
  json(res, 200, { ok: true });
}, { auth: false });

route('GET', /^\/api\/auth\/me$/, async (req, res) => {
  const user = db.getSessionUser(parseCookies(req)[COOKIE_NAME]);
  json(res, 200, { user: user ? db.publicUser(user) : null });
}, { auth: false });

route('POST', /^\/api\/auth\/password$/, async (req, res, params, query, user) => {
  const body = await readJson(req);
  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  if (!db.verifyPassword(current, user.password_hash)) {
    return json(res, 400, { error: '当前密码不正确' });
  }
  if (next.length < 4) return json(res, 400, { error: '新密码至少 4 位' });
  if (next === current) return json(res, 400, { error: '新密码不能与当前密码相同' });
  db.setUserPassword(user.id, next);
  clearSessionCookie(req, res);
  json(res, 200, { ok: true, relogin: true });
});

/* ---- users (admin) ---- */

route('GET', /^\/api\/users$/, async (req, res) => {
  const users = db.listUsers();
  const feedCounts = new Map(
    db.all('SELECT user_id, COUNT(*) AS c FROM feeds GROUP BY user_id').map((r) => [r.user_id, r.c])
  );
  json(res, 200, {
    users: users.map((u) => ({ ...u, feedCount: feedCounts.get(u.id) || 0 })),
  });
}, { admin: true });

route('POST', /^\/api\/users$/, async (req, res) => {
  const body = await readJson(req);
  try {
    const user = db.createUser({
      username: body.username,
      password: body.password,
      role: body.role === 'admin' ? 'admin' : 'user',
    });
    json(res, 200, { user: db.publicUser(user) });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
}, { admin: true });

route('PATCH', /^\/api\/users\/([\w-]+)$/, async (req, res, [id], query, me) => {
  const body = await readJson(req);
  const target = db.getUserById(id);
  if (!target) return json(res, 404, { error: '用户不存在' });
  if (target.id === me.id && body.disabled) return json(res, 400, { error: '不能禁用自己' });
  try {
    if (body.password !== undefined) db.setUserPassword(id, String(body.password));
    if (body.role !== undefined || body.disabled !== undefined) {
      db.updateUser(id, { role: body.role, disabled: body.disabled });
    }
    json(res, 200, { user: db.publicUser(db.getUserById(id)) });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
}, { admin: true });

route('DELETE', /^\/api\/users\/([\w-]+)$/, async (req, res, [id], query, me) => {
  if (id === me.id) return json(res, 400, { error: '不能删除当前登录的账号' });
  try {
    db.deleteUser(id);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
}, { admin: true });

/* ---- state / items ---- */

route('GET', /^\/api\/state$/, async (req, res, params, query, user) => {
  const counts = db.counts(user.id);
  const folders = db.listFolders(user.id).map((f) => ({ id: f.id, name: f.name }));
  const list = db.listFeeds(user.id).map((f) => feedWithUnread(f, counts.perFeed));
  const folderUnread = {};
  for (const folder of folders) folderUnread[folder.id] = 0;
  for (const feed of list) {
    if (feed.folderId && folderUnread[feed.folderId] !== undefined) {
      folderUnread[feed.folderId] += feed.unread;
    }
  }
  json(res, 200, {
    user: db.publicUser(user),
    folders,
    feeds: list,
    folderUnread,
    counts: { unread: counts.totalUnread, items: counts.totalItems, starred: counts.starred },
    settings: db.getSettings(user.id),
    progress: feeds.getProgressSnapshot(user.id),
    proxy: proxyUrl() || null,
    version: VERSION,
  });
});

route('GET', /^\/api\/items$/, async (req, res, params, query, user) => {
  const scope = parseScope(query.get('scope'));
  const result = db.listItems({
    userId: user.id,
    scope,
    unread: query.get('unread') === '1',
    starred: query.get('starred') === '1',
    q: (query.get('q') || '').trim() || null,
    sort: query.get('sort') === 'oldest' ? 'oldest' : 'newest',
    limit: Math.min(Number(query.get('limit')) || 60, 200),
    offset: Math.max(Number(query.get('offset')) || 0, 0),
  });
  json(res, 200, {
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

route('GET', /^\/api\/items\/([\w-]+)$/, async (req, res, [id], query, user) => {
  const item = db.getItem(user.id, id);
  if (!item) return json(res, 404, { error: '文章不存在' });
  json(res, 200, {
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

route('POST', /^\/api\/items\/([\w-]+)\/read$/, async (req, res, [id], query, user) => {
  const body = await readJson(req);
  db.setRead(user.id, id, body.read !== false);
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/items\/([\w-]+)\/star$/, async (req, res, [id], query, user) => {
  const body = await readJson(req);
  db.setStarred(user.id, id, body.starred !== false);
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/mark-read$/, async (req, res, params, query, user) => {
  const body = await readJson(req);
  db.markScopeRead(user.id, parseScope(body.scope));
  json(res, 200, { ok: true });
});

/* ---- feeds ---- */

route('POST', /^\/api\/feeds\/preview$/, async (req, res) => {
  const body = await readJson(req);
  const url = String(body.url || '').trim();
  if (!url) return json(res, 400, { error: '请输入订阅地址' });
  try {
    json(res, 200, await previewFeed(url));
  } catch (err) {
    json(res, 400, { error: String(err.message || err) });
  }
});

route('POST', /^\/api\/feeds$/, async (req, res, params, query, user) => {
  const body = await readJson(req);
  const url = String(body.url || '').trim();
  if (!url) return json(res, 400, { error: '请输入订阅地址' });

  let preview;
  try {
    preview = await previewFeed(url);
  } catch (err) {
    return json(res, 400, { error: String(err.message || err) });
  }

  if (db.getFeedByUrl(user.id, preview.url)) return json(res, 409, { error: '该订阅已经存在' });

  const folderId =
    body.folderId && db.listFolders(user.id).some((f) => f.id === body.folderId) ? body.folderId : null;

  const feed = db.createFeed(user.id, {
    title: String(body.title || '').trim() || preview.title || url,
    url: preview.url,
    siteUrl: preview.siteUrl,
    description: preview.description,
    iconUrl: preview.iconUrl,
    folderId,
  });

  const record = db.getFeed(user.id, feed.id);
  const result = await feeds.refreshFeed(record);
  json(res, 200, {
    feed: feedWithUnread(db.getFeed(user.id, feed.id), db.counts(user.id).perFeed),
    added: result.added || 0,
    error: result.status === 'error' ? result.error : null,
  });
});

route('PATCH', /^\/api\/feeds\/([\w-]+)$/, async (req, res, [id], query, user) => {
  const body = await readJson(req);
  const feed = db.getFeed(user.id, id);
  if (!feed) return json(res, 404, { error: '订阅不存在' });
  const meta = {};
  if (body.title !== undefined) meta.title = String(body.title).trim().slice(0, 200) || feed.title;
  if (body.folderId !== undefined) {
    meta.folder_id =
      body.folderId && db.listFolders(user.id).some((f) => f.id === body.folderId) ? body.folderId : null;
  }
  db.updateFeedMeta(id, meta);
  json(res, 200, { ok: true });
});

route('DELETE', /^\/api\/feeds\/([\w-]+)$/, async (req, res, [id], query, user) => {
  db.deleteFeed(user.id, id);
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/feeds\/([\w-]+)\/refresh$/, async (req, res, [id], query, user) => {
  const feed = db.getFeed(user.id, id);
  if (!feed) return json(res, 404, { error: '订阅不存在' });
  const result = await feeds.refreshFeed(feed);
  json(res, 200, {
    ...result,
    feed: feedWithUnread(db.getFeed(user.id, id), db.counts(user.id).perFeed),
  });
});

/* ---- folders ---- */

route('POST', /^\/api\/folders$/, async (req, res, params, query, user) => {
  const body = await readJson(req);
  const name = String(body.name || '').trim();
  if (!name) return json(res, 400, { error: '请输入文件夹名称' });
  json(res, 200, { folder: db.createFolder(user.id, name) });
});

route('PATCH', /^\/api\/folders\/([\w-]+)$/, async (req, res, [id], query, user) => {
  const body = await readJson(req);
  const name = String(body.name || '').trim();
  if (!name) return json(res, 400, { error: '请输入文件夹名称' });
  db.renameFolder(user.id, id, name);
  json(res, 200, { ok: true });
});

route('DELETE', /^\/api\/folders\/([\w-]+)$/, async (req, res, [id], query, user) => {
  db.deleteFolder(user.id, id);
  json(res, 200, { ok: true });
});

/* ---- opml ---- */

route('GET', /^\/api\/opml$/, async (req, res, params, query, user) => {
  const xml = opml.buildOpml(user.id);
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'content-type': 'text/x-opml; charset=utf-8',
    'content-disposition': `attachment; filename="feednest-subscriptions-${stamp}.opml"`,
    'cache-control': 'no-store',
  });
  res.end(xml);
});

route('POST', /^\/api\/opml$/, async (req, res, params, query, user) => {
  const raw = await readBody(req);
  if (!raw.trim()) return json(res, 400, { error: '文件内容为空' });
  let entries;
  try {
    entries = opml.parseOpml(raw);
  } catch (err) {
    return json(res, 400, { error: String(err.message || err) });
  }
  if (!entries.length) return json(res, 400, { error: '没有在文件中找到订阅' });

  const result = opml.importEntries(user.id, entries);
  json(res, 200, {
    added: result.added,
    skipped: result.skipped,
    foldersCreated: result.foldersCreated,
    total: entries.length,
  });

  if (result.newFeedIds.length) {
    const toRefresh = result.newFeedIds.map((id) => db.getFeed(user.id, id)).filter(Boolean);
    setTimeout(() => {
      feeds
        .refreshMany(toRefresh, {
          mode: 'import',
          concurrency: 5,
          userId: user.id,
          progress: feeds.getProgress(user.id),
        })
        .catch(() => {});
    }, 300);
  }
});

/* ---- refresh ---- */

route('POST', /^\/api\/refresh$/, async (req, res, params, query, user) => {
  const body = await readJson(req).catch(() => ({}));
  const target = String(body.scope || 'all');
  const userProgress = feeds.getProgress(user.id);
  if (userProgress.running) return json(res, 200, { started: false, progress: feeds.getProgressSnapshot(user.id) });

  if (target === 'due') {
    const settings = db.getSettings(user.id);
    const due = db.listFeeds(user.id).filter((f) => feeds.isDue(f, settings));
    if (!due.length) return json(res, 200, { started: false, progress: feeds.getProgressSnapshot(user.id), empty: true });
    feeds.refreshMany(due, { mode: 'due', userId: user.id, progress: userProgress }).catch(() => {});
    return json(res, 200, { started: true, progress: feeds.getProgressSnapshot(user.id) });
  }

  const scope = parseScope(target);
  let list = db.listFeeds(user.id);
  if (scope.type === 'feed') list = list.filter((f) => f.id === scope.id);
  if (scope.type === 'folder') list = list.filter((f) => f.folder_id === scope.id);
  if (!list.length) return json(res, 200, { started: false, progress: feeds.getProgressSnapshot(user.id), empty: true });

  feeds.refreshMany(list, { mode: 'manual', userId: user.id, progress: userProgress }).catch(() => {});
  json(res, 200, { started: true, progress: feeds.getProgressSnapshot(user.id) });
});

route('GET', /^\/api\/refresh\/status$/, async (req, res, params, query, user) => {
  json(res, 200, feeds.getProgressSnapshot(user.id));
});

/* ---- settings / stats ---- */

route('POST', /^\/api\/settings$/, async (req, res, params, query, user) => {
  const body = await readJson(req);
  if (body.refreshInterval !== undefined) {
    db.setSetting(user.id, 'refreshInterval', Math.max(300, Math.min(Number(body.refreshInterval) || 1800, 86400)));
  }
  if (body.maxItemsPerFeed !== undefined) {
    db.setSetting(user.id, 'maxItemsPerFeed', Math.max(20, Math.min(Number(body.maxItemsPerFeed) || 300, 5000)));
  }
  if (body.pushEnabled !== undefined) {
    db.setSetting(user.id, 'pushEnabled', !!body.pushEnabled);
  }
  if (body.pushToken !== undefined) {
    db.setSetting(user.id, 'pushToken', String(body.pushToken || '').trim().slice(0, 200));
  }
  if (body.language !== undefined) {
    db.setSetting(user.id, 'language', ['zh-CN', 'zh-TW', 'en'].includes(body.language) ? body.language : 'zh-CN');
  }
  json(res, 200, { settings: db.getSettings(user.id) });
});

route('POST', /^\/api\/reorder$/, async (req, res, params, query, user) => {
  const body = await readJson(req).catch(() => ({}));
  const type = String(body.type || '');
  const id = String(body.id || '');
  if (!id) return json(res, 400, { error: '缺少 id' });
  try {
    if (type === 'folder') {
      return json(res, 200, { ok: true, ...db.reorderFolder(user.id, id, body.beforeId || null) });
    }
    if (type !== 'feed') return json(res, 400, { error: 'type 只能是 feed 或 folder' });
    json(res, 200, { ok: true, ...db.reorderFeed(user.id, id, body.folderId || null, body.beforeId || null) });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

route('POST', /^\/api\/push\/test$/, async (req, res, params, query, user) => {
  const body = await readJson(req).catch(() => ({}));
  const token = String(body.token || '').trim() || db.getSettings(user.id).pushToken;
  if (!token) return json(res, 400, { error: '请先填写 PushPlus Token' });
  try {
    await push.sendPushPlus(
      token,
      'FeedNest 推送测试',
      '<p>收到这条消息说明 PushPlus 配置成功。</p><p>以后订阅有新文章时会按这个格式推送。</p>'
    );
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

route('GET', /^\/api\/stats$/, async (req, res, params, query, user) => {
  json(res, 200, {
    feeds: db.feedStats(user.id).map((r) => ({
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

route('POST', /^\/api\/subscriptions\/clear$/, async (req, res, params, query, user) => {
  const removed = db.clearUserSubscriptions(user.id);
  json(res, 200, { ok: true, removed });
});

route(
  'POST',
  /^\/api\/admin\/reset$/,
  async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    if (String(body.confirm || '') !== 'RESET') {
      return json(res, 400, { error: '确认口令不正确，请输入 RESET' });
    }
    const result = db.resetInstance();
    clearSessionCookie(req, res);
    json(res, 200, { ok: true, ...result });
  },
  { admin: true }
);

route('GET', /^\/api\/health$/, async (req, res) => {
  json(res, 200, { ok: true, version: VERSION });
}, { auth: false });

/* --------------------------- static files --------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, data) => {
        if (e2) return res.writeHead(404).end('Not found');
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------ server ------------------------------ */

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / 非浏览器客户端
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating && !sameOrigin(req)) return json(res, 403, { error: '非法来源' });

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(url.pathname);
      if (!match) continue;

      try {
        let user = null;
        if (r.auth || r.admin) {
          user = db.getSessionUser(parseCookies(req)[COOKIE_NAME]);
          if (!user) return json(res, 401, { error: '未登录', needLogin: true });
          if (r.admin && user.role !== 'admin') return json(res, 403, { error: '需要管理员权限' });
        }
        await r.handler(req, res, match.slice(1), url.searchParams, user);
      } catch (err) {
        console.error('[api]', req.method, url.pathname, err);
        if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
      }
      return;
    }
    return json(res, 404, { error: '接口不存在' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.writeHead(405).end('Method not allowed');
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`FeedNest 已启动: http://localhost:${PORT}  (数据目录: ${db.DATA_DIR})`);
  if (proxyUrl()) console.log(`[proxy] 使用代理 ${proxyUrl()}`);
  feeds.startScheduler();
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
