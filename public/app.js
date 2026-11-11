'use strict';

/* ======================= 基础工具 ======================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const opts = { ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    if (res.status === 401 && !String(path).startsWith('/api/auth/login')) {
      showLogin(data.error && data.error !== '未登录' ? data.error : '');
    }
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return '昨天';
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.getMonth() + 1}月${d.getDate()}日${sameYear ? '' : ` ${d.getFullYear()}`}`;
}

function fullTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const AVATAR_COLORS = ['#4f7cf7', '#e2603f', '#3aa675', '#a45cd6', '#e0912a', '#2f9bb3', '#d2508f', '#6b7a90'];
function avatarColor(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) % 9973;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function avatarHtml(title, iconUrl, size = 18) {
  const letter = String(title || '?').trim().charAt(0) || '?';
  const color = avatarColor(title);
  const img = iconUrl
    ? `<img src="${esc(iconUrl)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  return `<span class="avatar" style="background:${color};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px">${img || esc(letter)}</span>`;
}

/* ======================= 状态 ======================= */

const state = {
  user: null,
  folders: [],
  feeds: [],
  folderUnread: {},
  counts: { unread: 0, items: 0, starred: 0 },
  settings: {},
  progress: { running: false },
  proxy: null,
  version: '',
  scope: { type: 'all', id: null },
  items: [],
  total: 0,
  selectedId: null,
  current: null,
  unreadOnly: false,
  sort: 'newest',
  view: localStorage.getItem('fn.view') || 'comfortable',
  q: '',
  loading: false,
  collapsed: new Set(JSON.parse(localStorage.getItem('fn.collapsed') || '[]')),
  theme: localStorage.getItem('fn.theme') || 'light',
  pollTimer: null,
};

/* ======================= 主题 ======================= */

const THEMES = ['light', 'dark', 'sepia'];
const THEME_ICON = {
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  dark: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  sepia: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const icon = $('#theme-icon');
  if (icon) icon.innerHTML = THEME_ICON[state.theme] || THEME_ICON.light;
  localStorage.setItem('fn.theme', state.theme);
  if (state.current) renderReader(state.current, { keepScroll: true });
}

function cycleTheme() {
  state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
  applyTheme();
  toast(`主题：${{ light: '浅色', dark: '深色', sepia: '护眼' }[state.theme]}`);
}

/* ======================= 提示 ======================= */

function toast(message, type = '') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

/* ======================= 侧边栏 ======================= */

function scopeKey(scope = state.scope) {
  return scope.type + ':' + (scope.id || '');
}

function renderSidebar() {
  const tree = $('#tree');
  const scrollTop = tree.scrollTop;
  $('#count-all').textContent = state.counts.items || '';
  $('#count-unread').textContent = state.counts.unread || '';
  $('#count-star').textContent = state.counts.starred || '';

  $$('#nav .nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.nav === state.scope.type);
  });

  const byFolder = new Map();
  const loose = [];
  for (const feed of state.feeds) {
    if (feed.folderId && state.folders.some((f) => f.id === feed.folderId)) {
      if (!byFolder.has(feed.folderId)) byFolder.set(feed.folderId, []);
      byFolder.get(feed.folderId).push(feed);
    } else {
      loose.push(feed);
    }
  }

  const feedRow = (feed) =>
    `<div class="tree-row tree-feed ${feed.unread ? 'unread' : 'read'} ${
      state.scope.type === 'feed' && state.scope.id === feed.id ? 'active' : ''
    }" data-type="feed" data-id="${feed.id}">
      ${avatarHtml(feed.title, feed.iconUrl, 18)}
      <span class="row-title" title="${esc(feed.title)}${feed.lastError ? ' · ' + esc(feed.lastError) : ''}">${esc(feed.title)}</span>
      ${feed.lastStatus === 'error' ? '<svg viewBox="0 0 24 24" class="ic" style="width:13px;height:13px;color:var(--danger)"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>' : ''}
      <span class="row-count">${feed.unread || ''}</span>
    </div>`;

  let html = '';
  for (const folder of state.folders) {
    const children = byFolder.get(folder.id) || [];
    const collapsed = state.collapsed.has(folder.id);
    const unread = state.folderUnread[folder.id] || 0;
    html += `
      <div class="tree-folder ${collapsed ? 'collapsed' : ''} ${unread > 0 ? 'has-unread' : ''}" data-folder="${folder.id}">
        <div class="tree-row ${state.scope.type === 'folder' && state.scope.id === folder.id ? 'active' : ''}" data-type="folder" data-id="${folder.id}">
          <svg viewBox="0 0 24 24" class="ic chev"><path d="m6 9 6 6 6-6"/></svg>
          <svg viewBox="0 0 24 24" class="ic ic-folder" style="width:15px;height:15px"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>
          <span class="row-title" title="${esc(folder.name)}">${esc(folder.name)}</span>
          <span class="row-count">${unread || ''}</span>
        </div>
        <div class="tree-children ${collapsed ? 'hidden' : ''}">${children.map(feedRow).join('')}</div>
      </div>`;
  }
  if (loose.length) html += loose.map(feedRow).join('');

  $('#tree').innerHTML = html;
  tree.scrollTop = scrollTop;

  const errCount = state.feeds.filter((f) => f.lastStatus === 'error').length;
  $('#stat-line').innerHTML = `${state.feeds.length} 个订阅 · ${state.counts.unread} 篇未读${
    errCount ? ` · <span style="color:var(--danger)">${errCount} 个异常</span>` : ''
  }`;
}

function setScope(scope) {
  state.scope = scope;
  state.selectedId = null;
  state.current = null;
  closeReader();
  renderSidebar();
  renderReaderEmpty();
  loadItems();
  $('#sidebar').classList.remove('open');
}

/* ======================= 文章列表 ======================= */

function scopeParam() {
  if (state.scope.type === 'feed') return `feed:${state.scope.id}`;
  if (state.scope.type === 'folder') return `folder:${state.scope.id}`;
  if (state.scope.type === 'starred') return 'starred';
  return 'all';
}

function scopeTitle() {
  let base = '文章';
  if (state.scope.type === 'all') base = state.unreadOnly ? '全部未读' : '全部文章';
  else if (state.scope.type === 'unread') base = '未读文章';
  else if (state.scope.type === 'starred') base = '收藏夹';
  else if (state.scope.type === 'feed') {
    const f = state.feeds.find((x) => x.id === state.scope.id);
    base = f ? f.title : '订阅';
  } else if (state.scope.type === 'folder') {
    const f = state.folders.find((x) => x.id === state.scope.id);
    base = f ? f.name : '文件夹';
  }
  if (state.unreadOnly && (state.scope.type === 'feed' || state.scope.type === 'folder' || state.scope.type === 'starred')) {
    base += ' · 未读';
  }
  return base;
}

