'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'feednest.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');

/* ------------------------------ schema ------------------------------ */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'user',
  disabled            INTEGER NOT NULL DEFAULT 0,
  is_default_password INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  last_login_at       INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  folder_id        TEXT,
  title            TEXT NOT NULL,
  url              TEXT NOT NULL,
  site_url         TEXT,
  description      TEXT,
  icon_url         TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  refresh_interval INTEGER,
  etag             TEXT,
  last_modified    TEXT,
  last_fetch_at    INTEGER,
  last_status      TEXT,
  last_error       TEXT,
  error_count      INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  feed_id      TEXT NOT NULL,
  guid         TEXT NOT NULL,
  title        TEXT,
  link         TEXT,
  author       TEXT,
  published_at INTEGER NOT NULL,
  summary      TEXT,
  content      TEXT,
  thumbnail    TEXT,
  read         INTEGER NOT NULL DEFAULT 0,
  starred      INTEGER NOT NULL DEFAULT 0,
  fetched_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_feed_date ON items(feed_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_date ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_unread ON items(read, published_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL DEFAULT '',
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (user_id, key)
);
`);

/* ------------------------------ helpers ------------------------------ */

const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

function all(sql, ...params) {
  return prep(sql).all(...params);
}
function get(sql, ...params) {
  return prep(sql).get(...params);
}
function run(sql, ...params) {
  return prep(sql).run(...params);
}
function uid() {
  return crypto.randomUUID();
}
function itemId(feedId, guid) {
  return crypto.createHash('sha1').update(feedId + '\u0000' + guid).digest('hex').slice(0, 24);
}

/* ------------------------------ users ------------------------------ */

const DEFAULT_SETTINGS = {
  refreshInterval: 1800,
  maxItemsPerFeed: 300,
  pushEnabled: false,
  pushToken: '',
  language: 'zh-CN',
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const hash = crypto.scryptSync(String(password), salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: !!row.disabled,
    isDefaultPassword: !!row.is_default_password,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function getUserById(id) {
  return get('SELECT * FROM users WHERE id = ?', id);
}

function getUserByName(username) {
  return get('SELECT * FROM users WHERE username = ?', String(username || '').trim());
}

function listUsers() {
  return all('SELECT * FROM users ORDER BY role DESC, created_at ASC').map(publicUser);
}

function countAdmins() {
  return get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0").c;
}

function createUser({ username, password, role = 'user', isDefaultPassword = false }) {
  const name = String(username || '').trim();
  if (!/^[\w\u4e00-\u9fa5.@-]{2,32}$/.test(name)) {
    throw new Error('用户名需为 2-32 位字母、数字、下划线或中文');
  }
  if (String(password || '').length < 4) throw new Error('密码至少 4 位');
  if (getUserByName(name)) throw new Error('用户名已存在');

  const row = {
    id: uid(),
    username: name,
    password_hash: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    is_default_password: isDefaultPassword ? 1 : 0,
    created_at: Date.now(),
  };
  run(
    'INSERT INTO users(id, username, password_hash, role, disabled, is_default_password, created_at) VALUES(?, ?, ?, ?, 0, ?, ?)',
    row.id, row.username, row.password_hash, row.role, row.is_default_password, row.created_at
  );
  return getUserById(row.id);
}

function setUserPassword(id, password) {
  if (String(password || '').length < 4) throw new Error('密码至少 4 位');
  run('UPDATE users SET password_hash = ?, is_default_password = 0 WHERE id = ?', hashPassword(password), id);
  run('DELETE FROM sessions WHERE user_id = ?', id); // 改密码后强制重新登录
}

function updateUser(id, { role, disabled }) {
  const user = getUserById(id);
  if (!user) throw new Error('用户不存在');
  if (role !== undefined) {
    const nextRole = role === 'admin' ? 'admin' : 'user';
    if (user.role === 'admin' && nextRole !== 'admin' && countAdmins() <= 1) {
      throw new Error('至少需要保留一个管理员');
    }
    run('UPDATE users SET role = ? WHERE id = ?', nextRole, id);
  }
  if (disabled !== undefined) {
    if (user.role === 'admin' && disabled && countAdmins() <= 1) {
      throw new Error('至少需要保留一个可用的管理员');
    }
    run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id);
    if (disabled) run('DELETE FROM sessions WHERE user_id = ?', id);
  }
}

function deleteUser(id) {
  const user = getUserById(id);
  if (!user) return;
  if (user.role === 'admin' && countAdmins() <= 1) throw new Error('至少需要保留一个管理员');
  run('DELETE FROM items WHERE feed_id IN (SELECT id FROM feeds WHERE user_id = ?)', id);
  run('DELETE FROM feeds WHERE user_id = ?', id);
  run('DELETE FROM folders WHERE user_id = ?', id);
  run('DELETE FROM settings WHERE user_id = ?', id);
  run('DELETE FROM sessions WHERE user_id = ?', id);
  run('DELETE FROM users WHERE id = ?', id);
}

/* ------------------------- 清空 / 初始化 ------------------------- */

/** 清空某个用户的全部订阅、文件夹与文章（账号本身保留） */
function clearUserSubscriptions(userId) {
  const stats = {
    feeds: get('SELECT COUNT(*) AS c FROM feeds WHERE user_id = ?', userId).c,
    items: get('SELECT COUNT(*) AS c FROM items WHERE feed_id IN (SELECT id FROM feeds WHERE user_id = ?)', userId).c,
    folders: get('SELECT COUNT(*) AS c FROM folders WHERE user_id = ?', userId).c,
  };
  db.exec('BEGIN');
  try {
    run('DELETE FROM items WHERE feed_id IN (SELECT id FROM feeds WHERE user_id = ?)', userId);
    run('DELETE FROM feeds WHERE user_id = ?', userId);
    run('DELETE FROM folders WHERE user_id = ?', userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return stats;
}

/**
 * 初始化（恢复出厂）：清空所有用户的订阅/文章/文件夹、清空设置、
 * 把所有账号强制下线，并把管理员密码重置为 admin。
 * 账号本身保留（不会删除普通用户）。
 */
function resetInstance() {
  const stats = {
    feeds: get('SELECT COUNT(*) AS c FROM feeds').c,
    items: get('SELECT COUNT(*) AS c FROM items').c,
    folders: get('SELECT COUNT(*) AS c FROM folders').c,
    users: get('SELECT COUNT(*) AS c FROM users').c,
  };

  db.exec('BEGIN');
  try {
    run('DELETE FROM items');
    run('DELETE FROM feeds');
    run('DELETE FROM folders');
    run('DELETE FROM settings');
    run('DELETE FROM sessions');

    let admin = getUserByName('admin');
    if (admin) {
      run(
        'UPDATE users SET password_hash = ?, is_default_password = 1, disabled = 0, role = ? WHERE id = ?',
        hashPassword('admin'),
        'admin',
        admin.id
      );
    } else {
      admin = createUser({ username: 'admin', password: 'admin', role: 'admin', isDefaultPassword: true });
    }
    db.exec('COMMIT');
    return { ...stats, admin: admin.username };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ----------------------------- sessions ----------------------------- */

const SESSION_TTL = 30 * 24 * 3600 * 1000;

function createSession(userId, { userAgent, ip } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  run(
    'INSERT INTO sessions(id, user_id, created_at, expires_at, user_agent, ip) VALUES(?, ?, ?, ?, ?, ?)',
    id, userId, now, now + SESSION_TTL, String(userAgent || '').slice(0, 200), String(ip || '').slice(0, 60)
  );
  run('DELETE FROM sessions WHERE expires_at < ?', now);
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const id = crypto.createHash('sha256').update(token).digest('hex');
  const row = get(
    `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
    id, Date.now()
  );
  if (!row) return null;
  if (row.disabled) {
    run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  return row;
}

