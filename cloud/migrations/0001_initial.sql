-- 0001_initial.sql
-- 所有时间字段均为 INTEGER Unix 秒（UTC）

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id, status);

CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT REFERENCES devices(id) ON DELETE SET NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  rotated_from TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS submarines (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id     TEXT NOT NULL,
  character_name   TEXT NOT NULL DEFAULT '',
  world_id         INTEGER,
  slot_index       INTEGER NOT NULL,
  submarine_name   TEXT NOT NULL DEFAULT '',
  state            TEXT NOT NULL DEFAULT 'unknown',
  return_at        INTEGER NOT NULL DEFAULT 0,
  rank             INTEGER NOT NULL DEFAULT 0,
  route_points     TEXT NOT NULL DEFAULT '[]',
  parts            TEXT NOT NULL DEFAULT '{}',
  collected_at     INTEGER NOT NULL DEFAULT 0,
  last_uploaded_at INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  UNIQUE(user_id, character_id, slot_index)
);
CREATE INDEX IF NOT EXISTS idx_subs_user_char ON submarines(user_id, character_id, active);
CREATE INDEX IF NOT EXISTS idx_subs_return ON submarines(user_id, active, return_at);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id                      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  merge_window_minutes         INTEGER NOT NULL DEFAULT 10,
  advance_notification_minutes INTEGER NOT NULL DEFAULT 5,
  notification_enabled         INTEGER NOT NULL DEFAULT 1,
  provider                     TEXT NOT NULL DEFAULT 'bark',
  provider_server_url          TEXT NOT NULL DEFAULT '',
  provider_token_enc           TEXT NOT NULL DEFAULT '',
  provider_topic               TEXT NOT NULL DEFAULT '',
  notify_title                 TEXT NOT NULL DEFAULT '潜水艇返航',
  notify_body_template         TEXT NOT NULL DEFAULT '',
  notify_group                 TEXT NOT NULL DEFAULT 'FF14',
  notify_sound                 TEXT NOT NULL DEFAULT '',
  notify_icon                  TEXT NOT NULL DEFAULT '',
  notify_priority              TEXT NOT NULL DEFAULT 'default',
  timezone                     TEXT NOT NULL DEFAULT 'UTC',
  updated_at                   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notification_batches (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anchor_return_at INTEGER NOT NULL,
  latest_return_at INTEGER NOT NULL,
  notify_at        INTEGER NOT NULL,
  advance_notify_at INTEGER,
  status           TEXT NOT NULL DEFAULT 'pending',
  advanced_sent_at INTEGER,
  sent_at          INTEGER,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  next_retry_at    INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_due ON notification_batches(user_id, status, notify_at);
CREATE INDEX IF NOT EXISTS idx_batches_advance ON notification_batches(user_id, status, advance_notify_at);

CREATE TABLE IF NOT EXISTS notification_batch_items (
  batch_id     TEXT NOT NULL REFERENCES notification_batches(id) ON DELETE CASCADE,
  submarine_id TEXT NOT NULL REFERENCES submarines(id) ON DELETE CASCADE,
  return_at    INTEGER NOT NULL,
  PRIMARY KEY (batch_id, submarine_id)
);
CREATE INDEX IF NOT EXISTS idx_items_sub ON notification_batch_items(submarine_id);

CREATE TABLE IF NOT EXISTS notification_logs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id      TEXT,
  event_type    TEXT NOT NULL,
  event_key     TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT '',
  attempts      INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_user ON notification_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rl_expires ON rate_limits(expires_at);

CREATE TABLE IF NOT EXISTS sync_dedup (
  hash       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedup_created ON sync_dedup(created_at);