async function loadItems({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const offset = append ? state.items.length : 0;

  if (!append) {
    if (!state.items.length) {
      $('#items').innerHTML = `<div class="skeleton">
        <div class="sk-row w40"></div><div class="sk-row w90"></div><div class="sk-row w70"></div>
        <div style="height:8px"></div>
        <div class="sk-row w40"></div><div class="sk-row w90"></div><div class="sk-row w70"></div>
      </div>`;
    }
  }

  const params = new URLSearchParams({
    scope: scopeParam(),
    sort: state.sort,
    limit: '60',
    offset: String(offset),
  });
  const unread = state.scope.type === 'unread' ? true : state.unreadOnly;
  if (unread) params.set('unread', '1');
  if (state.q) params.set('q', state.q);

  try {
    const data = await api('/api/items?' + params.toString());
    state.total = data.total;
    state.items = append ? state.items.concat(data.items) : data.items;
    renderItems();
    $('#listTitle').textContent = scopeTitle();
    $('#listCount').textContent = state.total ? `${state.total} 篇` : '';
    $('#btn-unread').classList.toggle('active', state.scope.type === 'unread' || state.unreadOnly);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.loading = false;
  }
}

function itemHtml(item) {
  const thumb = item.thumbnail
    ? `<div class="item-thumb"><img src="${esc(item.thumbnail)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : state.view === 'card'
      ? `<div class="item-thumb no-img">${esc((item.feedTitle || item.title || '?').charAt(0))}</div>`
      : '';

  return `<div class="item ${item.read ? 'read' : 'unread'} ${item.starred ? 'starred' : ''} ${
    item.id === state.selectedId ? 'selected' : ''
  }" data-id="${item.id}">
    <span class="item-dot"></span>
    ${state.view === 'card' ? thumb : ''}
    <div class="item-main">
      <div class="item-title">${esc(item.title)}</div>
      ${state.view === 'compact' ? '' : `<div class="item-snippet">${esc(item.summary || '')}</div>`}
      <div class="item-meta">
        <span class="item-star"><svg viewBox="0 0 24 24" class="ic"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"/></svg></span>
        <span class="feed" title="${esc(item.feedTitle)}">${esc(item.feedTitle)}</span>
        <span class="sep">·</span>
        <span title="${esc(fullTime(item.publishedAt))}">${timeAgo(item.publishedAt)}</span>
      </div>
    </div>
    ${state.view !== 'card' ? thumb : ''}
  </div>`;
}

function renderItems() {
  const box = $('#items');
  box.className = 'items ' + state.view;

  if (!state.items.length) {
    if (!state.feeds.length) {
      box.innerHTML = `<div class="empty">
        <div class="art"><svg viewBox="0 0 24 24"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.4" fill="currentColor" stroke="none"/></svg></div>
        <h3>还没有订阅任何内容</h3>
        <p>导入你的 OPML 订阅文件，或者手动添加一个 RSS / Atom 订阅源。</p>
        <div class="empty-actions">
          <button class="btn primary" data-action="import">导入 OPML</button>
          <button class="btn ghost" data-action="add-feed">添加订阅</button>
        </div>
      </div>`;
      return;
    }
    box.innerHTML = `<div class="empty">
      <div class="art"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg></div>
      <h3>${state.q ? '没有匹配的文章' : '这里是空的'}</h3>
      <p>${state.q ? '试试其他关键词，或清空搜索条件。' : '这个订阅源暂时没有文章，点右上角刷新试试。'}</p>
    </div>`;
    return;
  }

  box.innerHTML = state.items.map(itemHtml).join('');
}

/* ======================= 阅读器 ======================= */

function readerEmptyHtml() {
  return `<div class="reader-empty">
    <div class="art"><svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5V5.5Z"/><path d="M19 19v2H6.5A2.5 2.5 0 0 1 4 18.5"/><path d="M8 7h7M8 11h7"/></svg></div>
    <h3>选择一篇文章开始阅读</h3>
    <p>用 <kbd>J</kbd> / <kbd>K</kbd> 切换文章，<kbd>M</kbd> 标记已读，<kbd>S</kbd> 收藏，<kbd>R</kbd> 刷新订阅。</p>
  </div>`;
}

function renderReaderEmpty() {
  $('#reader').classList.remove('open');
  $('#reader').innerHTML = readerEmptyHtml();
}

function closeReader() {
  $('#reader').classList.remove('open');
}

const ALLOWED_TAGS = new Set(
  ('a abbr b blockquote br caption cite code col colgroup dd del details div dl dt em figcaption figure ' +
    'h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small source span strong sub summary sup ' +
    'table tbody td tfoot th thead tr u ul video audio picture iframe').split(' ')
);
const ALLOWED_ATTR = new Set([
  'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'srcset', 'poster',
  'controls', 'datetime', 'cite', 'lang', 'dir', 'start', 'type', 'sizes', 'media',
]);

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, 'text/html');
  const root = doc.getElementById('__root');

  root.querySelectorAll('script,style,link,meta,base,form,input,button,select,textarea,noscript,object,embed,applet,svg,math,template').forEach((n) => n.remove());

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const toUnwrap = [];
  const toRemove = [];
  let node = walker.nextNode();
  while (node) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'iframe') {
      // 只保留视频类嵌入，其余一律移除
      const src = node.getAttribute('src') || '';
      if (!/youtube\.com|youtu\.be|player\.bilibili\.com|vimeo\.com/i.test(src)) toRemove.push(node);
    } else if (!ALLOWED_TAGS.has(tag)) {
      toUnwrap.push(node);
    }
    node = walker.nextNode();
  }
  toRemove.forEach((n) => n.remove());
  toUnwrap.reverse().forEach((n) => {
    const parent = n.parentNode;
    if (!parent) return;
    while (n.firstChild) parent.insertBefore(n.firstChild, n);
    n.remove();
  });

  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (name === 'style') {
        el.removeAttribute('style');
        continue;
      }
      if (!ALLOWED_ATTR.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && /^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG') {
      const lazy = el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('data-lazy-src');
      if (lazy && (!el.getAttribute('src') || /^data:image\/gif/.test(el.getAttribute('src') || ''))) {
        el.setAttribute('src', lazy);
      }
      if (!el.getAttribute('src')) el.remove();
      el.setAttribute('loading', 'lazy');
    }
  });

  return root.innerHTML;
}

function readerDocCss() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
  const text = v('--text', '#15181d');
  const text2 = v('--text-2', '#495260');
  const muted = v('--muted', '#8a94a3');
  const accent = v('--accent', '#2f6fdd');
  const panel3 = v('--panel-3', '#f2f5f9');
  const border = v('--border', '#e7eaf0');
  const bg = v('--panel', '#fff');

  return `
  :root { color-scheme: ${state.theme === 'dark' ? 'dark' : 'light'}; }
  html, body { margin: 0; padding: 0; background: ${bg}; }
  body {
    font-family: -apple-system, system-ui, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
    font-size: 15px; line-height: 1.78; color: ${text};
    padding: 22px 26px 64px; max-width: 812px; box-sizing: border-box; margin: 0 auto;
    overflow-wrap: break-word; -webkit-font-smoothing: antialiased;
  }
  p { margin: 0 0 1em; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.4; margin: 1.6em 0 .6em; font-weight: 700; }
  h1 { font-size: 1.5em; } h2 { font-size: 1.32em; } h3 { font-size: 1.18em; }
  a { color: ${accent}; text-decoration: none; border-bottom: 1px solid color-mix(in srgb, ${accent} 30%, transparent); }
  a:hover { border-bottom-color: ${accent}; }
  img, video { max-width: 100%; height: auto; border-radius: 8px; display: block; margin: 1em auto; }
  figure { margin: 1.2em 0; }
  figcaption { font-size: .82em; color: ${muted}; text-align: center; margin-top: .5em; }
  pre { background: ${panel3}; padding: 12px 14px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.6; }
  code { background: ${panel3}; padding: .12em .35em; border-radius: 4px; font-size: .9em; font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 1.2em 0; padding: .2em 0 .2em 1em; border-left: 3px solid ${border}; color: ${text2}; }
  hr { border: none; border-top: 1px solid ${border}; margin: 2em 0; }
  table { border-collapse: collapse; width: 100%; margin: 1.2em 0; font-size: .92em; display: block; overflow-x: auto; }
  th, td { border: 1px solid ${border}; padding: 7px 10px; text-align: left; }
  th { background: ${panel3}; font-weight: 600; }
  ul, ol { padding-left: 1.4em; margin: 0 0 1em; }
  li { margin: .3em 0; }
  small { color: ${muted}; }
  .plain-note { color: ${muted}; font-size: .9em; }
  iframe { max-width: 100%; border-radius: 8px; border: none; }
  `;
}

function buildReaderDoc(item, contentHtml) {
  const base = item.link || item.feedSiteUrl || 'https://localhost/';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><base href="${esc(base)}" target="_blank">
    <style>${readerDocCss()}</style></head><body>${contentHtml}</body></html>`;
}