function destroySession(token) {
  if (!token) return;
  const id = crypto.createHash('sha256').update(token).digest('hex');
  run('DELETE FROM sessions WHERE id = ?', id);
}

function touchLogin(userId) {
  run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), userId);
}

/* ----------------------------- settings ----------------------------- */

function getSettings(userId) {
  const out = { ...DEFAULT_SETTINGS };
  const apply = (rows) => {
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = row.value;
      }
    }
  };
  apply(all("SELECT key, value FROM settings WHERE user_id = ''"));
  if (userId) apply(all('SELECT key, value FROM settings WHERE user_id = ?', userId));
  return out;
}

function setSetting(userId, key, value) {
  run(
    `INSERT INTO settings(user_id, key, value) VALUES(?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    userId || '', key, JSON.stringify(value)
  );
}

/* ------------------------------ folders ------------------------------ */

function listFolders(userId) {
  return all('SELECT * FROM folders WHERE user_id = ? ORDER BY position ASC, created_at ASC', userId);
}

/* ------------------------- 拖拽排序 ------------------------- */

/**
 * 把订阅移动到目标文件夹，并放到 beforeId 之前（null = 末尾）。
 * 同级重新编号（100,200,300…），保证顺序稳定。
 */
function reorderFeed(userId, feedId, folderId, beforeId) {
  const feeds = listFeeds(userId);
  const target = feeds.find((f) => f.id === feedId);
  if (!target) throw new Error('订阅不存在');

  let dest = folderId || null;
  if (dest && !listFolders(userId).some((f) => f.id === dest)) dest = null;

  const siblings = feeds.filter((f) => f.id !== feedId && (f.folder_id || null) === dest);
  const idx = beforeId ? siblings.findIndex((f) => f.id === beforeId) : -1;
  siblings.splice(idx < 0 ? siblings.length : idx, 0, target);

  db.exec('BEGIN');
  try {
    siblings.forEach((f, i) => {
      run('UPDATE feeds SET sort_order = ?, folder_id = ? WHERE id = ?', (i + 1) * 100, dest, f.id);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { id: feedId, folderId: dest, position: siblings.findIndex((f) => f.id === feedId) };
}

/** 调整文件夹顺序（beforeId = null 表示放到末尾） */
function reorderFolder(userId, folderId, beforeId) {
  const folders = listFolders(userId);
  const target = folders.find((f) => f.id === folderId);
  if (!target) throw new Error('文件夹不存在');
  const rest = folders.filter((f) => f.id !== folderId);
  const idx = beforeId ? rest.findIndex((f) => f.id === beforeId) : -1;
  rest.splice(idx < 0 ? rest.length : idx, 0, target);

  db.exec('BEGIN');
  try {
    rest.forEach((f, i) => run('UPDATE folders SET position = ? WHERE id = ?', (i + 1) * 100, f.id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { id: folderId, position: rest.findIndex((f) => f.id === folderId) };
}

function createFolder(userId, name) {
  const row = {
    id: uid(),
    user_id: userId,
    name: String(name || '新文件夹').slice(0, 120),
    position: Date.now(),
    created_at: Date.now(),
  };
  run('INSERT INTO folders(id, user_id, name, position, created_at) VALUES(?, ?, ?, ?, ?)',
    row.id, row.user_id, row.name, row.position, row.created_at);
  return row;
}

function renameFolder(userId, id, name) {
  run('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?', String(name).slice(0, 120), id, userId);
}

function deleteFolder(userId, id) {
  run('UPDATE feeds SET folder_id = NULL WHERE folder_id = ? AND user_id = ?', id, userId);
  run('DELETE FROM folders WHERE id = ? AND user_id = ?', id, userId);
}

/* ------------------------------- feeds ------------------------------- */

function listFeeds(userId) {
  return all('SELECT * FROM feeds WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC', userId);
}

function listAllFeeds() {
  return all('SELECT * FROM feeds');
}

function getFeed(userId, id) {
  return get('SELECT * FROM feeds WHERE id = ? AND user_id = ?', id, userId);
}

function getFeedByUrl(userId, url) {
  return get('SELECT * FROM feeds WHERE user_id = ? AND url = ?', userId, url);
}

function createFeed(userId, { title, url, siteUrl, description, iconUrl, folderId }) {
  const row = {
    id: uid(),
    user_id: userId,
    folder_id: folderId || null,
    title: String(title || url).slice(0, 200),
    url,
    site_url: siteUrl || null,
    description: description || null,
    icon_url: iconUrl || null,
    sort_order: Date.now(),
    created_at: Date.now(),
  };
  run(
    `INSERT INTO feeds(id, user_id, folder_id, title, url, site_url, description, icon_url, sort_order, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.user_id, row.folder_id, row.title, row.url, row.site_url, row.description, row.icon_url,
    row.sort_order, row.created_at
  );
  return row;
}

function updateFeedMeta(id, meta) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (!fields.length) return;
  run(`UPDATE feeds SET ${fields.join(', ')} WHERE id = ?`, ...values, id);
}

