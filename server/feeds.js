'use strict';

const db = require('./db');
const { loadFeed } = require('./net');
const push = require('./push');

// 刷新进度按用户隔离：多个账号可以同时刷新，各自看到自己的进度
const progressByUser = new Map();
let activeRefreshes = 0;

function makeProgress() {
  return {
    running: false,
    mode: '',
    total: 0,
    done: 0,
    failed: 0,
    added: 0,
    remaining: 0,
    startedAt: 0,
    finishedAt: 0,
    current: '',
  };
}

function getProgress(userId = '') {
  const key = userId || 'auto';
  if (!progressByUser.has(key)) progressByUser.set(key, makeProgress());
  return progressByUser.get(key);
}

function getProgressSnapshot(userId = '') {
  return { ...getProgress(userId) };
}

function isAnyRunning() {
  return activeRefreshes > 0;
}

async function refreshFeed(feed, { timeout } = {}) {
  const settings = db.getSettings(feed.user_id);
  try {
    const res = await loadFeed(feed.url, {
      etag: feed.etag,
      lastModified: feed.last_modified,
      timeout,
    });

    if (res.notModified) {
      db.updateFeedMeta(feed.id, {
        last_fetch_at: Date.now(),
        last_status: 'ok',
        last_error: null,
        error_count: 0,
      });
      return { status: 'not-modified', added: 0 };
    }

    const parsed = res.feed;
    const { added, newItems } = db.upsertItems(feed.id, parsed.items, settings.maxItemsPerFeed);

    const meta = {
      last_fetch_at: Date.now(),
      last_status: 'ok',
      last_error: null,
      error_count: 0,
      etag: res.etag || null,
      last_modified: res.lastModified || null,
    };
    // Don't clobber a user-defined title, but adopt the feed's own title on first fetch.
    if (!feed.title || feed.title === feed.url || feed.title === '未命名订阅') {
      meta.title = parsed.title || feed.title || feed.url;
    }
    if (!feed.site_url && parsed.siteUrl) meta.site_url = parsed.siteUrl;
    if (!feed.description && parsed.description) meta.description = parsed.description;
    if (!feed.icon_url && parsed.iconUrl) meta.icon_url = parsed.iconUrl;

    db.updateFeedMeta(feed.id, meta);
    return { status: 'ok', added, newItems, total: parsed.items.length, title: meta.title || feed.title };
  } catch (err) {
    const message = err && err.name === 'TimeoutError' ? '请求超时' : String((err && err.message) || err);
    db.updateFeedMeta(feed.id, {
      last_fetch_at: Date.now(),
      last_status: 'error',
      last_error: message.slice(0, 300),
      error_count: (feed.error_count || 0) + 1,
    });
    return { status: 'error', error: message };
  }
}

function isDue(feed, settings, now = Date.now()) {
  if (!feed.last_fetch_at) return true;
  const base = (feed.refresh_interval || settings.refreshInterval || 1800) * 1000;
  const backoff = feed.error_count > 0 ? Math.min(2 ** feed.error_count, 8) : 1;
  return feed.last_fetch_at + base * backoff <= now;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '');
  }
}

async function pool(tasks, concurrency, onEach, perHost = 2) {
  // 同一站点最多并发 2 个请求，源多时避免把对方打限流
  const active = new Map();
  const withHost = async (feed, fn) => {
    const host = hostOf(feed.url);
    while ((active.get(host) || 0) >= perHost) await new Promise((r) => setTimeout(r, 120));
    active.set(host, (active.get(host) || 0) + 1);
    try {
      return await fn();
    } finally {
      active.set(host, (active.get(host) || 0) - 1);
    }
  };
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (index < tasks.length) {
      const i = index++;
      await withHost(tasks[i], () => onEach(tasks[i], i));
    }
  });
  await Promise.all(workers);
}

async function refreshMany(feeds, { mode = 'manual', concurrency = 6, userId = '', progress = getProgress(userId) } = {}) {
  if (progress.running) return { ...progress };
  if (!feeds.length) return { ...progress };

  Object.assign(progress, {
    running: true,
    mode,
    total: feeds.length,
    done: 0,
    failed: 0,
    added: 0,
    remaining: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    current: '',
  });
  activeRefreshes++;

  const newByUser = new Map();

  try {
    await pool(feeds, concurrency, async (feed) => {
      progress.current = feed.title || feed.url;
      const result = await refreshFeed(feed);
      progress.done++;
      if (result.status === 'error') progress.failed++;
      progress.added += result.added || 0;
      if (result.newItems && result.newItems.length) {
        const list = newByUser.get(feed.user_id) || [];
        for (const it of result.newItems) list.push({ ...it, feedTitle: feed.title });
        newByUser.set(feed.user_id, list);
      }
    });
  } finally {
    activeRefreshes--;
    progress.running = false;
    progress.current = '';
    progress.finishedAt = Date.now();
  }

  // 有新文章就推送到 PushPlus（导入时跳过，避免一次推几百条）
  if (mode !== 'import' && newByUser.size) {
    for (const [uid, items] of newByUser) {
      try {
        await push.notifyNewItems(db, uid, items);
      } catch (err) {
        console.error('[push]', err.message);
      }
    }
  }

  return { ...progress };
}

/** 最久没刷新的排前面，保证源很多时也能公平轮转 */
function byOldestFirst(feeds) {
  return feeds
    .slice()
    .sort((a, b) => (a.last_fetch_at || 0) - (b.last_fetch_at || 0));
}

function refreshAll(userId, options = {}) {
  return refreshMany(byOldestFirst(db.listFeeds(userId)), {
    mode: 'all',
    userId,
    progress: getProgress(userId),
    ...options,
  });
}

function refreshDue() {
  const feeds = byOldestFirst(db.listAllFeeds().filter((f) => isDue(f, db.getSettings(f.user_id))));
  if (!feeds.length) return Promise.resolve(getProgress('auto'));
  // 订阅源很多时单轮限制数量，靠“最久未刷新优先”在后续轮次里覆盖剩下的
  const maxPerTick = Number(process.env.MAX_FEEDS_PER_RUN) || 200;
  return refreshMany(feeds.slice(0, maxPerTick), {
    mode: 'auto',
    concurrency: 5,
    userId: 'auto',
    progress: getProgress('auto'),
  });
}

let timer = null;
function startScheduler() {
  if (timer) return;
  const tick = async () => {
    // 有用户手动刷新在跑时先让路，避免重复抓取
    if (isAnyRunning()) return;
    try {
      await refreshDue();
    } catch (err) {
      console.error('[scheduler]', err.message);
    }
  };
  timer = setInterval(tick, 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 2500).unref?.();
}

module.exports = {
  refreshFeed,
  refreshAll,
  refreshMany,
  refreshDue,
  startScheduler,
  getProgress,
  getProgressSnapshot,
  isAnyRunning,
  isDue,
};
