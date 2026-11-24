import crypto from 'node:crypto';
import type { ImportConfig, ImportJob, ImportOptions, ImportPreview, ImportPreviewUser, ImportSource, ImportTestResult, ImportUserResult, User } from '@mediamax/shared';
import { db } from '../../db.js';
import { badRequest, conflict } from '../../util/errors.js';
import { nowIso } from '../../util/misc.js';
import { logger } from '../../util/log.js';
import { getKv, setKv } from '../settings.js';
import { createUserHashed, hashUserSecrets, updateUser } from '../auth.js';
import { createPasswordLink, passwordLinkUrl, passwordLinkUsed } from '../passwordLinks.js';
import { logActivity } from '../activity.js';
import { events } from '../events.js';
import {
  type Conn, type Driver, type Entry, type Haul, type MappedUser, type SourceUser, type Want,
  addCount, applyFavorite, applyHistory, applyResume, applyWatched, connection, emptyCount, existingUserId, freeUsername, isSource, label,
  linkPurpose, localLibraries, mapFolders, Matcher, pool, setMap, SOURCE_LABEL, storedConfig, sumCounts, uniqIds, upsertContainer,
} from './common.js';
import { embyDriver } from './emby.js';
import { plexDriver } from './plex.js';
import { importMetadata } from './metadata.js';

/**
 * Import from another server (Admin → Import from another server): Emby, Jellyfin or Plex users, their permissions and
 * watch data. Source passwords can't be read, so each new account gets a random password nobody knows plus a one-time
 * set-password link. Re-running is safe: users are recognised by an id map (or username), watch data is only ever
 * upgraded (never un-watched, play counts never go down), playlists/collections are topped up rather than duplicated,
 * history rows aren't added twice. One import runs at a time, in the background, with progress events.
 */

const log = logger('server-import');
const JOB_KEY = 'import:lastJob';
const LEGACY_JOB_KEY = 'embyImport:lastJob';
/** Users read at once (each user's lists are fetched in sequence; a few users in parallel). */
const USER_CONCURRENCY = 4;

const DRIVERS: Record<ImportSource, Driver> = { emby: embyDriver('emby'), jellyfin: embyDriver('jellyfin'), plex: plexDriver };

export function sourceOf(raw: unknown): ImportSource {
  if (!isSource(raw)) throw badRequest('Unknown import source (emby, jellyfin or plex)');
  return raw;
}

export { getImportConfig, saveImportConfig } from './common.js';

export function testConnection(s: ImportSource, override: Partial<Pick<ImportConfig, 'url' | 'apiKey'>> = {}): Promise<ImportTestResult> {
  try {
    return DRIVERS[s].test(connection(s, override));
  } catch (e) {
    return Promise.resolve({ ok: false, message: (e as Error).message });
  }
}

const want = (o: ImportOptions): Want => ({
  watched: o.importWatched !== false, resume: o.importResume !== false, favorites: o.importFavorites !== false, playlists: o.importPlaylists !== false, history: o.importHistory !== false,
});

function actionFor(existing: string | null, mapped: MappedUser, o: ImportOptions): ImportPreviewUser['action'] {
  if (!existing) return mapped.disabled && o.includeDisabled === false ? 'skip' : 'create';
  if (o.updateExisting) return 'update';
  return o.mergeExisting !== false ? 'merge' : 'skip';
}

/* --------------------------------- preview -------------------------------- */

/**
 * Dry run. A full preview reads and matches every title; `quick` only asks the source for counts (fast on huge
 * servers, no match breakdown).
 */