function deleteFeed(userId, id) {
  const feed = getFeed(userId, id);
  if (!feed) return false;
  run('DELETE FROM items WHERE feed_id = ?', id);
  run('DELETE FROM feeds WHERE id = ?', id);
  return true;
}

/* ------------------------------- items ------------------------------- */

function upsertItems(feedId, entries, maxItems) {
  const now = Date.now();
  const insert = prep(
    `INSERT INTO items(id, feed_id, guid, title, link, author, published_at, summary, content, thumbnail, read, starred, fetched_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       link = excluded.link,
       author = excluded.author,
       published_at = excluded.published_at,
       summary = excluded.summary,
       content = excluded.content,
       thumbnail = excluded.thumbnail,
       fetched_at = excluded.fetched_at`
  );

  let added = 0;
  const newItems = [];
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      const id = itemId(feedId, e.guid);
      const exists = get('SELECT read FROM items WHERE id = ?', id);
      insert.run(
        id, feedId, e.guid, e.title || '(无标题)', e.link || null, e.author || null,
        e.publishedAt || now, e.summary || '', e.content || '', e.thumbnail || null, now
      );
      if (!exists) {
        added++;
        newItems.push({ title: e.title || '(无标题)', link: e.link || null, publishedAt: e.publishedAt || now });
      }
    }
    if (maxItems > 0) {
      run(
        `DELETE FROM items WHERE feed_id = ? AND id NOT IN (
           SELECT id FROM items WHERE feed_id = ? ORDER BY published_at DESC, id DESC LIMIT ?
         )`,
        feedId, feedId, maxItems
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { added, newItems };
}

const ITEM_LIST_COLUMNS =
  'i.id, i.feed_id, i.title, i.link, i.author, i.published_at, i.summary, i.thumbnail, i.read, i.starred';

function buildScopeWhere(userId, scope, params) {
  let where = ' AND f.user_id = ?';
  params.push(userId);
  if (!scope || scope.type === 'all') return where;
  if (scope.type === 'starred') return where + ' AND i.starred = 1';
  if (scope.type === 'feed') {
    params.push(scope.id);
    return where + ' AND i.feed_id = ?';
  }
  if (scope.type === 'folder') {
    params.push(scope.id);
    return where + ' AND f.folder_id = ?';
  }
  return where;
}

function listItems({ userId, scope, unread, starred, q, sort, limit = 60, offset = 0 }) {
  const params = [];
  let where = ' WHERE 1=1' + buildScopeWhere(userId, scope, params);
  if (unread) where += ' AND i.read = 0';
  if (starred) where += ' AND i.starred = 1';
  if (q) {
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    where += ' AND (i.title LIKE ? OR i.summary LIKE ? OR f.title LIKE ?)';
  }
  const order = sort === 'oldest' ? 'ASC' : 'DESC';

  const total = get(
    `SELECT COUNT(*) AS c FROM items i JOIN feeds f ON f.id = i.feed_id${where}`,
    ...params
  ).c;

  const rows = all(
    `SELECT ${ITEM_LIST_COLUMNS}, f.title AS feed_title, f.icon_url AS feed_icon
     FROM items i JOIN feeds f ON f.id = i.feed_id${where}
     ORDER BY i.published_at ${order}, i.id ${order}
     LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );

  return { total, items: rows };
}

function getItem(userId, id) {
  return get(
    `SELECT i.*, f.title AS feed_title, f.site_url AS feed_site_url, f.icon_url AS feed_icon
     FROM items i JOIN feeds f ON f.id = i.feed_id
     WHERE i.id = ? AND f.user_id = ?`,
    id, userId
  );
}

function setRead(userId, id, read) {
  run(
    'UPDATE items SET read = ? WHERE id = ? AND feed_id IN (SELECT id FROM feeds WHERE user_id = ?)',
    read ? 1 : 0, id, userId
  );
}

function setStarred(userId, id, starred) {
  run(
    'UPDATE items SET starred = ? WHERE id = ? AND feed_id IN (SELECT id FROM feeds WHERE user_id = ?)',
    starred ? 1 : 0, id, userId
  );
}

function markScopeRead(userId, scope) {
  const params = [];
  const where = buildScopeWhere(userId, scope, params);
  run(
    `UPDATE items SET read = 1 WHERE id IN (
       SELECT i.id FROM items i JOIN feeds f ON f.id = i.feed_id WHERE i.read = 0${where}
     )`,
    ...params
  );
}

function counts(userId) {
  const perFeed = new Map();
  for (const row of all(
    `SELECT i.feed_id, COUNT(*) AS c FROM items i JOIN feeds f ON f.id = i.feed_id
     WHERE i.read = 0 AND f.user_id = ? GROUP BY i.feed_id`,
    userId
  )) {
    perFeed.set(row.feed_id, row.c);
  }
  const base = `FROM items i JOIN feeds f ON f.id = i.feed_id WHERE f.user_id = ?`;
  return {
    perFeed,
    totalUnread: get(`SELECT COUNT(*) AS c ${base} AND i.read = 0`, userId).c,
    totalItems: get(`SELECT COUNT(*) AS c ${base}`, userId).c,
    starred: get(`SELECT COUNT(*) AS c ${base} AND i.starred = 1`, userId).c,
  };
}

function feedStats(userId) {
  return all(
    `SELECT f.id, f.title, f.url, f.last_fetch_at, f.last_status, f.last_error,
            COUNT(i.id) AS total,
            SUM(CASE WHEN i.read = 0 THEN 1 ELSE 0 END) AS unread
     FROM feeds f LEFT JOIN items i ON i.feed_id = f.id
     WHERE f.user_id = ?
     GROUP BY f.id ORDER BY total DESC`,
    userId
  );
}

/* ----------------------------- migration ----------------------------- */

function ensureAdmin() {
  const existing = getUserByName('admin');
  if (existing) return existing;
  const anyAdmin = get("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
  if (anyAdmin) return anyAdmin;
  const created = createUser({ username: 'admin', password: 'admin', role: 'admin', isDefaultPassword: true });
  console.log('[init] 已创建默认管理员 admin / admin');
  return created;
}

function migrate() {
  const version = Number(get('PRAGMA user_version').user_version || 0);
  if (version >= 1) return;

  const folderCols = all('PRAGMA table_info(folders)').map((c) => c.name);
  const feedCols = all('PRAGMA table_info(feeds)').map((c) => c.name);
  const settingsCols = all('PRAGMA table_info(settings)').map((c) => c.name);

  const needsRebuild = !folderCols.includes('user_id') || !feedCols.includes('user_id');
  const admin = ensureAdmin();
  const adminId = admin.id;

  if (needsRebuild) {
    console.log('[migrate] 检测到旧版数据，正在迁移到多用户结构…');
    db.exec('BEGIN');
    try {
      if (!folderCols.includes('user_id')) {
        db.exec(`CREATE TABLE folders_new (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
        db.exec(`INSERT INTO folders_new(id, user_id, name, position, created_at)
                 SELECT id, '${adminId}', name, position, created_at FROM folders`);
        db.exec('DROP TABLE folders');
        db.exec('ALTER TABLE folders_new RENAME TO folders');
        db.exec('CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id)');
      }
      if (!feedCols.includes('user_id')) {
        db.exec(`CREATE TABLE feeds_new (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, folder_id TEXT, title TEXT NOT NULL,
          url TEXT NOT NULL, site_url TEXT, description TEXT, icon_url TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0, refresh_interval INTEGER,
          etag TEXT, last_modified TEXT, last_fetch_at INTEGER, last_status TEXT,
          last_error TEXT, error_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
        db.exec(`INSERT INTO feeds_new(id, user_id, folder_id, title, url, site_url, description, icon_url,
                   sort_order, refresh_interval, etag, last_modified, last_fetch_at, last_status,
                   last_error, error_count, created_at)
                 SELECT id, '${adminId}', folder_id, title, url, site_url, description, icon_url,
                   sort_order, refresh_interval, etag, last_modified, last_fetch_at, last_status,
                   last_error, error_count, created_at FROM feeds`);
        db.exec('DROP TABLE feeds');
        db.exec('ALTER TABLE feeds_new RENAME TO feeds');
        db.exec('CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_feeds_folder ON feeds(folder_id)');
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log('[migrate] 原有订阅已归属到管理员账号');
  }

  if (!settingsCols.includes('user_id')) {
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE settings_new (
        user_id TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, value TEXT,
        PRIMARY KEY (user_id, key))`);
      db.exec(`INSERT INTO settings_new(user_id, key, value) SELECT '', key, value FROM settings`);
      db.exec('DROP TABLE settings');
      db.exec('ALTER TABLE settings_new RENAME TO settings');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // 同一用户同一地址只能订阅一次
  db.exec('CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_feeds_folder ON feeds(folder_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_user_url ON feeds(user_id, url)');

  db.exec('PRAGMA user_version = 1');
  console.log('[migrate] 数据结构版本 → 1（多用户）');
}

migrate();

module.exports = {
  DATA_DIR,
  db,
  all,
  get,
  run,
  uid,
  hashPassword,
  verifyPassword,
  publicUser,
  getUserById,
  getUserByName,
  listUsers,
  countAdmins,
  createUser,
  setUserPassword,
  updateUser,
  deleteUser,
  reorderFeed,
  reorderFolder,
  clearUserSubscriptions,
  resetInstance,
  createSession,
  getSessionUser,
  destroySession,
  touchLogin,
  getSettings,
  setSetting,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  listFeeds,
  listAllFeeds,
  getFeed,
  getFeedByUrl,
  createFeed,
  updateFeedMeta,
  deleteFeed,
  upsertItems,
  listItems,
  getItem,
  setRead,
  setStarred,
  markScopeRead,
  counts,
  feedStats,
};