function renderReader(item, { keepScroll = false } = {}) {
  const reader = $('#reader');
  const prevScroll = keepScroll ? reader.querySelector('.reader-body')?.scrollTop || 0 : 0;
  const index = state.items.findIndex((i) => i.id === item.id);

  const content = item.content && item.content.trim()
    ? sanitizeHtml(item.content)
    : `<p>${esc(item.summary || '该文章没有正文内容。')}</p><p class="plain-note">请点击右上角「原文」查看完整内容。</p>`;

  reader.innerHTML = `
    <div class="reader-head">
      <div class="reader-head-inner">
        <div class="reader-topline">
          <div class="reader-feed">
            ${avatarHtml(item.feedTitle, item.feedIcon, 18)}
            <span class="name" title="${esc(item.feedTitle)}">${esc(item.feedTitle)}</span>
          </div>
          <div class="reader-actions">
            <button class="iconbtn ${item.starred ? 'on' : ''}" data-act="star" title="收藏 (S)">
              <svg viewBox="0 0 24 24" class="ic"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"/></svg>
            </button>
            <button class="iconbtn" data-act="unread" title="标为未读 (M)">
              <svg viewBox="0 0 24 24" class="ic"><path d="M3 8.5 12 14l9-5.5"/><rect x="3" y="5" width="18" height="14" rx="2"/></svg>
            </button>
            <button class="iconbtn" data-act="prev" title="上一篇 (K)" ${index <= 0 ? 'disabled style="opacity:.35"' : ''}>
              <svg viewBox="0 0 24 24" class="ic"><path d="m6 15 6-6 6 6"/></svg>
            </button>
            <button class="iconbtn" data-act="next" title="下一篇 (J)" ${index < 0 || index >= state.items.length - 1 ? 'disabled style="opacity:.35"' : ''}>
              <svg viewBox="0 0 24 24" class="ic"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <button class="iconbtn only-mobile" data-act="close" title="关闭">
              <svg viewBox="0 0 24 24" class="ic"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        <h1 class="reader-title">${esc(item.title)}</h1>
        <div class="reader-meta">
          <span title="${esc(fullTime(item.publishedAt))}">${timeAgo(item.publishedAt)}</span>
          ${item.author ? `<span class="sep">·</span><span>${esc(item.author)}</span>` : ''}
          ${item.link ? `<a class="reader-link" href="${esc(item.link)}" target="_blank" rel="noopener">原文
            <svg viewBox="0 0 24 24" class="ic"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
          </a>` : ''}
        </div>
      </div>
    </div>
    <div class="reader-body"><iframe id="reader-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe></div>
  `;

  const frame = $('#reader-frame');
  frame.srcdoc = buildReaderDoc(item, content);

  const fit = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      const h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
      frame.style.height = h + 'px';
    } catch {
      /* ignore */
    }
  };
  frame.addEventListener('load', () => {
    fit();
    [120, 400, 900].forEach((t) => setTimeout(fit, t));
    const body = frame.contentDocument && frame.contentDocument.body;
    if (body) {
      body.querySelectorAll('img').forEach((img) => {
        img.addEventListener('load', fit);
        img.addEventListener('error', () => {
          img.style.display = 'none';
          fit();
        });
        if (img.complete && img.naturalWidth === 0) img.style.display = 'none';
      });
    }
    const bodyBox = reader.querySelector('.reader-body');
    if (bodyBox && prevScroll) bodyBox.scrollTop = prevScroll;
  });

  reader.classList.add('open');
  state.current = item;
  state.selectedId = item.id;
  $$('#items .item').forEach((el) => el.classList.toggle('selected', el.dataset.id === item.id));
}

/* ======================= 打开文章 / 已读 ======================= */

