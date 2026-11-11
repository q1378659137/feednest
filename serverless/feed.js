/**
 * 抓取与刷新（Workers 版）—— 用全局 fetch，解析复用 server/parser.js。
 */

import parserModule from '../server/parser.js';
import { itemId } from './db.js';
import { notifyNewItems } from './push.js';

const { parseFeed, discoverFeedsInHtml } = parserModule;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 FeedNest/1.1';

function decodeBody(buffer, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '');
  charset = charset ? charset[1] : null;
  if (!charset) {
    const head = new TextDecoder('latin1').decode(buffer.slice(0, 300));
    const decl = /encoding=["']([\w-]+)["']/i.exec(head);
    if (decl) charset = decl[1];
  }
  charset = (charset || 'utf-8').toLowerCase();
  if (charset === 'utf8') charset = 'utf-8';
  if (charset === 'gb2312' || charset === 'gbk') charset = 'gb18030';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function httpGet(url, { etag, lastModified, timeout = 20000 } = {}) {
  const headers = {
    'user-agent': UA,
    accept:
      'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });

  if (res.status === 304) return { status: 304, url: res.url || url };

  const buffer = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    ok: res.ok,
    url: res.url || url,
    text: decodeBody(buffer, res.headers.get('content-type') || ''),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

function looksLikeFeed(text) {
  const head = String(text || '').slice(0, 2000).trim();
  return /^<\?xml/i.test(head) || /<(rss|feed|rdf:RDF)\b/i.test(head);
}

export async function loadFeed(url, { etag, lastModified, timeout } = {}) {
  let res = await httpGet(url, { etag, lastModified, timeout });
  if (res.status === 304) return { notModified: true, url: res.url };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  let xml = res.text;
  let finalUrl = res.url;

  if (!looksLikeFeed(xml)) {
    const candidates = discoverFeedsInHtml(xml, finalUrl);
    if (!candidates.length) throw new Error('该地址不是 RSS/Atom 源，也没有找到可用的订阅链接');
    res = await httpGet(candidates[0].url, { timeout });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = res.text;
    finalUrl = candidates[0].url;
    if (!looksLikeFeed(xml)) throw new Error('订阅链接返回的内容不是有效的 RSS/Atom');
    return { notModified: false, feed: parseFeed(xml), url: finalUrl, etag: res.etag, lastModified: res.lastModified, discovered: true };
  }

  return { notModified: false, feed: parseFeed(xml), url: finalUrl, etag: res.etag, lastModified: res.lastModified };
}

export async function previewFeed(url) {
  const result = await loadFeed(url);
  if (result.notModified) throw new Error('服务器返回 304，请重试');
  const feed = result.feed;
  return {
    url: result.url,
    title: feed.title || url,
    siteUrl: feed.siteUrl || '',
    description: feed.description || '',
    iconUrl: feed.iconUrl || '',
    itemCount: feed.items.length,
    latest: feed.items.reduce((max, i) => Math.max(max, i.publishedAt || 0), 0),
    sample: feed.items.slice(0, 3).map((i) => ({ title: i.title, link: i.link })),
    discovered: !!result.discovered,
  };
}

export async function refreshFeed(db, feed) {
  const settings = await db.getSettings(feed.user_id);
  try {
    const res = await loadFeed(feed.url, { etag: feed.etag, lastModified: feed.last_modified });
    if (res.notModified) {
      await db.updateFeedMeta(feed.id, {
        last_fetch_at: Date.now(),
        last_status: 'ok',
        last_error: null,
        error_count: 0,
      });
      return { status: 'not-modified', added: 0 };
    }

    const parsed = res.feed;
    const entries = parsed.items.map((it) => ({ ...it, id: itemId(feed.id, it.guid) }));
    const { added, newItems } = await db.upsertItems(feed.id, entries, settings.maxItemsPerFeed);

    const meta = {
      last_fetch_at: Date.now(),
      last_status: 'ok',
      last_error: null,
      error_count: 0,
      etag: res.etag || null,
      last_modified: res.lastModified || null,
    };
    if (!feed.title || feed.title === feed.url) meta.title = parsed.title || feed.title || feed.url;
    if (!feed.site_url && parsed.siteUrl) meta.site_url = parsed.siteUrl;
    if (!feed.description && parsed.description) meta.description = parsed.description;
    if (!feed.icon_url && parsed.iconUrl) meta.icon_url = parsed.iconUrl;

    await db.updateFeedMeta(feed.id, meta);
    return { status: 'ok', added, newItems, total: parsed.items.length };
  } catch (err) {
    const message = err && err.name === 'TimeoutError' ? '请求超时' : String((err && err.message) || err);
    await db.updateFeedMeta(feed.id, {
      last_fetch_at: Date.now(),
      last_status: 'error',
      last_error: message.slice(0, 300),
      error_count: (feed.error_count || 0) + 1,
    });
    return { status: 'error', error: message };
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '');
  }
}

export async function refreshMany(db, feeds, { concurrency = 5, perHost = 2, onProgress, notify = true, pushUrl } = {}) {
  // 同一站点最多并发 2 个请求，源多时不会把对方打限流
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
  let added = 0;
  let failed = 0;
  let done = 0;
  const newByUser = new Map();
  const workers = Array.from({ length: Math.min(concurrency, feeds.length || 1) }, async () => {
    while (index < feeds.length) {
      const feed = feeds[index++];
      const result = await withHost(feed, () => refreshFeed(db, feed));
      done++;
      if (result.status === 'error') failed++;
      added += result.added || 0;
      if (result.newItems && result.newItems.length) {
        const list = newByUser.get(feed.user_id) || [];
        for (const it of result.newItems) list.push({ ...it, feedTitle: feed.title });
        newByUser.set(feed.user_id, list);
      }
      if (onProgress) {
        try {
          onProgress({ done, total: feeds.length, added, failed, feed, result });
        } catch {
          /* 忽略回调异常 */
        }
      }
    }
  });
  await Promise.all(workers);

  // 有新文章就推送（导入时 notify=false，避免一次几百条）
  for (const [userId, items] of notify ? newByUser : []) {
    try {
      await notifyNewItems(db, userId, items, pushUrl);
    } catch (err) {
      console.error('[push]', err.message);
    }
  }

  return { total: feeds.length, added, failed };
}

export function isDue(feed, settings, now = Date.now()) {
  if (!feed.last_fetch_at) return true;
  const base = (feed.refresh_interval || settings.refreshInterval || 1800) * 1000;
  const backoff = feed.error_count > 0 ? Math.min(2 ** feed.error_count, 8) : 1;
  return feed.last_fetch_at + base * backoff <= now;
}

export async function refreshDue(db, max = 45, pushUrl) {
  const feeds = await db.listAllFeeds();
  const due = [];
  const cache = new Map();
  for (const feed of feeds) {
    if (!cache.has(feed.user_id)) cache.set(feed.user_id, await db.getSettings(feed.user_id));
    if (isDue(feed, cache.get(feed.user_id))) due.push(feed);
  }
  if (!due.length) return { total: 0, added: 0, failed: 0, remaining: 0 };
  // 最久没刷新的优先，保证源很多时按批也能公平轮转
  due.sort((a, b) => (a.last_fetch_at || 0) - (b.last_fetch_at || 0));
  const batch = due.slice(0, max);
  const result = await refreshMany(db, batch, { concurrency: 5, pushUrl });
  return { ...result, remaining: Math.max(0, due.length - batch.length) };
}
