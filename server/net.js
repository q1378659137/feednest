'use strict';

const { fetch, ProxyAgent } = require('undici');
const { discoverFeedsInHtml, parseFeed } = require('./parser');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 FeedNest/1.0';

function proxyUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.PROXY ||
    ''
  );
}

let dispatcher = null;
let dispatcherFor = '';
function getDispatcher() {
  const p = proxyUrl();
  if (!p) return undefined;
  if (!dispatcher || dispatcherFor !== p) {
    dispatcher = new ProxyAgent(p);
    dispatcherFor = p;
  }
  return dispatcher;
}

function decodeBody(buffer, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '');
  charset = charset ? charset[1] : null;
  if (!charset) {
    const head = Buffer.from(buffer).subarray(0, 300).toString('latin1');
    const decl = /encoding=["']([\w-]+)["']/i.exec(head);
    if (decl) charset = decl[1];
  }
  charset = (charset || 'utf-8').toLowerCase();
  if (charset === 'utf8') charset = 'utf-8';
  if (charset === 'gb2312' || charset === 'gbk') charset = 'gb18030';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return Buffer.from(buffer).toString('utf8');
  }
}

async function httpGet(url, { etag, lastModified, timeout = 20000, accept } = {}) {
  const headers = {
    'user-agent': UA,
    accept:
      accept ||
      'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

  const res = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    dispatcher: getDispatcher(),
    signal: AbortSignal.timeout(timeout),
  });

  if (res.status === 304) {
    return { status: 304, url: res.url || url };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const text = decodeBody(buffer, res.headers.get('content-type'));
  return {
    status: res.status,
    ok: res.ok,
    url: res.url || url,
    contentType: res.headers.get('content-type') || '',
    etag: res.headers.get('etag') || null,
    lastModified: res.headers.get('last-modified') || null,
    text,
  };
}

function looksLikeFeed(text) {
  const head = String(text || '').slice(0, 2000).trim();
  return /^<\?xml/i.test(head) || /<(rss|feed|rdf:RDF)\b/i.test(head);
}

/**
 * Fetch a URL and return a parsed feed. If the URL points at an HTML page,
 * try to discover the feed link first.
 */
async function loadFeed(url, { etag, lastModified, timeout } = {}) {
  let res = await httpGet(url, { etag, lastModified, timeout });

  if (res.status === 304) return { notModified: true, url: res.url };

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  let xml = res.text;
  let finalUrl = res.url;

  if (!looksLikeFeed(xml)) {
    const candidates = discoverFeedsInHtml(xml, finalUrl);
    if (!candidates.length) {
      throw new Error('该地址不是 RSS/Atom 源，也没有找到可用的订阅链接');
    }
    const discovered = candidates[0];
    res = await httpGet(discovered.url, { timeout });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = res.text;
    finalUrl = discovered.url;
    if (!looksLikeFeed(xml)) {
      throw new Error('订阅链接返回的内容不是有效的 RSS/Atom');
    }
    return {
      notModified: false,
      feed: parseFeed(xml),
      url: finalUrl,
      etag: res.etag,
      lastModified: res.lastModified,
      discovered: true,
    };
  }

  return {
    notModified: false,
    feed: parseFeed(xml),
    url: finalUrl,
    etag: res.etag,
    lastModified: res.lastModified,
  };
}

/** Preview a feed without saving it. */
async function previewFeed(url) {
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

/** 通用 JSON POST（带代理支持），用于推送等外部接口 */
async function postJson(url, body, { timeout = 15000 } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': UA,
      accept: 'application/json, */*;q=0.5',
    },
    body: JSON.stringify(body),
    dispatcher: getDispatcher(),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, data };
}

module.exports = { httpGet, postJson, loadFeed, previewFeed, proxyUrl, looksLikeFeed };