async function openItem(id) {
  const existing = state.items.find((i) => i.id === id);
  try {
    const item = await api('/api/items/' + id);
    renderReader(item);
    if (!item.read) markItemRead(id, true, { silent: true });
    if (existing && !existing.read) {
      existing.read = true;
      const el = $(`#items .item[data-id="${id}"]`);
      if (el) el.classList.replace('unread', 'read');
      if (state.scope.type === 'unread') {
        // 保持列表不动，仅同步计数
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function markItemRead(id, read, { silent = false } = {}) {
  try {
    await api(`/api/items/${id}/read`, { method: 'POST', body: { read } });
    const item = state.items.find((i) => i.id === id);
    if (item) item.read = read;
    const el = $(`#items .item[data-id="${id}"]`);
    if (el) {
      el.classList.toggle('read', read);
      el.classList.toggle('unread', !read);
    }
    await refreshCounts();
    if (!silent) toast(read ? '已标为已读' : '已标为未读');
    if (state.scope.type === 'unread' && read && !silent) {
      state.items = state.items.filter((i) => i.id !== id);
      renderItems();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function toggleStar() {
  const item = state.current;
  if (!item) return;
  const next = !item.starred;
  try {
    await api(`/api/items/${item.id}/star`, { method: 'POST', body: { starred: next } });
    item.starred = next;
    const btn = $('#reader [data-act="star"]');
    if (btn) btn.classList.toggle('on', next);
    const row = state.items.find((i) => i.id === item.id);
    if (row) row.starred = next;
    const el = $(`#items .item[data-id="${item.id}"]`);
    if (el) el.classList.toggle('starred', next);
    refreshCounts();
    toast(next ? '已加入收藏' : '已取消收藏');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function refreshCounts() {
  try {
    const data = await api('/api/state');
    state.counts = data.counts;
    state.folderUnread = data.folderUnread;
    state.feeds = data.feeds;
    state.folders = data.folders;
    renderSidebar();
  } catch {
    /* ignore */
  }
}

/* ======================= 刷新 ======================= */

function setProgressUI(p) {
  const bar = $('#progressbar-bar');
  const wrap = $('#progressbar');
  const btn = $('#btn-refresh');
  if (p && p.running) {
    const pct = p.total ? Math.max(3, Math.round((p.done / p.total) * 100)) : 5;
    bar.style.width = pct + '%';
    wrap.style.opacity = '1';
    btn.classList.add('spinning');
    btn.disabled = true;
    $('#btn-refresh-scope').classList.add('spinning');
  } else {
    bar.style.width = '100%';
    wrap.style.opacity = '0';
    setTimeout(() => { if (!state.progress.running) bar.style.width = '0%'; }, 400);
    btn.classList.remove('spinning');
    btn.disabled = false;
    $('#btn-refresh-scope').classList.remove('spinning');
  }
}

// 一次「刷新」可能被服务端拆成多批（Cloudflare 免费版有子请求上限），
// 这里记录本轮的总量和累计新增，批次之间自动接着跑。
let refreshSession = null;

async function startRefresh(scope = 'all', { isContinuation = false, silent = false } = {}) {
  if (!isContinuation) refreshSession = { scope, rounds: 0, added: 0, done: 0, since: Date.now() };
  try {
    const data = await api('/api/refresh', { method: 'POST', body: { scope, since: refreshSession ? refreshSession.since : 0 } });
    if (!data.started) {
      if (!isContinuation && !silent) toast(data.empty ? '所有订阅都还很新，稍后再试' : '已有刷新任务在进行中');
      refreshSession = null;
      return;
    }
    state.progress = data.progress;
    setProgressUI(state.progress);
    pollProgress();
  } catch (err) {
    refreshSession = null;
    toast(err.message, 'error');
  }
}

function pollProgress(expectStart = false) {
  clearInterval(state.pollTimer);
  const t0 = Date.now();
  state.pollTimer = setInterval(async () => {
    let p;
    try {
      p = await api('/api/refresh/status');
    } catch {
      return;
    }
    state.progress = p;
    setProgressUI(p);
    if (p.running) return;

    // 导入后服务端会延迟几百毫秒才开始抓取，给一段宽限期避免过早判定“已结束”
    if (expectStart && Date.now() - t0 < 6000 && p.startedAt < t0) return;

    clearInterval(state.pollTimer);
    state.pollTimer = null;

    const session = refreshSession;
    if (session) {
      session.added += p.added || 0;
      session.done = (session.done || 0) + (p.done || 0);
    }

    // 还有剩余批次：自动接着刷（最多 40 批，避免死循环）
    if (p.remaining > 0 && session && session.rounds < 200) {
      session.rounds++;
      setTimeout(() => startRefresh(session.scope, { isContinuation: true }), 200);
      return;
    }

    refreshSession = null;
    await refreshCounts();
    await loadItems();
    if (state.current) {
      const still = state.items.find((i) => i.id === state.current.id);
      if (still) openItem(still.id);
    }

    const totalAdded = session ? session.added : p.added || 0;
    const totalDone = session && session.done ? session.done : p.done;
    const parts = [`刷新完成 · ${totalDone} 个订阅`];
    if (totalAdded) parts.push(`新增 ${totalAdded} 篇`);
    if (p.failed) parts.push(`${p.failed} 个失败`);
    // 打开页面时的自动补刷不打扰用户（除非确实有新文章）
    if (p.mode !== 'due' || totalAdded > 0) toast(parts.join('，'), p.failed ? '' : 'success');
  }, 700);
}

/* ======================= 弹窗 ======================= */

let modalEscHandler = null;

function modal({ title, body, footer = '', wide = false, onMount }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-mask">
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="modal-close" data-close>
          <svg viewBox="0 0 24 24" class="ic"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>
  </div>`;
  const mask = root.firstElementChild;
  const close = () => {
    mask.remove();
    document.removeEventListener('keydown', modalEscHandler);
    modalEscHandler = null;
  };
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) close();
  });
  modalEscHandler = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', modalEscHandler);
  if (onMount) onMount({ el: mask, close });
  return { el: mask, close };
}

function folderOptions(selected) {
  return (
    `<option value="">未分类</option>` +
    state.folders
      .map((f) => `<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${esc(f.name)}</option>`)
      .join('')
  );
}

function openAddFeedDialog() {
  modal({
    title: '添加订阅',
    body: `
      <div class="field">
        <label>订阅地址</label>
        <div class="row">
          <input class="input" id="feed-url" placeholder="https://example.com/feed.xml 或网站首页" spellcheck="false">
          <button class="btn ghost" id="btn-preview">检测</button>
        </div>
        <div class="hint">支持 RSS / Atom 地址；也可以直接粘贴网站首页，会自动寻找订阅链接。</div>
      </div>
      <div id="preview-slot"></div>
      <div class="field">
        <label>归入文件夹</label>
        <select class="select" id="feed-folder" style="width:100%">${folderOptions('')}</select>
      </div>`,
    footer: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="btn-save-feed">添加订阅</button>`,
    onMount: ({ el, close }) => {
      const urlInput = $('#feed-url', el);
      const slot = $('#preview-slot', el);
      const folderSel = $('#feed-folder', el);
      let previewed = null;

      const doPreview = async () => {
        const url = urlInput.value.trim();
        if (!url) return;
        slot.innerHTML = `<div class="preview-card"><span class="pm">正在检测订阅…</span></div>`;
        try {
          const p = await api('/api/feeds/preview', { method: 'POST', body: { url } });
          previewed = p;
          slot.innerHTML = `<div class="preview-card">
            <div class="pt">${esc(p.title)}</div>
            <div class="pm">${esc(p.siteUrl || p.url)}</div>
            <div class="pm">${p.itemCount} 篇文章${p.latest ? ` · 最新 ${timeAgo(p.latest)}` : ''}${
              p.discovered ? ' · 已自动发现订阅地址' : ''
            }</div>
            ${p.sample.length ? `<ul class="psample">${p.sample.map((s) => `<li>${esc(s.title)}</li>`).join('')}</ul>` : ''}
          </div>`;
        } catch (err) {
          previewed = null;
          slot.innerHTML = `<div class="preview-card" style="border-color:var(--danger)"><span style="color:var(--danger)">${esc(err.message)}</span></div>`;
        }
      };

      $('#btn-preview', el).addEventListener('click', doPreview);
      urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doPreview();
      });
      setTimeout(() => urlInput.focus(), 60);

      $('#btn-save-feed', el).addEventListener('click', async (e) => {
        const url = urlInput.value.trim();
        if (!url) {
          toast('请输入订阅地址', 'error');
          return;
        }
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '添加中…';
        try {
          const data = await api('/api/feeds', {
            method: 'POST',
            body: { url: previewed ? previewed.url : url, folderId: folderSel.value || null },
          });
          close();
          await refreshCounts();
          await loadItems();
          toast(data.added ? `已添加，抓取到 ${data.added} 篇文章` : '已添加订阅', 'success');
          if (data.error) toast('抓取失败：' + data.error, 'error');
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = '添加订阅';
        }
      });
    },
  });
}

function openFolderDialog() {
  modal({
    title: '新建文件夹',
    body: `<div class="field"><label>文件夹名称</label><input class="input" id="folder-name" placeholder="例如：科技资讯"></div>`,
    footer: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="btn-save-folder">创建</button>`,
    onMount: ({ el, close }) => {
      const input = $('#folder-name', el);
      setTimeout(() => input.focus(), 60);
      const save = async () => {
        const name = input.value.trim();
        if (!name) return toast('请输入名称', 'error');
        try {
          await api('/api/folders', { method: 'POST', body: { name } });
          close();
          await refreshCounts();
          toast('文件夹已创建', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      $('#btn-save-folder', el).addEventListener('click', save);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    },
  });
}

function openRenameDialog(type, id, currentName) {
  modal({
    title: type === 'feed' ? '重命名订阅' : '重命名文件夹',
    body: `<div class="field"><label>名称</label><input class="input" id="rename-input" value="${esc(currentName)}"></div>`,
    footer: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="btn-rename">保存</button>`,
    onMount: ({ el, close }) => {
      const input = $('#rename-input', el);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 60);
      const save = async () => {
        const name = input.value.trim();
        if (!name) return;
        try {
          await api(`/api/${type === 'feed' ? 'feeds' : 'folders'}/${id}`, { method: 'PATCH', body: { title: name, name } });
          close();
          await refreshCounts();
          await loadItems();
          toast('已重命名', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      $('#btn-rename', el).addEventListener('click', save);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    },
  });
}

function openConfirm({ title, message, confirmText = '删除', requireText = '', onConfirm }) {
  modal({
    title,
    body: `<p style="margin:0;color:var(--text-2);line-height:1.7">${message}</p>${
      requireText
        ? `<div class="field" style="margin-top:14px">
             <label>请输入 <code style="background:var(--panel-3);padding:1px 5px;border-radius:4px">${esc(requireText)}</code> 以确认</label>
             <input class="input" id="confirm-text" spellcheck="false" autocomplete="off" placeholder="${esc(requireText)}">
           </div>`
        : ''
    }`,
    footer: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="btn-confirm" style="background:var(--danger)" ${
      requireText ? 'disabled' : ''
    }>${esc(confirmText)}</button>`,
    onMount: ({ el, close }) => {
      const btn = $('#btn-confirm', el);
      if (requireText) {
        const input = $('#confirm-text', el);
        input.addEventListener('input', () => {
          btn.disabled = input.value.trim() !== requireText;
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !btn.disabled) btn.click();
        });
        setTimeout(() => input.focus(), 60);
      }
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        try {
          await onConfirm();
          close();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    },
  });
}

function openImportDialog() {
  const dialog = modal({
    title: '导入 OPML 订阅',
    wide: true,
    body: `
      <div class="dropzone" id="dropzone">
        <svg viewBox="0 0 24 24" class="ic"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
        <div>点击选择文件，或把 .opml 文件拖到这里</div>
        <div style="margin-top:4px;opacity:.7">兼容 Feedbro / Feedly / Inoreader 等导出的 OPML</div>
      </div>
      <div id="import-result"></div>`,
    footer: `<button class="btn ghost" data-close>关闭</button>`,
    onMount: ({ el }) => {
      const dz = $('#dropzone', el);
      const result = $('#import-result', el);

      const upload = async (file) => {
        if (!file) return;
        dz.innerHTML = `<div>正在导入 ${esc(file.name)} …</div>`;
        try {
          const text = await file.text();
          const data = await api('/api/opml', {
            method: 'POST',
            body: text,
            headers: { 'content-type': 'text/x-opml' },
          });
          result.innerHTML = `<div class="preview-card">
            <div class="pt">导入完成</div>
            <div class="pm">新增订阅 ${data.added} 个 · 跳过已存在 ${data.skipped} 个 · 新建文件夹 ${data.foldersCreated} 个</div>
            <div class="pm">正在后台抓取文章，稍候即可在列表中看到。</div>
          </div>`;
          dz.style.display = 'none';
          await refreshCounts();
          await loadItems();
          pollProgress(true);
        } catch (err) {
          result.innerHTML = `<div class="preview-card" style="border-color:var(--danger)"><span style="color:var(--danger)">${esc(err.message)}</span></div>`;
          dz.innerHTML = `<div>点击选择文件，或把 .opml 文件拖到这里</div>`;
        }
      };

      dz.addEventListener('click', () => {
        const input = $('#file-input');
        input.value = '';
        input.onchange = () => upload(input.files[0]);
        input.click();
      });
      ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
      dz.addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));
    },
  });
}

function openSettingsDialog() {
  const s = state.settings || {};
  const intervals = [
    [900, '15 分钟'],
    [1800, '30 分钟'],
    [3600, '1 小时'],
    [10800, '3 小时'],
    [21600, '6 小时'],
    [43200, '12 小时'],
  ];
  modal({
    title: '设置',
    wide: true,
    body: `
      <div class="stat-grid">
        <div class="stat-box"><div class="v">${state.feeds.length}</div><div class="k">订阅源</div></div>
        <div class="stat-box"><div class="v">${state.counts.items}</div><div class="k">文章总数</div></div>
        <div class="stat-box"><div class="v">${state.counts.unread}</div><div class="k">未读</div></div>
      </div>

      <div class="opt-row">
        <div class="label">自动刷新间隔<small>后台会按此间隔轮询所有订阅源</small></div>
        <select class="select" id="opt-interval">
          ${intervals.map(([v, t]) => `<option value="${v}" ${Number(s.refreshInterval) === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="opt-row">
        <div class="label">每个订阅保留文章数<small>超出后自动清理最旧的文章</small></div>
        <input class="input" id="opt-max" type="number" min="20" max="5000" step="10" value="${Number(s.maxItemsPerFeed) || 300}" style="width:110px">
      </div>
      <div class="opt-row">
        <div class="label">PushPlus 推送<small>订阅有新文章时推送到微信；Token 在 <a href="https://www.pushplus.plus" target="_blank" rel="noopener">pushplus.plus</a> 微信扫码登录后获取</small></div>
        <div class="row" style="gap:6px;flex-wrap:nowrap">
          <input class="input" id="opt-push-token" placeholder="PushPlus Token" spellcheck="false" autocomplete="off" value="${esc(s.pushToken || '')}" style="width:132px">
          <button class="btn ghost" id="opt-push-test" title="发送一条测试消息">测试</button>
          <label class="checkbox"><input type="checkbox" id="opt-push-enabled" ${s.pushEnabled ? 'checked' : ''}>启用</label>
        </div>
      </div>
      <div class="opt-row">
        <div class="label">主题</div>
        <select class="select" id="opt-theme">
          <option value="light" ${state.theme === 'light' ? 'selected' : ''}>浅色</option>
          <option value="dark" ${state.theme === 'dark' ? 'selected' : ''}>深色</option>
          <option value="sepia" ${state.theme === 'sepia' ? 'selected' : ''}>护眼</option>
        </select>
      </div>
      <div class="opt-row">
        <div class="label">网络代理<small>通过环境变量 HTTPS_PROXY 配置，用于抓取需要代理的源</small></div>
        <span style="font-size:12px;color:var(--muted);max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right">${state.proxy ? esc(state.proxy) : '未配置（直连）'}</span>
      </div>
      <div class="opt-row">
        <div class="label">订阅数据<small>导出的文件可导入 Feedbro 等其他阅读器</small></div>
        <div class="row" style="gap:6px">
          <button class="btn ghost" id="opt-import">导入</button>
          <button class="btn ghost" id="opt-export">导出</button>
        </div>
      </div>
      <div class="opt-row">
        <div class="label">清空所有订阅<small>删除当前账号的全部订阅、文件夹和文章，账号保留</small></div>
        <button class="btn danger" id="opt-clear-subs">清空</button>
      </div>
      ${
        state.user && state.user.role === 'admin'
          ? `<div class="opt-row">
               <div class="label">初始化设置<small>清空所有账号的订阅与文章，管理员密码恢复为 admin，需要重新登录</small></div>
               <button class="btn danger" id="opt-reset">初始化</button>
             </div>`
          : ''
      }
      <div class="hint" style="color:var(--muted);font-size:11.5px">FeedNest v${esc(state.version)} · 数据保存在服务端 SQLite 中，刷新页面不会丢失</div>`,
    footer: `<button class="btn ghost" data-close>关闭</button><button class="btn primary" id="btn-save-settings">保存设置</button>`,
    onMount: ({ el, close }) => {
      $('#opt-theme', el).addEventListener('change', (e) => {
        state.theme = e.target.value;
        applyTheme();
      });
      $('#opt-import', el).addEventListener('click', () => {
        close();
        openImportDialog();
      });
      $('#opt-export', el).addEventListener('click', exportOpml);

      $('#opt-push-test', el).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const token = $('#opt-push-token', el).value.trim();
        if (!token) return toast('请先填写 PushPlus Token', 'error');
        btn.disabled = true;
        btn.textContent = '发送中…';
        try {
          await api('/api/push/test', { method: 'POST', body: { token } });
          toast('测试消息已发送，请查看微信', 'success');
        } catch (err) {
          toast('测试失败：' + err.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '测试';
        }
      });

      $('#opt-clear-subs', el).addEventListener('click', () => {
        close();
        openConfirm({
          title: '清空所有订阅',
          message:
            '将删除<b>当前账号</b>的全部订阅、文件夹和文章，账号本身保留。<br>此操作不可撤销，建议先「导出 OPML」备份。',
          confirmText: '清空',
          requireText: '清空',
          onConfirm: async () => {
            const res = await api('/api/subscriptions/clear', { method: 'POST' });
            state.items = [];
            state.total = 0;
            state.current = null;
            state.selectedId = null;
            renderReaderEmpty();
            await loadState();
            await loadItems();
            toast(`已清空：${res.removed.feeds} 个订阅、${res.removed.items} 篇文章`, 'success');
          },
        });
      });

      const resetBtn = $('#opt-reset', el);
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          close();
          openConfirm({
            title: '初始化设置',
            message:
              '将执行以下操作：<br>· 清空<b>所有账号</b>的订阅、文件夹和文章<br>· 重置所有偏好设置<br>· 所有账号退出登录<br>· 管理员密码恢复为 <code>admin</code><br><br>账号本身会保留，此操作不可撤销。',
            confirmText: '初始化',
            requireText: 'RESET',
            onConfirm: async () => {
              await api('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET' } });
              state.user = null;
              state.items = [];
              state.total = 0;
              state.current = null;
              state.selectedId = null;
              $('#items').innerHTML = '';
              $('#tree').innerHTML = '';
              renderReaderEmpty();
              showLogin('已初始化，请使用 admin / admin 重新登录');
              toast('已恢复初始状态', 'success');
            },
          });
        });
      }
      $('#btn-save-settings', el).addEventListener('click', async () => {
        try {
          const data = await api('/api/settings', {
            method: 'POST',
            body: {
              refreshInterval: Number($('#opt-interval', el).value),
              maxItemsPerFeed: Number($('#opt-max', el).value),
              pushEnabled: $('#opt-push-enabled', el).checked,
              pushToken: $('#opt-push-token', el).value.trim(),
            },
          });
          state.settings = data.settings;
          close();
          toast('设置已保存', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    },
  });
}

function exportOpml() {
  const a = document.createElement('a');
  a.href = '/api/opml';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('正在导出 OPML…', 'success');
}

/* ======================= 订阅状态 ======================= */

async function openStatsDialog() {
  const data = await api('/api/stats');
  const feeds = data.feeds
    .slice()
    .sort((a, b) => (b.lastStatus === 'error') - (a.lastStatus === 'error') || b.total - a.total);

  const rowHtml = (f) => {
    const failed = f.lastStatus === 'error';
    return `<div class="feed-item">
      ${avatarHtml(f.title, null, 20)}
      <div class="name">
        <div class="fn" title="${esc(f.url)}">${esc(f.title)}</div>
        ${failed ? `<div class="fe">${esc(f.lastError || '抓取失败')}</div>` : ''}
      </div>
      <span class="badge ${failed ? 'err' : 'ok'}">${failed ? '异常' : '正常'}</span>
      <span class="meta">${f.total} 篇</span>
      <span class="meta" style="min-width:64px;text-align:right">${f.lastFetchAt ? timeAgo(f.lastFetchAt) : '未抓取'}</span>
      <button class="mini-btn" data-retry="${f.id}" title="重新抓取">
        <svg viewBox="0 0 24 24" class="ic"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>`;
  };

  modal({
    title: `订阅状态（${feeds.length} 个源 · ${feeds.filter((f) => f.lastStatus === 'error').length} 个异常）`,
    wide: true,
    body: `<div class="feed-list" id="feed-list">${feeds.map(rowHtml).join('')}</div>`,
    footer: `<button class="btn ghost" data-close>关闭</button>`,
    onMount: ({ el }) => {
      const list = $('#feed-list', el);
      list.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-retry]');
        if (!btn) return;
        const id = btn.dataset.retry;
        btn.classList.add('spinning');
        try {
          const r = await api(`/api/feeds/${id}/refresh`, { method: 'POST' });
          await refreshCounts();
          if (r.status === 'error') toast('仍然失败：' + r.error, 'error');
          else toast(`已更新${r.added ? `，新增 ${r.added} 篇` : ''}`, 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
        // 局部刷新该行
        const fresh = (await api('/api/stats')).feeds.find((f) => f.id === id);
        if (fresh) {
          const old = list.querySelector(`[data-retry="${id}"]`).closest('.feed-item');
          const tmp = document.createElement('div');
          tmp.innerHTML = rowHtml(fresh);
          old.replaceWith(tmp.firstElementChild);
        }
      });
    },
  });
}

/* ======================= 右键菜单 ======================= */

let ctxEl = null;
function closeCtx() {
  if (ctxEl) {
    ctxEl.remove();
    ctxEl = null;
  }
}

function openCtx(x, y, items) {
  closeCtx();
  const el = document.createElement('div');
  el.className = 'ctxmenu';
  el.innerHTML = items
    .map((it) => (it.sep ? '<div class="sep"></div>' : `<button class="${it.danger ? 'danger' : ''}" data-act="${it.act}">${it.label}</button>`))
    .join('');
  document.body.appendChild(el);
  const rect = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  el.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  ctxEl = el;
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const action = items.find((i) => i.act === btn.dataset.act);
    closeCtx();
    action && action.run && action.run();
  });
}

document.addEventListener('click', (e) => {
  if (ctxEl && !ctxEl.contains(e.target)) closeCtx();
});
document.addEventListener('scroll', closeCtx, true);

/* ======================= 事件绑定 ======================= */

function bindEvents() {
  /* ---- 登录 / 账号 ---- */
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-submit');
    const username = $('#login-user').value.trim();
    const password = $('#login-pass').value;
    const err = $('#login-error');
    if (!username || !password) {
      err.hidden = false;
      err.textContent = '请输入用户名和密码';
      return;
    }
    btn.disabled = true;
    btn.textContent = '登录中…';
    err.hidden = true;
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: { username, password } });
      state.user = data.user;
      $('#login-pass').value = '';
      showApp();
      await loadState();
      await loadItems();
      toast(`欢迎回来，${data.user.username}`, 'success');
    } catch (e2) {
      err.hidden = false;
      err.textContent = e2.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  $('#btn-user').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#usermenu').classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-user-act]');
    if (!btn) {
      if (!e.target.closest('#usermenu')) closeUserMenu();
      return;
    }
    closeUserMenu();
    const act = btn.dataset.userAct;
    if (act === 'password') openPasswordDialog();
    if (act === 'users') openUsersDialog();
    if (act === 'logout') doLogout();
  });

  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    const nav = btn.dataset.nav;
    state.unreadOnly = false;
    setScope({ type: nav, id: null });
  });

  $('#tree').addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const type = row.dataset.type;
    const id = row.dataset.id;
    if (type === 'folder') {
      // 点击箭头折叠，点击名称筛选
      if (e.target.closest('.chev')) {
        toggleFolder(id);
        return;
      }
      const folderEl = row.closest('.tree-folder');
      if (e.detail === 1 && state.scope.type === 'folder' && state.scope.id === id) {
        toggleFolder(id);
      }
      setScope({ type: 'folder', id });
      if (folderEl.classList.contains('collapsed')) toggleFolder(id, false);
    } else if (type === 'feed') {
      setScope({ type: 'feed', id });
    }
  });

  $('#tree').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    e.preventDefault();
    const { type, id } = row.dataset;
    if (type === 'feed') {
      const feed = state.feeds.find((f) => f.id === id);
      openCtx(e.clientX, e.clientY, [
        {
          act: 'refresh',
          label: '刷新此订阅',
          run: async () => {
            try {
              const r = await api(`/api/feeds/${id}/refresh`, { method: 'POST' });
              await refreshCounts();
              await loadItems();
              toast(r.status === 'error' ? '刷新失败：' + r.error : `已刷新，新增 ${r.added || 0} 篇`, r.status === 'error' ? 'error' : 'success');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        { act: 'rename', label: '重命名', run: () => openRenameDialog('feed', id, feed ? feed.title : '') },
        { act: 'open', label: '打开网站', run: () => feed && feed.siteUrl && window.open(feed.siteUrl, '_blank', 'noopener') },
        { sep: true },
        {
          act: 'delete',
          label: '删除订阅',
          danger: true,
          run: () =>
            openConfirm({
              title: '删除订阅',
              message: `确定要删除「${esc(feed ? feed.title : '')}」吗？该订阅下的所有文章也会被删除，此操作不可撤销。`,
              onConfirm: async () => {
                await api('/api/feeds/' + id, { method: 'DELETE' });
                if (state.scope.type === 'feed' && state.scope.id === id) setScope({ type: 'all' });
                await refreshCounts();
                await loadItems();
                toast('已删除订阅', 'success');
              },
            }),
        },
      ]);
    } else if (type === 'folder') {
      const folder = state.folders.find((f) => f.id === id);
      openCtx(e.clientX, e.clientY, [
        { act: 'rename', label: '重命名文件夹', run: () => openRenameDialog('folder', id, folder ? folder.name : '') },
        {
          act: 'read',
          label: '全部标为已读',
          run: async () => {
            await api('/api/mark-read', { method: 'POST', body: { scope: 'folder:' + id } });
            await refreshCounts();
            await loadItems();
            toast('已全部标为已读', 'success');
          },
        },
        { sep: true },
        {
          act: 'delete',
          label: '删除文件夹',
          danger: true,
          run: () =>
            openConfirm({
              title: '删除文件夹',
              message: `确定要删除文件夹「${esc(folder ? folder.name : '')}」吗？里面的订阅会移到「未分类」，不会被删除。`,
              onConfirm: async () => {
                await api('/api/folders/' + id, { method: 'DELETE' });
                if (state.scope.type === 'folder' && state.scope.id === id) setScope({ type: 'all' });
                await refreshCounts();
                await loadItems();
                toast('已删除文件夹', 'success');
              },
            }),
        },
      ]);
    }
  });

  $('#items').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) openItem(item.dataset.id);
  });

  $('#items').addEventListener('scroll', () => {
    const box = $('#items');
    if (box.scrollTop + box.clientHeight > box.scrollHeight - 260) {
      if (!state.loading && state.items.length < state.total) loadItems({ append: true });
    }
  });

  $('#reader').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const index = state.items.findIndex((i) => i.id === (state.current && state.current.id));
    if (act === 'star') toggleStar();
    if (act === 'unread') {
      markItemRead(state.current.id, false);
      renderReader(state.current);
    }
    if (act === 'prev' && index > 0) openItem(state.items[index - 1].id);
    if (act === 'next' && index >= 0 && index < state.items.length - 1) openItem(state.items[index + 1].id);
    if (act === 'close') closeReader();
  });

  $('#btn-refresh').addEventListener('click', () => startRefresh('all'));
  $('#btn-refresh-scope').addEventListener('click', () => {
    if (state.scope.type === 'feed') startRefresh('feed:' + state.scope.id);
    else if (state.scope.type === 'folder') startRefresh('folder:' + state.scope.id);
    else startRefresh('all');
  });
  $('#btn-add-feed').addEventListener('click', openAddFeedDialog);
  $('#btn-add-folder').addEventListener('click', openFolderDialog);
  $('#btn-new-folder').addEventListener('click', openFolderDialog);
  $('#btn-import').addEventListener('click', openImportDialog);
  $('#btn-export').addEventListener('click', exportOpml);
  $('#btn-settings').addEventListener('click', openSettingsDialog);
  $('#btn-theme').addEventListener('click', cycleTheme);
  $('#btn-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('.sidebar-foot').addEventListener('click', openStatsDialog);

  $('#btn-mark-read').addEventListener('click', () => {
    const label = scopeTitle();
    openConfirm({
      title: '全部标为已读',
      message: `确定把「${esc(label)}」中的所有文章标为已读吗？`,
      confirmText: '标为已读',
      onConfirm: async () => {
        await api('/api/mark-read', { method: 'POST', body: { scope: scopeParam() } });
        await refreshCounts();
        await loadItems();
        toast('已全部标为已读', 'success');
      },
    });
  });

  $('#btn-unread').addEventListener('click', () => {
    if (state.scope.type === 'unread') return;
    state.unreadOnly = !state.unreadOnly;
    $('#btn-unread').classList.toggle('active', state.unreadOnly);
    $('#listTitle').textContent = scopeTitle();
    loadItems();
  });

  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    loadItems();
  });

  $('#viewswitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    localStorage.setItem('fn.view', state.view);
    $$('#viewswitch button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
    renderItems();
  });

  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value.trim();
    searchTimer = setTimeout(() => {
      state.q = value;
      loadItems();
    }, 260);
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'import') openImportDialog();
    if (btn.dataset.action === 'add-feed') openAddFeedDialog();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || $('#modal-root').children.length) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const index = state.items.findIndex((i) => i.id === (state.current && state.current.id));
    switch (e.key.toLowerCase()) {
      case 'j':
        if (index < state.items.length - 1) openItem(state.items[index + 1].id);
        break;
      case 'k':
        if (index > 0) openItem(state.items[index - 1].id);
        else if (index === -1 && state.items.length) openItem(state.items[0].id);
        break;
      case 'm':
        if (state.current) {
          const next = !state.current.read;
          markItemRead(state.current.id, next);
          state.current.read = next;
        }
        break;
      case 's':
        toggleStar();
        break;
      case 'r':
        startRefresh('all');
        break;
      case 'u':
        $('#btn-unread').click();
        break;
      case '/':
        e.preventDefault();
        $('#search').focus();
        break;
      case 'escape':
        if (state.q) {
          $('#search').value = '';
          state.q = '';
          loadItems();
        }
        closeReader();
        break;
      default:
        break;
    }
  });

  window.addEventListener('resize', () => {
    const frame = $('#reader-frame');
    if (frame) {
      try {
        const h = Math.max(frame.contentDocument.documentElement.scrollHeight, frame.contentDocument.body.scrollHeight);
        frame.style.height = h + 'px';
      } catch {
        /* ignore */
      }
    }
  });
}

