'use strict';

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // 大体积 feed（如 GitHub releases.atom）实体数量远超默认 1000 上限，这里放宽
  processEntities: {
    enabled: true,
    maxTotalExpansions: 2_000_000,
    maxExpandedLength: 50_000_000,
    maxExpansionDepth: 100,
  },
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

/* ------------------------- small helpers ------------------------- */

function txt(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return txt(node[0]);
  if (typeof node === 'object') {
    if ('#text' in node) return txt(node['#text']);
    if ('#cdata' in node) return txt(node['#cdata']);
    return '';
  }
  return '';
}

function attr(node, name) {
  if (!node || typeof node !== 'object') return '';
  const v = node['@_' + name];
  return v === undefined ? '' : String(v);
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** object tree (xhtml content) -> html string */
function objToHtml(node) {
  if (node === undefined || node === null) return '';
  if (typeof node !== 'object') return escapeHtml(node);
  if (Array.isArray(node)) return node.map(objToHtml).join('');
  let out = '';
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    if (key === '#text') {
      out += escapeHtml(value);
      continue;
    }
    const tag = key.replace(/^[a-zA-Z0-9]+:/, '');
    for (const child of asArray(value)) {
      if (child === null || child === undefined) continue;
      if (typeof child !== 'object') {
        out += `<${tag}>${escapeHtml(child)}</${tag}>`;
      } else {
        const attrs = Object.entries(child)
          .filter(([k]) => k.startsWith('@_'))
          .map(([k, v]) => ` ${k.slice(2)}="${escapeHtml(v)}"`)
          .join('');
        out += `<${tag}${attrs}>${objToHtml(child)}</${tag}>`;
      }
    }
  }
  return out;
}

function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  let t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  // common non-standard forms: "2024-01-02 03:04:05" (treated as UTC by some feeds)
  t = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function firstImage(html, baseUrl) {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(String(html || ''));
  if (!m) return null;
  return absoluteUrl(m[1], baseUrl);
}

