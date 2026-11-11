/**
 * D1 数据层 —— 与 server/db.js 同样的表结构与业务语义，只是全部改成异步。
 * D1 不支持交互式事务，批量写用 db.batch()。
 */

const DEFAULT_SETTINGS = { refreshInterval: 1800, maxItemsPerFeed: 300, pushEnabled: false, pushToken: '', language: 'zh-CN' };

export class Db {
  constructor(d1) {
    this.d1 = d1;
  }

  async all(sql, ...params) {
    const res = await this.d1.prepare(sql).bind(...params).all();
    return res.results || [];
  }

  async first(sql, ...params) {
    return (await this.d1.prepare(sql).bind(...params).first()) || null;
  }

  async run(sql, ...params) {
    return this.d1.prepare(sql).bind(...params).run();
  }

  async batch(statements) {
    if (!statements.length) return;
    for (let i = 0; i < statements.length; i += 40) {
      await this.d1.batch(statements.slice(i, i + 40));
    }
  }

  /* ---------------- 用户 ---------------- */

  async getUserByName(username) {
    return this.first('SELECT * FROM users WHERE username = ?', String(username || '').trim());
  }

  async getUserById(id) {
    return this.first('SELECT * FROM users WHERE id = ?', id);
  }

  async listUsers() {
    return this.all('SELECT * FROM users ORDER BY role DESC, created_at ASC');
  }

  async countAdmins() {
    return (await this.first("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0")).c;
  }

  async countUsers() {
    return (await this.first('SELECT COUNT(*) AS c FROM users')).c;
  }

  async insertUser(row) {
    await this.run(
      `INSERT INTO users(id, username, password_hash, role, disabled, is_default_password, created_at)
       VALUES(?, ?, ?, ?, 0, ?, ?)`,
      row.id, row.username, row.password_hash, row.role, row.is_default_password ? 1 : 0, row.created_at
    );
    return this.getUserById(row.id);
  }

  async setPassword(id, hash) {
    await this.run('UPDATE users SET password_hash = ?, is_default_password = 0 WHERE id = ?', hash, id);
    await this.run('DELETE FROM sessions WHERE user_id = ?', id);
  }