function toggleFolder(id, force) {
  const el = $(`.tree-folder[data-folder="${id}"]`);
  const collapsed = force === undefined ? !state.collapsed.has(id) : !force ? true : false;
  if (collapsed) state.collapsed.add(id);
  else state.collapsed.delete(id);
  if (el) {
    el.classList.toggle('collapsed', collapsed);
    el.querySelector('.tree-children').classList.toggle('hidden', collapsed);
  }
  localStorage.setItem('fn.collapsed', JSON.stringify([...state.collapsed]));
}

/* ======================= 初始化 ======================= */

async function loadState() {
  const data = await api('/api/state');
  state.user = data.user || state.user;
  state.folders = data.folders;
  state.feeds = data.feeds;
  state.folderUnread = data.folderUnread;
  state.counts = data.counts;
  state.settings = data.settings;
  state.proxy = data.proxy;
  state.version = data.version;
  state.progress = data.progress;
  renderUserChip();
  renderSidebar();
  setProgressUI(data.progress);
  if (data.progress && data.progress.running) pollProgress();
}

/* ======================= 账号与登录 ======================= */

function showLogin(message = '') {
  state.user = null;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  $('#app').hidden = true;
  $('#login-screen').hidden = false;
  const err = $('#login-error');
  if (message) {
    err.hidden = false;
    err.textContent = message;
  } else {
    err.hidden = true;
  }
  $('#usermenu').classList.remove('open');
  setTimeout(() => $('#login-user').focus(), 80);
}