function absoluteUrl(url, base) {
  if (!url) return null;
  const u = String(url).trim();
  if (/^data:/i.test(u)) return null;
  try {
    return new URL(u, base || undefined).toString();
  } catch {
    return /^https?:\/\//i.test(u) ? u : null;
  }
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/* ------------------------- feed parsing ------------------------- */

function pickAtomLink(entry, rel) {
  const links = asArray(entry.link);
  const match = links.find((l) => {
    const r = attr(l, 'rel') || 'alternate';
    return r === rel;
  });
  if (match) return attr(match, 'href');
  const any = links.find((l) => attr(l, 'href'));
  return any ? attr(any, 'href') : '';
}

function normalizeItem(raw) {
  const publishedAt = raw.publishedAt || Date.now();
  return {
    guid: String(raw.guid || raw.link || raw.title || publishedAt),
    title: (raw.title || '(无标题)').replace(/\s+/g, ' ').trim().slice(0, 500),
    link: raw.link || null,
    author: (raw.author || '').slice(0, 200) || null,
    publishedAt,
    content: raw.content || '',
    summary: truncate(stripHtml(raw.content || raw.summary || ''), 500),
    thumbnail: raw.thumbnail || null,
  };
}

function parseAtom(root) {
  const feed = root.feed;
  const siteUrl = pickAtomLink(feed, 'alternate');
  const entries = asArray(feed.entry).map((e) => {
    const link = pickAtomLink(e, 'alternate') || pickAtomLink(e, 'self');
    let content = '';
    if (e.content !== undefined) {
      const type = attr(e.content, 'type');
      content = typeof e.content === 'object' && type && !/html|text/i.test(type)
        ? objToHtml(e.content)
        : txt(e.content) || objToHtml(e.content);
    }
    if (!content) content = txt(e.summary);
    const media = asArray(e['media:group'] ? e['media:group']['media:content'] : e['media:content'])[0];
    return normalizeItem({
      guid: txt(e.id) || link,
      title: txt(e.title),
      link: absoluteUrl(link, siteUrl),
      author: txt(e.author && e.author.name) || txt(e['dc:creator']) || txt(e.author),
      publishedAt: parseDate(txt(e.published)) || parseDate(txt(e.updated)) || parseDate(txt(e['dc:date'])),
      content,
      summary: txt(e.summary),
      thumbnail: absoluteUrl(attr(media, 'url'), siteUrl) || firstImage(content, siteUrl || link),
    });
  });

  return {
    title: txt(feed.title).trim(),
    siteUrl: absoluteUrl(siteUrl, siteUrl),
    description: stripHtml(txt(feed.subtitle)).slice(0, 500),
    iconUrl: absoluteUrl(txt(feed.icon) || txt(feed.logo), siteUrl),
    items: entries,
  };
}

function parseRss(channel, rootUrl) {
  const siteUrl = txt(channel.link);
  const items = asArray(channel.item).map((it) => {
    const link = txt(it.link) || attr(asArray(it.link)[0], 'href');
    let content = txt(it['content:encoded']);
    if (!content) content = txt(it.description);
    if (!content) content = objToHtml(it.description);
    const enclosure = asArray(it.enclosure)[0];
    const mediaContent = asArray(it['media:content'])[0];
    const mediaThumb = asArray(it['media:thumbnail'])[0];
    return normalizeItem({
      guid: txt(it.guid) || txt(it['dc:identifier']) || link || txt(it.title),
      title: txt(it.title),
      link: absoluteUrl(link, siteUrl || rootUrl),
      author: txt(it['dc:creator']) || txt(it.author) || txt(it['itunes:author']),
      publishedAt: parseDate(txt(it.pubDate)) || parseDate(txt(it['dc:date'])) || parseDate(txt(it['a10:updated'])),
      content,
      thumbnail:
        absoluteUrl(attr(mediaThumb, 'url'), siteUrl) ||
        absoluteUrl(attr(mediaContent, 'url'), siteUrl) ||
        absoluteUrl(attr(enclosure, 'url'), siteUrl) ||
        firstImage(content, siteUrl || link),
    });
  });

  const image = channel.image;
  return {
    title: txt(channel.title).trim(),
    siteUrl: absoluteUrl(siteUrl, rootUrl),
    description: stripHtml(txt(channel.description)).slice(0, 500),
    iconUrl: absoluteUrl(txt(image && image.url), siteUrl),
    items,
  };
}

/**
 * Parse an RSS / Atom / RDF document.
 * @returns {{title:string,siteUrl:string,description:string,iconUrl:string,items:Array}}
 */
function parseFeed(xml) {
  const root = parser.parse(String(xml || ''));

  if (root.feed) return parseAtom(root);

  if (root.rss) {
    const channel = root.rss.channel || {};
    return parseRss(channel, '');
  }

  if (root['rdf:RDF'] || root.RDF) {
    const rdf = root['rdf:RDF'] || root.RDF;
    const channel = rdf.channel || {};
    const feed = parseRss(channel, txt(channel.link));
    feed.items = asArray(rdf.item).map((it) => {
      const link = txt(it.link);
      const content = txt(it['content:encoded']) || txt(it.description);
      return normalizeItem({
        guid: txt(it['dc:identifier']) || link || txt(it.title),
        title: txt(it.title),
        link: absoluteUrl(link, feed.siteUrl),
        author: txt(it['dc:creator']),
        publishedAt: parseDate(txt(it['dc:date'])) || parseDate(txt(it.pubDate)),
        content,
        thumbnail: firstImage(content, feed.siteUrl || link),
      });
    });
    return feed;
  }

  throw new Error('无法识别的订阅格式（既不是 RSS 也不是 Atom）');
}

/** Detect feed links inside an HTML page. */
function discoverFeedsInHtml(html, baseUrl) {
  const found = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = /rel=["']?([^"'>]+)/i.exec(tag);
    const type = /type=["']?([^"'>]+)/i.exec(tag);
    const href = /href=["']([^"']+)["']/i.exec(tag) || /href=([^\s>]+)/i.exec(tag);
    const title = /title=["']([^"']*)["']/i.exec(tag);
    if (!href) continue;
    const rels = (rel ? rel[1] : '').toLowerCase();
    const t = (type ? type[1] : '').toLowerCase();
    if (!/alternate/.test(rels)) continue;
    if (!/rss|atom|xml/.test(t)) continue;
    found.push({ url: absoluteUrl(href[1], baseUrl), title: title ? title[1] : '', type: t });
  }
  return found.filter((f) => f.url);
}

module.exports = { parseFeed, discoverFeedsInHtml, stripHtml, truncate, escapeHtml, absoluteUrl, escapeReg };
