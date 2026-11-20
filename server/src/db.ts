import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.js';
import { logger } from './util/log.js';
import { ratingLevel } from './util/misc.js';

const log = logger('db');

export type Row = Record<string, any>;
export type Param = SQLInputValue | boolean | undefined;

class Database {
  readonly raw: DatabaseSync;
  private stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  private stmt(sql: string) {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private norm(params: Param[]): SQLInputValue[] {
    return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...this.norm(params)) as T[];
  }
  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...this.norm(params)) as T | undefined;
  }
  run(sql: string, ...params: Param[]) {
    return this.stmt(sql).run(...this.norm(params));
  }
  exec(sql: string) {
    this.raw.exec(sql);
  }
  /** Run fn inside a transaction (nesting-safe via savepoints). */
  private depth = 0;
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth++}`;
    this.raw.exec(`SAVEPOINT ${sp}`);
    try {
      const r = fn();
      this.raw.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
  /** Insert or replace a row from an object. */
  upsert(table: string, row: Row, conflict = 'id') {
    const cols = Object.keys(row);
    const updates = cols.filter((c) => !conflict.split(',').includes(c)).map((c) => `${c}=excluded.${c}`);
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
      ON CONFLICT(${conflict}) DO ${updates.length ? 'UPDATE SET ' + updates.join(',') : 'NOTHING'}`;
    return this.run(sql, ...cols.map((c) => row[c]));
  }
  insert(table: string, row: Row) {
    const cols = Object.keys(row);
    return this.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c]));
  }
  update(table: string, id: string, patch: Row) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    return this.run(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`, ...cols.map((c) => patch[c]), id);
  }
}

const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
    password_hash TEXT, pin_hash TEXT, is_admin INTEGER NOT NULL DEFAULT 0, avatar TEXT,
    max_rating TEXT, library_ids TEXT, allow_live_tv INTEGER NOT NULL DEFAULT 1,
    allow_downloads INTEGER NOT NULL DEFAULT 1, allow_transcode INTEGER NOT NULL DEFAULT 1,
    allow_dvr INTEGER NOT NULL DEFAULT 1, disabled INTEGER NOT NULL DEFAULT 0,
    preferences TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, last_seen_at TEXT
  );

  CREATE TABLE devices (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL, device_name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT,
    remote_addr TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
  );
  CREATE INDEX devices_user ON devices(user_id);

  CREATE TABLE libraries (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, paths TEXT NOT NULL DEFAULT '[]',
    source_id TEXT, fetch_metadata INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
    last_scan_at TEXT, created_at TEXT NOT NULL
  );

  CREATE TABLE items (
    id TEXT PRIMARY KEY, library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE, type TEXT NOT NULL,
    title TEXT NOT NULL, sort_title TEXT NOT NULL, original_title TEXT, year INTEGER, overview TEXT, tagline TEXT,
    community_rating REAL, content_rating TEXT, duration_ms INTEGER, genres TEXT NOT NULL DEFAULT '[]',
    studios TEXT NOT NULL DEFAULT '[]', people TEXT NOT NULL DEFAULT '[]',
    poster TEXT, backdrop TEXT, logo TEXT, thumb TEXT,
    parent_id TEXT, grandparent_id TEXT, idx INTEGER, parent_idx INTEGER,
    added_at TEXT NOT NULL, release_date TEXT, external_ids TEXT NOT NULL DEFAULT '{}',
    path TEXT, remote_ref TEXT, owner_id TEXT, locked_fields TEXT NOT NULL DEFAULT '[]',
    markers TEXT NOT NULL DEFAULT '[]', trailer_url TEXT, extra TEXT NOT NULL DEFAULT '{}',
    metadata_fetched_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE INDEX items_library ON items(library_id, type);
  CREATE INDEX items_parent ON items(parent_id, idx);
  CREATE INDEX items_grandparent ON items(grandparent_id);
  CREATE INDEX items_added ON items(added_at);
  CREATE INDEX items_sort ON items(sort_title);
  CREATE INDEX items_path ON items(path);
  CREATE INDEX items_remote ON items(library_id, remote_ref);

  CREATE TABLE media (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    path TEXT, remote_url TEXT, container TEXT, duration_ms INTEGER, size INTEGER, bitrate INTEGER,
    width INTEGER, height INTEGER, video_codec TEXT, hdr INTEGER NOT NULL DEFAULT 0,
    audio TEXT NOT NULL DEFAULT '[]', subs TEXT NOT NULL DEFAULT '[]', mtime INTEGER, probed_at TEXT
  );
  CREATE INDEX media_item ON media(item_id);
  CREATE UNIQUE INDEX media_path ON media(path) WHERE path IS NOT NULL;

  CREATE TABLE user_data (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    played INTEGER NOT NULL DEFAULT 0, play_count INTEGER NOT NULL DEFAULT 0, position_ms INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0, last_played_at TEXT, rating REAL,
    PRIMARY KEY (user_id, item_id)
  );
  CREATE INDEX user_data_recent ON user_data(user_id, last_played_at);

  CREATE TABLE collection_items (
    collection_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    sort INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (collection_id, item_id)
  );

  CREATE TABLE images (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, cached TEXT, created_at TEXT NOT NULL
  );

  CREATE TABLE live_sources (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, url TEXT NOT NULL, username TEXT, password TEXT,
    epg_url TEXT, enabled INTEGER NOT NULL DEFAULT 1, proxy_streams INTEGER NOT NULL DEFAULT 1,
    import_vod INTEGER NOT NULL DEFAULT 1, import_series INTEGER NOT NULL DEFAULT 1, user_agent TEXT,
    refresh_hours INTEGER NOT NULL DEFAULT 12, max_connections INTEGER, last_refresh_at TEXT, last_error TEXT,
    account_info TEXT, created_at TEXT NOT NULL
  );

  CREATE TABLE channel_categories (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES live_sources(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'live', name TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX channel_categories_source ON channel_categories(source_id, kind);

  CREATE TABLE channels (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES live_sources(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL, number REAL, name TEXT NOT NULL, logo TEXT, category_id TEXT,
    stream_url TEXT NOT NULL, has_archive INTEGER NOT NULL DEFAULT 0, archive_days INTEGER NOT NULL DEFAULT 0,
    epg_channel_id TEXT, hidden INTEGER NOT NULL DEFAULT 0, custom TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX channels_source ON channels(source_id);
  CREATE INDEX channels_category ON channels(category_id);
  CREATE INDEX channels_epg ON channels(epg_channel_id);

  CREATE TABLE channel_favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, channel_id)
  );

  CREATE TABLE programs (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, epg_channel_id TEXT NOT NULL,
    title TEXT NOT NULL, subtitle TEXT, description TEXT, start TEXT NOT NULL, end TEXT NOT NULL,
    category TEXT, icon TEXT, episode_num TEXT, is_new INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX programs_channel ON programs(epg_channel_id, start);
  CREATE INDEX programs_end ON programs(end);
  CREATE INDEX programs_title ON programs(title);

  CREATE TABLE recordings (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, program_id TEXT,
    title TEXT NOT NULL, description TEXT, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL,
    item_id TEXT, rule_id TEXT, error TEXT, size_bytes INTEGER, path TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX recordings_status ON recordings(status, start);

  CREATE TABLE recording_rules (
    id TEXT PRIMARY KEY, title_match TEXT NOT NULL, channel_id TEXT, new_only INTEGER NOT NULL DEFAULT 0,
    keep_latest INTEGER, padding_before INTEGER NOT NULL DEFAULT 1, padding_after INTEGER NOT NULL DEFAULT 5,
    enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL
  );

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, user_name TEXT,
    type TEXT NOT NULL, message TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info'
  );
  CREATE INDEX activity_at ON activity(at);

  CREATE TABLE play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item_id TEXT, channel_id TEXT,
    started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, method TEXT, platform TEXT
  );
  CREATE INDEX play_history_user ON play_history(user_id, started_at);
  `,
  /* 2: PIN length for PIN pads */ `
  ALTER TABLE users ADD COLUMN pin_length INTEGER;
  `,
  /* 3: Trakt accounts */ `
  CREATE TABLE trakt_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at TEXT NOT NULL,
    username TEXT, scrobble INTEGER NOT NULL DEFAULT 1
  );
  `,
  /* 4: SSO identities, podcasts, chapters */ `
  ALTER TABLE users ADD COLUMN oidc_sub TEXT;
  CREATE UNIQUE INDEX users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;
  ALTER TABLE media ADD COLUMN chapters TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE podcast_feeds (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, feed_url TEXT NOT NULL UNIQUE,
    auto_download INTEGER NOT NULL DEFAULT 0, etag TEXT, last_refresh_at TEXT, last_error TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
  );
  `,
  /* 5: Last.fm accounts */ `
  CREATE TABLE lastfm_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, session_key TEXT, username TEXT,
    pending_token TEXT, scrobble INTEGER NOT NULL DEFAULT 1
  );
  `,
  /* 6: mark images that came from untrusted feeds */ `
  ALTER TABLE images ADD COLUMN untrusted INTEGER NOT NULL DEFAULT 0;
  `,
  /* 7: media requests and smart lists */ `
  CREATE TABLE media_requests (
    id TEXT PRIMARY KEY, tmdb_id TEXT NOT NULL, media_type TEXT NOT NULL, title TEXT NOT NULL, year INTEGER, poster TEXT,
    seasons TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, note TEXT, item_id TEXT, error TEXT
  );
  CREATE INDEX media_requests_tmdb ON media_requests(media_type, tmdb_id);
  CREATE INDEX media_requests_status ON media_requests(status);
  ALTER TABLE items ADD COLUMN smart TEXT;
  `,
  /* 8: API keys, two-factor, invites, per-user limits, bookmarks */ `
  ALTER TABLE users ADD COLUMN allow_remote INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE users ADD COLUMN max_streams INTEGER;
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN recovery_codes TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
  );
  CREATE TABLE invites (
    code TEXT PRIMARY KEY, note TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT,
    max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, template TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, position_ms INTEGER NOT NULL, note TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX bookmarks_user_item ON bookmarks(user_id, item_id);
  `,
  /* 9: movie editions */ `
  ALTER TABLE media ADD COLUMN edition TEXT;
  `,
  /* 10: DVR priorities, conflicts and rule constraints */ `
  ALTER TABLE recordings ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;
  ALTER TABLE recordings ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE recording_rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;
  ALTER TABLE recording_rules ADD COLUMN days TEXT;
  ALTER TABLE recording_rules ADD COLUMN time_from TEXT;
  ALTER TABLE recording_rules ADD COLUMN time_to TEXT;
  ALTER TABLE recording_rules ADD COLUMN skip_repeats INTEGER NOT NULL DEFAULT 1;
  `,
  /* 11: DJ mode track analysis */ `
  CREATE TABLE track_analysis (
    item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    media_mtime INTEGER, version INTEGER NOT NULL,
    bpm REAL, bpm_confidence REAL NOT NULL DEFAULT 0, beat_offset_ms INTEGER, key_name TEXT, camelot TEXT, energy REAL NOT NULL DEFAULT 0, loudness_db REAL,
    cue_in_ms INTEGER NOT NULL DEFAULT 0, cue_out_ms INTEGER NOT NULL DEFAULT 0, intro_end_ms INTEGER, outro_start_ms INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0, analyzed_at TEXT NOT NULL, error TEXT
  );
  CREATE INDEX track_analysis_bpm ON track_analysis(bpm);
  CREATE INDEX track_analysis_camelot ON track_analysis(camelot);
  `,
  /* 12: AI DJ — timbre fingerprints and listener feedback */ `
  ALTER TABLE track_analysis ADD COLUMN timbre TEXT;
  CREATE TABLE dj_feedback (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, at TEXT NOT NULL
  );
  CREATE INDEX dj_feedback_user ON dj_feedback(user_id, at);
  `,
];

