'use strict';

const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const db = require('./db');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  ignoreDeclaration: true,
});

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function label(node) {
  return String(node['@_text'] || node['@_title'] || '').trim();
}

function attrOf(node, name) {
  const v = node['@_' + name];
  return v === undefined || v === null ? '' : String(v).trim();
}

/** Walk an OPML document and return flat list of {folder,title,url,siteUrl} */
function parseOpml(xml) {
  const root = xmlParser.parse(String(xml || ''));
  const opml = root.opml || root.OPML;
  if (!opml) throw new Error('不是有效的 OPML 文件');
  const body = opml.body;
  if (!body) throw new Error('OPML 文件缺少 body 节点');

  const out = [];

  const walk = (nodes, folder) => {
    for (const node of asArray(nodes)) {
      const xmlUrl = attrOf(node, 'xmlUrl');
      if (xmlUrl) {
        out.push({
          folder: folder || null,
          title: label(node) || xmlUrl,
          url: xmlUrl,
          siteUrl: attrOf(node, 'htmlUrl') || '',
        });
        continue;
      }
      const name = label(node);
      if (node.outline) {
        walk(node.outline, name || folder);
      }
    }
  };

  walk(body.outline, null);
  return out;
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Build a Feedbro-compatible OPML export. */
function buildOpml(userId) {
  const folders = db.listFolders(userId);
  const feeds = db.listFeeds(userId);
  const byFolder = new Map();
  const loose = [];

  for (const feed of feeds) {
    if (feed.folder_id && folders.some((f) => f.id === feed.folder_id)) {
      if (!byFolder.has(feed.folder_id)) byFolder.set(feed.folder_id, []);
      byFolder.get(feed.folder_id).push(feed);
    } else {
      loose.push(feed);
    }
  }

  const feedOutline = (feed, indent) =>
    `${indent}<outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" ` +
    `xmlUrl="${escapeXml(feed.url)}" htmlUrl="${escapeXml(feed.site_url || '')}"/>\n`;

  let body = '';
  for (const folder of folders) {
    const children = byFolder.get(folder.id) || [];
    if (!children.length) continue;
    body += `  <outline text="${escapeXml(folder.name)}" title="${escapeXml(folder.name)}">\n`;
    for (const feed of children) body += feedOutline(feed, '    ');
    body += '  </outline>\n';
  }
  for (const feed of loose) body += feedOutline(feed, '  ');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<opml version="2.0">\n' +
    '  <head>\n' +
    '    <title>FeedNest Subscriptions</title>\n' +
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>\n` +
    '  </head>\n' +
    '  <body>\n' +
    body +
    '  </body>\n' +
    '</opml>\n'
  );
}

/**
 * Import parsed entries. Existing URLs are skipped (not overwritten).
 * @returns {{added:number, skipped:number, foldersCreated:number, newFeedIds:string[]}}
 */
function importEntries(userId, entries) {
  const existing = new Set(db.listFeeds(userId).map((f) => f.url.replace(/\/+$/, '')));
  const folderCache = new Map(db.listFolders(userId).map((f) => [f.name, f.id]));

  let added = 0;
  let skipped = 0;
  let foldersCreated = 0;
  const newFeedIds = [];

  for (const entry of entries) {
    const url = entry.url.trim();
    if (!url) continue;
    const key = url.replace(/\/+$/, '');
    if (existing.has(key)) {
      skipped++;
      continue;
    }

    let folderId = null;
    if (entry.folder) {
      if (!folderCache.has(entry.folder)) {
        const folder = db.createFolder(userId, entry.folder);
        folderCache.set(entry.folder, folder.id);
        foldersCreated++;
      }
      folderId = folderCache.get(entry.folder);
    }

    const feed = db.createFeed(userId, {
      title: entry.title || url,
      url,
      siteUrl: entry.siteUrl,
      folderId,
    });
    existing.add(key);
    added++;
    newFeedIds.push(feed.id);
  }

  return { added, skipped, foldersCreated, newFeedIds };
}

module.exports = { parseOpml, buildOpml, importEntries };