  async updateUser(id, { role, disabled }) {
    if (role !== undefined) await this.run('UPDATE users SET role = ? WHERE id = ?', role, id);
    if (disabled !== undefined) {
      await this.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id);
      if (disabled) await this.run('DELETE FROM sessions WHERE user_id = ?', id);
    }
  }

  async deleteUser(id) {
    await this.run('DELETE FROM items WHERE feed_id IN (SELECT id FROM feeds WHERE user_id = ?)', id);
    await this.run('DELETE FROM feeds WHERE user_id = ?', id);
    await this.run('DELETE FROM folders WHERE user_id = ?', id);
    await this.run('DELETE FROM settings WHERE user_id = ?', id);
    await this.run('DELETE FROM sessions WHERE user_id = ?', id);
    await this.run('DELETE FROM users WHERE id = ?', id);
  }

  /* ---------------- 清空 / 初始化 ---------------- */

  /** 清空某个用户的全部订阅、文件夹与文章（账号保留） */
  async clearUserSubscriptions(userId) {
    const stats = {
      feeds: (await this.first('SELECT COUNT(*) AS c FROM feeds WHERE user_id = ?', userId)).c,
      items: (await this.first('SELECT COUNT(*) AS c FROM items WHERE feed_id IN (SELECT id FROM feeds WHERE user_id = ?)', userId)).c,
      folders: (await this.first('SELECT COUNT(*) AS c FROM folders WHERE user_id = ?', userId)).c,
    };
    await this.batch([
      this.d1.prepare('DELETE FROM items WHERE feed_id IN (SELECT id FROM feeds WHERE user_id = ?)').bind(userId),
      this.d1.prepare('DELETE FROM feeds WHERE user_id = ?').bind(userId),
      this.d1.prepare('DELETE FROM folders WHERE user_id = ?').bind(userId),
    ]);
    return stats;
  }

  /**
   * 初始化（恢复出厂）：清空所有订阅/文章/文件夹与设置，踢掉所有会话，
   * 管理员密码重置为 admin。账号保留。
   * @param {string} adminHash 预先算好的 admin 密码哈希
   */
  async resetInstance(adminHash) {
    const stats = {
      feeds: (await this.first('SELECT COUNT(*) AS c FROM feeds')).c,
      items: (await this.first('SELECT COUNT(*) AS c FROM items')).c,
      folders: (await this.first('SELECT COUNT(*) AS c FROM folders')).c,
      users: (await this.first('SELECT COUNT(*) AS c FROM users')).c,
    };
    const admin = await this.getUserByName('admin');
    const stmts = [
      this.d1.prepare('DELETE FROM items'),
      this.d1.prepare('DELETE FROM feeds'),
      this.d1.prepare('DELETE FROM folders'),
      this.d1.prepare('DELETE FROM settings'),
      this.d1.prepare('DELETE FROM sessions'),
    ];
    if (admin) {
      stmts.push(
        this.d1
          .prepare('UPDATE users SET password_hash = ?, is_default_password = 1, disabled = 0, role = ? WHERE id = ?')
          .bind(adminHash, 'admin', admin.id)
      );
    } else {
      stmts.push(
        this.d1
          .prepare(
            'INSERT INTO users(id, username, password_hash, role, disabled, is_default_password, created_at) VALUES(?, ?, ?, ?, 0, 1, ?)'
          )
          .bind(crypto.randomUUID(), 'admin', adminHash, 'admin', Date.now())
      );
    }
    await this.d1.batch(stmts);
    return { ...stats, admin: 'admin' };
  }

  async touchLogin(id) {
    await this.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), id);
  }

  /* ---------------- 会话 ---------------- */

  async insertSession(row) {
    await this.run(
      'INSERT INTO sessions(id, user_id, created_at, expires_at, user_agent, ip) VALUES(?, ?, ?, ?, ?, ?)',
      row.id, row.user_id, row.created_at, row.expires_at, row.user_agent, row.ip
    );
    await this.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  }

  async sessionUser(sessionId) {
    const row = await this.first(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
      sessionId, Date.now()
    );
    return row;
  }

  async deleteSession(sessionId) {
    await this.run('DELETE FROM sessions WHERE id = ?', sessionId);
  }

  /* ---------------- 设置 ---------------- */

  async getSettings(userId) {
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
    apply(await this.all("SELECT key, value FROM settings WHERE user_id = ''"));
    if (userId) apply(await this.all('SELECT key, value FROM settings WHERE user_id = ?', userId));
    return out;
  }

  async setSetting(userId, key, value) {
    await this.run(
      `INSERT INTO settings(user_id, key, value) VALUES(?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      userId || '', key, JSON.stringify(value)
    );
  }

  /* ---------------- 文件夹 ---------------- */

  async listFolders(userId) {
    return this.all('SELECT * FROM folders WHERE user_id = ? ORDER BY position ASC, created_at ASC', userId);
  }

  async createFolder(row) {
    await this.run(
      'INSERT INTO folders(id, user_id, name, position, created_at) VALUES(?, ?, ?, ?, ?)',
      row.id, row.user_id, row.name, row.position, row.created_at
    );
    return row;
  }

  async renameFolder(userId, id, name) {
    await this.run('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?', name, id, userId);
  }

  async deleteFolder(userId, id) {
    await this.run('UPDATE feeds SET folder_id = NULL WHERE folder_id = ? AND user_id = ?', id, userId);
    await this.run('DELETE FROM folders WHERE id = ? AND user_id = ?', id, userId);
  }

  /* ---------------- 订阅 ---------------- */

  /* ---------------- 拖拽排序 ---------------- */

  async reorderFeed(userId, feedId, folderId, beforeId) {
    const feeds = await this.listFeeds(userId);
    const target = feeds.find((f) => f.id === feedId);
    if (!target) throw new Error('订阅不存在');

    let dest = folderId || null;
    if (dest) {
      const folders = await this.listFolders(userId);
      if (!folders.some((f) => f.id === dest)) dest = null;
    }

    const siblings = feeds.filter((f) => f.id !== feedId && (f.folder_id || null) === dest);
    const idx = beforeId ? siblings.findIndex((f) => f.id === beforeId) : -1;
    siblings.splice(idx < 0 ? siblings.length : idx, 0, target);

    await this.batch(
      siblings.map((f, i) =>
        this.d1.prepare('UPDATE feeds SET sort_order = ?, folder_id = ? WHERE id = ?').bind((i + 1) * 100, dest, f.id)
      )
    );
    return { id: feedId, folderId: dest, position: siblings.findIndex((f) => f.id === feedId) };
  }

  async reorderFolder(userId, folderId, beforeId) {
    const folders = await this.listFolders(userId);
    const target = folders.find((f) => f.id === folderId);
    if (!target) throw new Error('文件夹不存在');
    const rest = folders.filter((f) => f.id !== folderId);
    const idx = beforeId ? rest.findIndex((f) => f.id === beforeId) : -1;
    rest.splice(idx < 0 ? rest.length : idx, 0, target);

    await this.batch(
      rest.map((f, i) => this.d1.prepare('UPDATE folders SET position = ? WHERE id = ?').bind((i + 1) * 100, f.id))
    );
    return { id: folderId, position: rest.findIndex((f) => f.id === folderId) };
  }

  async listFeeds(userId) {
    return this.all('SELECT * FROM feeds WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC', userId);
  }

  async listAllFeeds() {
    return this.all('SELECT * FROM feeds');
  }

  async getFeed(userId, id) {
    return this.first('SELECT * FROM feeds WHERE id = ? AND user_id = ?', id, userId);
  }

  async getFeedByUrl(userId, url) {
    return this.first('SELECT * FROM feeds WHERE user_id = ? AND url = ?', userId, url);
  }

  async createFeed(row) {
    await this.run(
      `INSERT INTO feeds(id, user_id, folder_id, title, url, site_url, description, icon_url, sort_order, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.user_id, row.folder_id, row.title, row.url, row.site_url, row.description,
      row.icon_url, row.sort_order, row.created_at
    );
    return row;
  }

  async updateFeedMeta(id, meta) {
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (!fields.length) return;
    await this.run(`UPDATE feeds SET ${fields.join(', ')} WHERE id = ?`, ...values, id);
  }

  async deleteFeed(userId, id) {
    const feed = await this.getFeed(userId, id);
    if (!feed) return false;
    await this.run('DELETE FROM items WHERE feed_id = ?', id);
    await this.run('DELETE FROM feeds WHERE id = ?', id);
    return true;
  }

  /* ---------------- 文章 ---------------- */

  async existingIds(ids) {
    const set = new Set();
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      const rows = await this.all(
        `SELECT id FROM items WHERE id IN (${chunk.map(() => '?').join(',')})`,
        ...chunk
      );
      rows.forEach((r) => set.add(r.id));
    }
    return set;
  }

  async upsertItems(feedId, entries, maxItems) {
    const now = Date.now();
    const rows = entries.map((e) => ({
      id: e.id,
      guid: e.guid,
      title: e.title || '(无标题)',
      link: e.link || null,
      author: e.author || null,
      publishedAt: e.publishedAt || now,
      summary: e.summary || '',
      content: e.content || '',
      thumbnail: e.thumbnail || null,
    }));

    const existing = await this.existingIds(rows.map((r) => r.id));
    let added = 0;
    const newItems = [];
    const stmts = rows.map((r) => {
      if (!existing.has(r.id)) {
        added++;
        newItems.push({ title: r.title, link: r.link, publishedAt: r.publishedAt });
      }
      return this.d1
        .prepare(
          `INSERT INTO items(id, feed_id, guid, title, link, author, published_at, summary, content, thumbnail, read, starred, fetched_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, link = excluded.link, author = excluded.author,
             published_at = excluded.published_at, summary = excluded.summary,
             content = excluded.content, thumbnail = excluded.thumbnail, fetched_at = excluded.fetched_at`
        )
        .bind(r.id, feedId, r.guid, r.title, r.link, r.author, r.publishedAt, r.summary, r.content, r.thumbnail, now);
    });
    await this.batch(stmts);

    if (maxItems > 0) {
      await this.run(
        `DELETE FROM items WHERE feed_id = ? AND id NOT IN (
           SELECT id FROM items WHERE feed_id = ? ORDER BY published_at DESC, id DESC LIMIT ?
         )`,
        feedId, feedId, maxItems
      );
    }
    return { added, newItems };
  }

  scopeWhere(userId, scope, params) {
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

  async listItems({ userId, scope, unread, q, sort, limit = 60, offset = 0 }) {
    const params = [];
    let where = ' WHERE 1=1' + this.scopeWhere(userId, scope, params);
    if (unread) where += ' AND i.read = 0';
    if (q) {
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      where += ' AND (i.title LIKE ? OR i.summary LIKE ? OR f.title LIKE ?)';
    }
    const order = sort === 'oldest' ? 'ASC' : 'DESC';

    const total = (await this.first(
      `SELECT COUNT(*) AS c FROM items i JOIN feeds f ON f.id = i.feed_id${where}`,
      ...params
    )).c;

    const items = await this.all(
      `SELECT i.id, i.feed_id, i.title, i.link, i.author, i.published_at, i.summary,
              i.thumbnail, i.read, i.starred, f.title AS feed_title, f.icon_url AS feed_icon
       FROM items i JOIN feeds f ON f.id = i.feed_id${where}
       ORDER BY i.published_at ${order}, i.id ${order}
       LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );
    return { total, items };
  }

  async getItem(userId, id) {
    return this.first(
      `SELECT i.*, f.title AS feed_title, f.site_url AS feed_site_url, f.icon_url AS feed_icon
       FROM items i JOIN feeds f ON f.id = i.feed_id
       WHERE i.id = ? AND f.user_id = ?`,
      id, userId
    );
  }

  async setRead(userId, id, read) {
    await this.run(
      'UPDATE items SET read = ? WHERE id = ? AND feed_id IN (SELECT id FROM feeds WHERE user_id = ?)',
      read ? 1 : 0, id, userId
    );
  }

  async setStarred(userId, id, starred) {
    await this.run(
      'UPDATE items SET starred = ? WHERE id = ? AND feed_id IN (SELECT id FROM feeds WHERE user_id = ?)',
      starred ? 1 : 0, id, userId
    );
  }

  async markScopeRead(userId, scope) {
    const params = [];
    const where = this.scopeWhere(userId, scope, params);
    await this.run(
      `UPDATE items SET read = 1 WHERE id IN (
         SELECT i.id FROM items i JOIN feeds f ON f.id = i.feed_id WHERE i.read = 0${where}
       )`,
      ...params
    );
  }

  async counts(userId) {
    const perFeed = new Map();
    for (const row of await this.all(
      `SELECT i.feed_id, COUNT(*) AS c FROM items i JOIN feeds f ON f.id = i.feed_id
       WHERE i.read = 0 AND f.user_id = ? GROUP BY i.feed_id`,
      userId
    )) {
      perFeed.set(row.feed_id, row.c);
    }
    const base = 'FROM items i JOIN feeds f ON f.id = i.feed_id WHERE f.user_id = ?';
    const totalUnread = (await this.first(`SELECT COUNT(*) AS c ${base} AND i.read = 0`, userId)).c;
    const totalItems = (await this.first(`SELECT COUNT(*) AS c ${base}`, userId)).c;
    const starred = (await this.first(`SELECT COUNT(*) AS c ${base} AND i.starred = 1`, userId)).c;
    return { perFeed, totalUnread, totalItems, starred };
  }

  async feedStats(userId) {
    return this.all(
      `SELECT f.id, f.title, f.url, f.last_fetch_at, f.last_status, f.last_error,
              COUNT(i.id) AS total, SUM(CASE WHEN i.read = 0 THEN 1 ELSE 0 END) AS unread
       FROM feeds f LEFT JOIN items i ON i.feed_id = f.id
       WHERE f.user_id = ? GROUP BY f.id ORDER BY total DESC`,
      userId
    );
  }
}

export function itemId(feedId, guid) {
  // 与 Node 版保持一致的短哈希（sha1 前 24 位）
  return sha1Hex(`${feedId}\u0000${guid}`).slice(0, 24);
}

/* Workers 里没有 node:crypto 的同步 sha1，这里用纯 JS 实现（仅用于生成主键） */
function sha1Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const ml = bytes.length * 8;
  // 补位：0x80 + 若干 0，再追加 8 字节长度，总长必须是 64 的整数倍
  const withPad = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, ml >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(ml / 4294967296), false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let i = 0; i < withPad.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) {
      const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = ((n << 1) | (n >>> 31)) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f, k;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('');
}