function showApp() {
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  renderUserChip();
}

function renderUserChip() {
  const user = state.user;
  if (!user) return;
  const letter = (user.username || '?').charAt(0).toUpperCase();
  const avatar = $('#user-avatar');
  avatar.textContent = letter;
  avatar.style.background = avatarColor(user.username);
  $('#user-name').textContent = user.username;
  $('#dd-name').textContent = user.username;
  $('#dd-role').textContent = user.role === 'admin' ? '管理员' : '普通用户';
  $('#dd-users').hidden = user.role !== 'admin';
  $('#pw-banner').hidden = !user.isDefaultPassword;
}

function closeUserMenu() {
  $('#usermenu').classList.remove('open');
}

async function doLogout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* 忽略 */
  }
  state.user = null;
  state.items = [];
  state.total = 0;
  state.current = null;
  state.selectedId = null;
  $('#items').innerHTML = '';
  $('#tree').innerHTML = '';
  renderReaderEmpty();
  showLogin('已退出登录');
}

function openPasswordDialog() {
  modal({
    title: '修改密码',
    body: `
      <div class="field"><label>当前密码</label><input class="input" id="pw-cur" type="password" autocomplete="current-password"></div>
      <div class="field"><label>新密码</label><input class="input" id="pw-new" type="password" autocomplete="new-password">
        <div class="hint">至少 4 位，修改后需要重新登录</div></div>
      <div class="field"><label>确认新密码</label><input class="input" id="pw-new2" type="password" autocomplete="new-password"></div>`,
    footer: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="btn-save-pw">保存</button>`,
    onMount: ({ el, close }) => {
      setTimeout(() => $('#pw-cur', el).focus(), 60);
      const save = async () => {
        const cur = $('#pw-cur', el).value;
        const next = $('#pw-new', el).value;
        const next2 = $('#pw-new2', el).value;
        if (!cur) return toast('请输入当前密码', 'error');
        if (next.length < 4) return toast('新密码至少 4 位', 'error');
        if (next !== next2) return toast('两次输入的新密码不一致', 'error');
        try {
          await api('/api/auth/password', { method: 'POST', body: { currentPassword: cur, newPassword: next } });
          close();
          showLogin('密码已修改，请使用新密码重新登录');
          toast('密码已修改', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      $('#btn-save-pw', el).addEventListener('click', save);
      $$('#pw-cur, #pw-new, #pw-new2', el).forEach((input) =>
        input.addEventListener('keydown', (e) => e.key === 'Enter' && save())
      );
    },
  });
}

const USER_ICONS = {
  reset: '<path d="M15 7a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/><path d="m18 13 3 3-3 3"/><path d="M12 11H7a3 3 0 0 0 0 6h1"/>',
  role: '<path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z"/>',
  toggle: '<path d="M12 3v9"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>',
  del: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>',
};

function userRowHtml(u, me) {
  const isSelf = u.id === me.id;
  return `<div class="user-row">
    ${avatarHtml(u.username, null, 22)}
    <div style="min-width:0">
      <div class="uname">${esc(u.username)}${isSelf ? '<span class="umeta"> · 当前账号</span>' : ''}</div>
      <div class="umeta">${u.feedCount} 个订阅 · ${u.lastLoginAt ? '上次登录 ' + timeAgo(u.lastLoginAt) : '从未登录'}</div>
    </div>
    <span class="role-badge ${u.role === 'admin' ? 'admin' : ''}">${u.role === 'admin' ? '管理员' : '普通用户'}</span>
    ${u.disabled ? '<span class="role-badge off">已禁用</span>' : ''}
    <div class="acts">
      <button class="mini-btn" data-act="reset" data-id="${u.id}" title="重置密码">
        <svg viewBox="0 0 24 24" class="ic">${USER_ICONS.reset}</svg>
      </button>
      <button class="mini-btn" data-act="role" data-id="${u.id}" title="${u.role === 'admin' ? '降为普通用户' : '设为管理员'}">
        <svg viewBox="0 0 24 24" class="ic">${USER_ICONS.role}</svg>
      </button>
      <button class="mini-btn" data-act="toggle" data-id="${u.id}" title="${u.disabled ? '启用账号' : '禁用账号'}">
        <svg viewBox="0 0 24 24" class="ic">${USER_ICONS.toggle}</svg>
      </button>
      ${isSelf ? '' : `<button class="mini-btn" data-act="del" data-id="${u.id}" title="删除账号">
        <svg viewBox="0 0 24 24" class="ic">${USER_ICONS.del}</svg>
      </button>`}
    </div>
  </div>`;
}

async function openUsersDialog() {
  const me = state.user;
  modal({
    title: '用户管理',
    wide: true,
    body: `
      <div class="add-user">
        <input class="input" id="nu-name" placeholder="用户名" spellcheck="false">
        <input class="input" id="nu-pass" type="password" placeholder="初始密码">
        <select class="select" id="nu-role">
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
        <button class="btn primary" id="nu-add">新增</button>
      </div>
      <div class="hint" style="color:var(--muted);font-size:11.5px;margin-bottom:4px">
        每个账号的订阅、文件夹、已读与收藏完全独立，互相不可见。只有管理员能管理账号。
      </div>
      <div class="user-table" id="user-table"></div>`,
    footer: `<button class="btn ghost" data-close>关闭</button>`,
    onMount: ({ el }) => {
      const table = $('#user-table', el);

      const render = async () => {
        const data = await api('/api/users');
        table.innerHTML = data.users.map((u) => userRowHtml(u, me)).join('');
      };

      const add = async () => {
        const username = $('#nu-name', el).value.trim();
        const password = $('#nu-pass', el).value;
        const role = $('#nu-role', el).value;
        if (!username) return toast('请输入用户名', 'error');
        if (password.length < 4) return toast('初始密码至少 4 位', 'error');
        try {
          await api('/api/users', { method: 'POST', body: { username, password, role } });
          $('#nu-name', el).value = '';
          $('#nu-pass', el).value = '';
          toast(`已创建用户 ${username}`, 'success');
          await render();
        } catch (err) {
          toast(err.message, 'error');
        }
      };

      $('#nu-add', el).addEventListener('click', add);
      $$('#nu-name, #nu-pass', el).forEach((input) =>
        input.addEventListener('keydown', (e) => e.key === 'Enter' && add())
      );

      table.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        const target = (await api('/api/users')).users.find((u) => u.id === id);
        if (!target) return;

        if (act === 'reset') {
          openResetPassword(target, () => openUsersDialog());
          return;
        }
        if (act === 'role') {
          try {
            await api('/api/users/' + id, {
              method: 'PATCH',
              body: { role: target.role === 'admin' ? 'user' : 'admin' },
            });
            toast(target.role === 'admin' ? '已降为普通用户' : '已设为管理员', 'success');
            await render();
          } catch (err) {
            toast(err.message, 'error');
          }
          return;
        }
        if (act === 'toggle') {
          try {
            await api('/api/users/' + id, { method: 'PATCH', body: { disabled: !target.disabled } });
            toast(target.disabled ? '账号已启用' : '账号已禁用', 'success');
            await render();
          } catch (err) {
            toast(err.message, 'error');
          }
          return;
        }
        if (act === 'del') {
          openConfirm({
            title: '删除账号',
            message: `确定删除用户「${esc(target.username)}」吗？该账号的 ${target.feedCount} 个订阅和全部文章会一起删除，无法恢复。`,
            onConfirm: async () => {
              await api('/api/users/' + id, { method: 'DELETE' });
              toast('账号已删除', 'success');
              openUsersDialog();
            },
          });
        }
      });

      render().catch((err) => toast(err.message, 'error'));
    },
  });
}

function openResetPassword(user, onDone) {
  modal({
    title: `重置「${user.username}」的密码`,
    body: `<div class="field"><label>新密码</label>
      <input class="input" id="rp-pass" type="password" autocomplete="new-password">
      <div class="hint">至少 4 位；重置后该用户的所有登录会话会失效</div></div>`,
    footer: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="rp-save">重置密码</button>`,
    onMount: ({ el, close }) => {
      setTimeout(() => $('#rp-pass', el).focus(), 60);
      const save = async () => {
        const pass = $('#rp-pass', el).value;
        if (pass.length < 4) return toast('密码至少 4 位', 'error');
        try {
          await api('/api/users/' + user.id, { method: 'PATCH', body: { password: pass } });
          close();
          toast('密码已重置', 'success');
          onDone && onDone();
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      $('#rp-save', el).addEventListener('click', save);
      $('#rp-pass', el).addEventListener('keydown', (e) => e.key === 'Enter' && save());
    },
  });
}

/** 打开页面时补刷已到期的订阅（Workers/Pages 没有常驻定时器，靠这一步兜底） */
async function kickDueRefresh() {
  try {
    await startRefresh('due', { silent: true });
  } catch {
    /* 静默失败，不影响阅读 */
  }
}

async function boot() {
  applyTheme();
  renderReaderEmpty();
  $$('#viewswitch button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  bindEvents();
  try {
    const me = await api('/api/auth/me');
    if (!me.user) {
      showLogin();
      return;
    }
    state.user = me.user;
    showApp();
    await loadState();
    await loadItems();
    kickDueRefresh();
  } catch {
    showLogin();
  }
}

boot();