function migrate(db: Database) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.get<{ version: number }>('SELECT version FROM schema_version');
  let version = row?.version ?? 0;
  if (!row) db.run('INSERT INTO schema_version (version) VALUES (0)');
  while (version < MIGRATIONS.length) {
    log.info(`Applying migration ${version + 1}`);
    db.tx(() => {
      db.exec(MIGRATIONS[version]);
      db.run('UPDATE schema_version SET version = ?', version + 1);
    });
    version++;
  }
}

export const db = new Database(process.env.MEDIAMAX_DB ?? config.dbPath);
// SQL helper used by parental-control filters.
const levelCache = new Map<string, number | null>();
const cachedLevel = (r: unknown): number | null => {
  if (r == null) return null;
  const k = String(r);
  let v = levelCache.get(k);
  if (v === undefined) {
    v = ratingLevel(k);
    if (levelCache.size < 5000) levelCache.set(k, v);
  }
  return v;
};
db.raw.function('mm_rating_level', { deterministic: true }, (r: unknown) => cachedLevel(r));
/** 1 if a rating is allowed for a max age: known ratings compare by age; unrated/unknown use `unratedOk`. */
db.raw.function('mm_rating_ok', { deterministic: true }, (r: unknown, max: unknown, unratedOk: unknown) => {
  const lvl = cachedLevel(r);
  if (lvl === null || lvl < 0) return Number(unratedOk) ? 1 : 0;
  return lvl <= Number(max) ? 1 : 0;
});
migrate(db);