export async function previewImport(s: ImportSource, o: ImportOptions = {}, quick = false): Promise<ImportPreview> {
  const t0 = Date.now();
  const c = connection(s);
  const mappings = storedConfig(s).pathMappings;
  const w = want(o);
  const matcher = quick ? null : new Matcher(mappings);
  const session = await DRIVERS[s].open(c, matcher, w);
  const libs = mapFolders(session.folders, mappings);
  const users = session.users(libs);
  const libName = new Map(localLibraries().map((l) => [l.id, l.name]));
  if (!quick) await session.prepare?.(() => undefined);
  const samples = new Set<string>();
  const sample = (list: { item: Entry['item']; m: Entry['m'] }[]) => {
    for (const x of list) if (!x.m && samples.size < 40) samples.add(label(x.item));
  };
  const count = (list: { item: Entry['item']; m: Entry['m'] }[]) => {
    const n = emptyCount();
    list.forEach((x) => addCount(n, x.m));
    sample(list);
    return n;
  };
  const total = (n: number) => ({ ...emptyCount(), total: n });
  const out: ImportPreviewUser[] = new Array(users.length);
  await pool(users, USER_CONCURRENCY, async (u, i) => {
    const mapped = u.mapped;
    const existing = existingUserId(s, u);
    const action = actionFor(existing, mapped, o);
    const base = {
      sourceId: u.id, username: mapped.username, renamedFrom: mapped.username !== u.name ? u.name : null, displayName: mapped.displayName ?? mapped.username,
      isAdmin: !!mapped.isAdmin, disabled: mapped.disabled, hidden: mapped.hiddenFromLogin, allowRemote: mapped.allowRemote !== false,
      allowLiveTv: mapped.allowLiveTv !== false, allowDownloads: mapped.allowDownloads !== false, maxStreams: mapped.maxStreams ?? null,
      maxContentRating: mapped.maxContentRating ?? null, libraries: mapped.libraryIds ? mapped.libraryIds.map((id) => libName.get(id) ?? id) : null,
      unmappedFolders: mapped.unmappedFolders, lastActivity: u.lastActivity, action, existingUserId: existing,
    };
    if (action === 'skip') {
      out[i] = { ...base, watched: emptyCount(), resume: emptyCount(), favorites: emptyCount(), playlists: 0, playlistItems: emptyCount(), history: emptyCount(), notes: mapped.notes ?? [] };
    } else if (quick) {
      const n = await session.countUser(u, w);
      out[i] = {
        ...base, watched: total(n.watched), resume: total(n.resume), favorites: total(n.favorites), playlists: n.playlists, playlistItems: emptyCount(),
        history: total(n.history), notes: [...(mapped.notes ?? []), ...n.notes],
      };
    } else {
      const h = await session.collectUser(u, w);
      out[i] = {
        ...base, watched: count(h.watched), resume: count(h.resume), favorites: count(h.favorites), playlists: h.playlists.length,
        playlistItems: count(h.playlists.flatMap((p) => p.items)), history: count(h.history), notes: [...(mapped.notes ?? []), ...h.notes],
      };
    }
  });
  let collections = 0;
  const colCount = emptyCount();
  if (o.importCollections !== false) {
    if (quick) collections = await session.countCollections();
    else {
      const cols = await session.collections();
      collections = cols.length;
      for (const col of cols) {
        col.items.forEach((x) => addCount(colCount, x.m));
        sample(col.items);
      }
    }
  }
  const by = (a: ImportPreviewUser['action']) => out.filter((u) => u.action === a).length;
  const sum = (k: 'watched' | 'resume' | 'favorites' | 'history') => out.reduce((a, u) => sumCounts(a, u[k]), emptyCount());
  return {
    source: s,
    quick,
    server: session.server,
    libraries: libs,
    users: out,
    collections,
    collectionItems: colCount,
    totals: { users: out.length, create: by('create'), update: by('update'), merge: by('merge'), skip: by('skip'), watched: sum('watched'), resume: sum('resume'), favorites: sum('favorites'), history: sum('history') },
    unmatchedSamples: [...samples],
    notes: session.notes,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
}

/* ---------------------------------- jobs ---------------------------------- */

let current: ImportJob | null = null;
let lastEmit = 0;

export function getJob(): ImportJob | null {
  if (current) return current;
  const job = getKv<ImportJob | null>(JOB_KEY, null) ?? getKv<ImportJob | null>(LEGACY_JOB_KEY, null);
  if (!job) return null;
  // Jobs saved by the Emby-only importer.
  return { ...job, source: job.source ?? 'emby', notes: job.notes ?? [], results: (job.results ?? []).map((r) => ({ ...r, sourceId: r.sourceId ?? (r as unknown as { embyId: string }).embyId, history: r.history ?? 0 })) };
}

function emit(force = false) {
  if (!current) return;
  if (!force && Date.now() - lastEmit < 1000) return;
  lastEmit = Date.now();
  events.toAdmins({ type: 'import.updated', job: current });
  if (current.source === 'emby') events.toAdmins({ type: 'embyImport.updated', job: current });
}

function cleanOptions(o: ImportOptions): ImportOptions {
  return {
    userIds: Array.isArray(o.userIds) ? o.userIds.map(String).slice(0, 10000) : null,
    updateExisting: !!o.updateExisting,
    mergeExisting: o.mergeExisting !== false,
    includeDisabled: o.includeDisabled !== false,
    importWatched: o.importWatched !== false,
    importResume: o.importResume !== false,
    importFavorites: o.importFavorites !== false,
    importPlaylists: o.importPlaylists !== false,
    importCollections: o.importCollections !== false,
    importHistory: o.importHistory !== false,
    importMetadata: !!o.importMetadata,
    overwriteMetadata: !!o.importMetadata && !!o.overwriteMetadata,
    linkExpiryDays: Math.max(1, Math.min(365, Math.round(Number(o.linkExpiryDays) || 30))),
  };
}

/** Start an import in the background. Progress goes to admins as `import.updated` events; GET the job to poll. */
export function startImport(s: ImportSource, admin: User, options: ImportOptions, origin: string): ImportJob {
  if (current?.status === 'running') throw conflict(`An import from ${SOURCE_LABEL[current.source]} is already running`);
  const c = connection(s);
  const o = cleanOptions(options ?? {});
  const L = SOURCE_LABEL[s];
  const job: ImportJob = {
    id: crypto.randomBytes(6).toString('hex'), source: s, status: 'running', phase: `Connecting to ${L}`, progress: 0, startedAt: nowIso(), finishedAt: null,
    error: null, options: o, results: [], collections: { created: 0, updated: 0, items: 0 }, metadata: null, notes: [],
  };
  current = job;
  logActivity(`${s}.import`, `${L} import started`, { userId: admin.id, userName: admin.displayName });
  emit(true);
  void runImport(c, admin, job, origin)
    .catch((e) => {
      log.error(`${L} import failed`, e);
      job.status = 'error';
      job.error = (e as Error).message;
      logActivity(`${s}.import`, `${L} import failed: ${job.error}`, { userId: admin.id, userName: admin.displayName, severity: 'error' });
    })
    .finally(() => {
      job.finishedAt = nowIso();
      if (job.status === 'running') job.status = 'done';
      job.phase = job.status === 'done' ? 'Finished' : 'Failed';
      if (job.status === 'done') job.progress = 100;
      setKv(JOB_KEY, job);
      emit(true);
      if (current === job) current = null;
    });
  return job;
}

/** Create, update or merge the account for one source user, issue a set-password link if needed. */
async function upsertAccount(c: Conn, u: SourceUser, action: ImportPreviewUser['action'], existing: string | null, admin: User, res: ImportUserResult, notes: string[], o: ImportOptions, origin: string): Promise<string> {
  const s = c.source;
  const { disabled, hiddenFromLogin, unmappedFolders, notes: mapNotes, ...req } = u.mapped;
  let userId: string;
  if (existing) {
    userId = existing;
    res.username = db.get<{ username: string }>('SELECT username FROM users WHERE id = ?', existing)!.username;
    if (action === 'update') {
      try {
        await updateUser(existing, { ...req, username: undefined, password: undefined, disabled }, admin.id);
        // Hidden users stay off the public sign-in list; visible ones are listed (if the sign-in screen lists anyone).
        db.run('UPDATE users SET show_on_signin = ? WHERE id = ?', hiddenFromLogin ? 0 : 1, existing);
      } catch (e) {
        // e.g. "You cannot remove your own admin rights": keep going with the watch data.
        notes.push(`Permissions not changed: ${(e as Error).message}`);
      }
      res.status = 'updated';
    } else res.status = 'merged';
  } else {
    // Nobody knows this password: the user picks their own with the set-password link.
    const password = crypto.randomBytes(24).toString('base64url');
    // Hashed first: the free username is picked and taken with no await in between (users import concurrently).
    const hashes = await hashUserSecrets({ password, pin: req.pin });
    const created = createUserHashed({ ...req, username: freeUsername(u.mapped.username), password, showOnSignIn: !hiddenFromLogin }, hashes);
    userId = created.id;
    res.username = created.username;
    if (disabled) db.run('UPDATE users SET disabled = 1 WHERE id = ?', userId);
    res.status = 'created';
  }
  res.userId = userId;
  setMap(s, 'user', u.id, userId);
  if (unmappedFolders.length) notes.push(`No Kinora library for: ${unmappedFolders.join(', ')}`);
  if (action !== 'merge') notes.push(...(mapNotes ?? []));

  // A link for accounts this importer created whose owner hasn't chosen a password yet (also on re-runs).
  const purpose = linkPurpose(s);
  const row = db.get<{ disabled: number; totp_enabled: number }>('SELECT disabled, totp_enabled FROM users WHERE id = ?', userId)!;
  const importCreated = res.status === 'created' || !!db.get('SELECT 1 FROM password_links WHERE user_id = ? AND purpose = ?', userId, purpose);
  if (importCreated && !passwordLinkUsed(userId, purpose) && !row.disabled && !row.totp_enabled) {
    const link = createPasswordLink(userId, purpose, admin.id, o.linkExpiryDays);
    res.setPasswordUrl = passwordLinkUrl(link.token, origin);
    res.setPasswordExpiresAt = link.expiresAt;
  } else if (importCreated && row.disabled) notes.push('Disabled: no set-password link');
  return userId;
}

/** Write one user's watch data in a single transaction. */
function writeHaul(s: ImportSource, matcher: Matcher, userId: string, haul: Haul, res: ImportUserResult) {
  db.tx(() => {
    for (const x of haul.watched) if (x.m) applyWatched(userId, x.m.id, x.ud);
    for (const x of haul.resume) if (x.m && applyResume(userId, x.m.id, x.ud)) res.resume++;
    for (const x of haul.favorites) if (x.m) applyFavorite(userId, x.m.id);
    for (const x of haul.history) if (x.m && applyHistory(s, userId, x.m.id, x.at, x.durationMs ?? matcher.durationOf(x.m.id))) res.history++;
  });
  res.watched = uniqIds(haul.watched).length;
  res.favorites = uniqIds(haul.favorites).length;
  for (const pl of haul.playlists) {
    upsertContainer(s, 'playlist', pl, userId, pl.items);
    res.playlists++;
  }
  res.unmatched = [...haul.watched, ...haul.resume, ...haul.favorites, ...haul.playlists.flatMap((p) => p.items), ...haul.history].filter((x) => !x.m).length;
}

/** Run an import to the end (tests and the background job). */
export async function runImport(c: Conn, admin: User, job: ImportJob, origin: string): Promise<ImportJob> {
  const s = c.source;
  const L = SOURCE_LABEL[s];
  const o = job.options;
  const mappings = storedConfig(s).pathMappings;
  const w = want(o);
  const setPhase = (phase: string, progress: number, force = false) => {
    job.phase = phase;
    job.progress = Math.max(job.progress, Math.min(99, Math.round(progress)));
    emit(force);
  };
  setPhase(`Reading ${L}`, 1, true);
  const matcher = new Matcher(mappings);
  const session = await DRIVERS[s].open(c, matcher, w);
  job.notes = [...session.notes];
  const libs = mapFolders(session.folders, mappings);
  const selected = session.users(libs).filter((u) => !o.userIds || o.userIds.includes(u.id));
  await session.prepare?.((phase, f = 0) => setPhase(phase, 2 + f * 18));

  // Users: a few at a time; each user's writes are one transaction.
  let done = 0;
  job.results = selected.map((u) => ({
    sourceId: u.id, username: u.mapped.username, displayName: u.mapped.displayName ?? u.mapped.username, userId: null, status: 'skipped', message: null,
    setPasswordUrl: null, setPasswordExpiresAt: null, watched: 0, resume: 0, favorites: 0, playlists: 0, history: 0, unmatched: 0,
  }));
  setPhase(`Importing users (0 of ${selected.length})`, 20, true);
  await pool(selected, USER_CONCURRENCY, async (u, i) => {
    const res = job.results[i];
    try {
      const existing = existingUserId(s, u);
      const action = actionFor(existing, u.mapped, o);
      if (action === 'skip') {
        res.userId = existing;
        res.message = existing ? 'Account already exists' : `Disabled in ${L}`;
        return;
      }
      // Read before writing anything, so a source error leaves no half-made account.
      const haul = await session.collectUser(u, w);
      const notes: string[] = [];
      const userId = await upsertAccount(c, u, action, existing, admin, res, notes, o, origin);
      writeHaul(s, matcher, userId, haul, res);
      res.message = [...notes, ...haul.notes].join(' · ') || null;
    } catch (e) {
      res.status = 'error';
      res.message = (e as Error).message;
      log.warn(`${L} import of ${u.name} failed: ${res.message}`);
    } finally {
      done++;
      setPhase(`Importing users (${done} of ${selected.length}, last: ${u.name})`, 20 + (done / Math.max(1, selected.length)) * 70);
    }
  });

  if (o.importCollections) {
    setPhase('Importing collections', 91, true);
    for (const col of await session.collections()) {
      const r = upsertContainer(s, 'collection', col, null, col.items);
      if (r.created) job.collections.created++;
      else job.collections.updated++;
      job.collections.items += uniqIds(col.items).length;
    }
  }

  if (o.importMetadata) {
    setPhase('Importing metadata', 92, true);
    const md = await importMetadata(session, matcher, { overwrite: !!o.overwriteMetadata }, (phase, f = 0) => setPhase(phase, 92 + f * 7));
    job.metadata = md;
    if (md.imageErrors) job.notes.push(`${md.imageErrors} artwork download(s) failed`);
  }

  const n = (st: ImportUserResult['status']) => job.results.filter((r) => r.status === st).length;
  logActivity(`${s}.import`, `${L} import finished: ${n('created')} created, ${n('updated') + n('merged')} updated, ${n('skipped')} skipped, ${n('error')} failed`, {
    userId: admin.id, userName: admin.displayName, severity: n('error') ? 'warning' : 'info',
  });
  return job;
}
