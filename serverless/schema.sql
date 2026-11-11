-- FeedNest · Cloudflare D1 结构
-- 用法：
--   npx wrangler d1 execute feednest-db --remote --file=./serverless/schema.sql -c wrangler.worker.jsonc

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE,
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
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);

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
CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_feeds_folder ON feeds(folder_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_user_url ON feeds(user_id, url);

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
