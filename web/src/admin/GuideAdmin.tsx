import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ChannelMatch, EpgGuideChannel, EpgPreset, EpgSource, EpgSourceKind, LiveSource, MatchingResponse, Program, SdHeadend, SdStatus } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { epgApi } from '../api/epg';
import { useToast } from '../state/toast';
import { useAsync, useDebounced } from '../hooks';
import { Badge, EmptyState, ErrorState, Field, Modal, Skeleton, Switch, Tabs, useConfirm } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { formatTime, relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';
import '../styles/epg.css';

type Tab = 'sources' | 'matching';

const KIND: Record<EpgSourceKind, { label: string; icon: IconName }> = {
  xmltv: { label: 'XMLTV', icon: 'list' },
  schedulesdirect: { label: 'Schedules Direct', icon: 'calendar' },
  hdhomerun: { label: 'HDHomeRun', icon: 'antenna' },
  provider: { label: 'Provider guide', icon: 'zap' },
};

export function GuideAdmin() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'matching' ? 'matching' : 'sources';
  const setTab = (t: Tab) => setParams(t === 'sources' ? {} : { tab: t }, { replace: true });
  const liveSources = useAsync(() => api.livetv.sources().catch(() => [] as LiveSource[]), []);
  return (
    <div className="epg-admin">
      <AdminHeader help="admin-tv-guide" title="TV guide" subtitle="Guide (EPG) providers and how your channels are matched to them." />
      <Tabs className="plugin-tabs" value={tab} onChange={setTab} tabs={[{ value: 'sources', label: 'Guide sources' }, { value: 'matching', label: 'Guide matching' }]} />
      {tab === 'sources' ? <SourcesTab liveSources={liveSources.data ?? []} /> : <MatchingTab liveSources={liveSources.data ?? []} />}
    </div>
  );
}

/* ------------------------------ guide sources ------------------------------ */

function SourcesTab({ liveSources }: { liveSources: LiveSource[] }) {
  const toast = useToast();
  const confirm = useConfirm();
  const sources = useAsync(() => epgApi.sources(), []);
  const [edit, setEdit] = useState<EpgSource | 'new' | null>(null);
  const [lineups, setLineups] = useState<EpgSource | null>(null);
  const anyRefreshing = sources.data?.some((s) => s.refreshing);
  useEffect(() => {
    if (!anyRefreshing) return;
    const t = window.setInterval(() => sources.reload(), 3000);
    return () => window.clearInterval(t);
  }, [anyRefreshing, sources]);

  const upsert = (s: EpgSource) => sources.setData((d) => {
    const arr = d ?? [];
    return (arr.some((x) => x.id === s.id) ? arr.map((x) => (x.id === s.id ? s : x)) : [...arr, s]).sort((a, b) => b.priority - a.priority);
  });
  const patch = async (s: EpgSource, body: { enabled?: boolean; priority?: number }) => {
    upsert({ ...s, ...body });
    try {
      upsert(await epgApi.update(s.id, body));
    } catch (e) {
      toast.error(e);
      sources.reload();
    }
  };
  const refresh = async (s: EpgSource) => {
    try {
      await epgApi.refresh(s.id);
      upsert({ ...s, refreshing: true });
      toast.success(`Refreshing ${s.name}`);
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async (s: EpgSource) => {
    if (!(await confirm({ title: `Remove ${s.name}?`, message: 'Its guide data goes too. Channels matched to it fall back to other guides.', confirmLabel: 'Remove guide', danger: true }))) return;
    try {
      await epgApi.remove(s.id);
      sources.setData((d) => (d ?? []).filter((x) => x.id !== s.id));
    } catch (e) {
      toast.error(e);
    }
  };
  const liveName = (id: string) => liveSources.find((l) => l.id === id)?.name ?? 'removed source';
  const [finding, setFinding] = useState(false);
  const findGuides = async () => {
    setFinding(true);
    try {
      const r = await epgApi.auto();
      toast.show(r.added.length ? `Added epgshare01 guides: ${r.added.join(', ')}. Channels are matched as they load.` : r.scores.length ? 'The matching epgshare01 guides are already added.' : 'No epgshare01 guide carries enough of your channels.');
      sources.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setFinding(false);
    }
  };

  return (
    <div>
      <div className="toolbar epg-toolbar">
        <p className="muted epg-note">Each channel takes its guide from the highest-priority source that has it; lower ones fill the gaps. A guide that fails to load keeps its previous data.</p>
        <button className="btn" onClick={findGuides} disabled={finding} title="Compare your channels with the epgshare01 guides and add the ones that carry them">
          <Icon name="sparkles" size={16} /> {finding ? 'Looking…' : 'Find guides automatically'}
        </button>
        <button className="btn btn-primary" onClick={() => setEdit('new')}><Icon name="plus" size={16} /> Add guide</button>
      </div>
      {sources.loading && !sources.data ? <Skeleton h={200} /> : sources.error ? <ErrorState message={sources.error} onRetry={sources.reload} /> : !sources.data?.length ? (
        <EmptyState icon="guide" title="No guide sources yet" message="Add an XMLTV guide, a free community guide, Schedules Direct or your HDHomeRun. Live sources with an EPG URL or a provider guide show up here automatically." action={<button className="btn btn-primary" onClick={() => setEdit('new')}>Add guide</button>} />
      ) : (
        <div className="source-list">
          {sources.data.map((s) => (
            <div key={s.id} className={`source-card ${s.enabled ? '' : 'dim'}`}>
              <div className="source-head">
                <span className="lib-icon"><Icon name={KIND[s.kind]?.icon ?? 'guide'} size={24} /></span>
                <div className="source-title">
                  <strong>{s.name}</strong>
                  <div className="muted">
                    {KIND[s.kind]?.label ?? s.kind}
                    {s.managedBy === 'epgUrl' && <> · from the EPG URL of {liveName(s.ownerSourceId!)}</>}
                    {s.managedBy === 'provider' && <> · {liveName(s.ownerSourceId!)}</>}
                    {!s.ownerSourceId && <> · {s.liveSourceIds ? `for ${s.liveSourceIds.map(liveName).join(', ') || 'no sources'}` : 'for all live sources'}</>}
                    {s.config.url && s.kind === 'xmltv' && <> · <span className="epg-url">{s.config.url}</span></>}
                    {s.config.url && s.kind === 'provider' && / EPG API$/.test(s.config.url) && <> · {s.config.url}</>}
                    {s.config.path && <> · <code>{s.config.path}</code></>}
                  </div>
                </div>
                <label className="epg-priority" title="Higher wins">
                  <span className="muted">Priority</span>
                  <input className="input input-sm" type="number" defaultValue={s.priority} key={s.priority} onBlur={(e) => Number(e.target.value) !== s.priority && patch(s, { priority: Number(e.target.value) })} aria-label="Priority" />
                </label>
                <input type="checkbox" className="switch" checked={s.enabled} onChange={(e) => patch(s, { enabled: e.target.checked })} aria-label="Enabled" />
              </div>
              <div className="epg-report">
                <Stat label="Guide channels" value={s.report.channels.toLocaleString()} />
                <Stat label="Your channels using it" value={s.report.matchedChannels.toLocaleString()} />
                <Stat label="Programmes" value={s.report.programmes.toLocaleString()} />
                <Stat label="Days ahead" value={s.report.daysAhead ? s.report.daysAhead.toFixed(1) : '—'} tone={s.report.programmes && s.report.daysAhead < 1 ? 'warning' : undefined} />
                <Stat label="Last refresh" value={s.refreshing ? 'Refreshing…' : relativeTime(s.lastRefreshAt)} hint={s.report.lastDurationMs != null ? `took ${(s.report.lastDurationMs / 1000).toFixed(1)} s · every ${s.refreshIntervalHours} h` : `every ${s.refreshIntervalHours} h`} />
              </div>
              {s.lastError && <div className="test-result fail compact"><Icon name="alert" size={16} /> {s.lastError}</div>}
              {!!s.report.warnings.length && (
                <ul className="epg-warnings">{s.report.warnings.map((w, i) => <li key={i}><Icon name="info" size={14} /> {w}</li>)}</ul>
              )}
              {s.kind === 'schedulesdirect' && (
                <div className="source-stats">
                  <span><Icon name="layers" size={14} /> {s.config.lineups?.length ? s.config.lineups.map((l) => l.name || l.lineup).join(', ') : 'No lineups yet'}</span>
                </div>
              )}
              <div className="source-actions">
                <button className="btn btn-sm" onClick={() => refresh(s)} disabled={s.refreshing || !s.enabled}><Icon name="refresh" size={14} /> Refresh</button>
                {s.kind === 'schedulesdirect' && <button className="btn btn-sm" onClick={() => setLineups(s)}><Icon name="layers" size={14} /> Lineups</button>}
                {!s.managedBy && <button className="btn btn-sm btn-ghost" onClick={() => setEdit(s)}><Icon name="edit" size={14} /> Edit</button>}
                {!s.managedBy && <button className="btn btn-sm btn-ghost" onClick={() => remove(s)}><Icon name="trash" size={14} /> Remove</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add guide source' : `Edit ${edit ? (edit as EpgSource).name : ''}`} size="lg">
        {edit && (
          <GuideForm initial={edit === 'new' ? undefined : edit} liveSources={liveSources} onCancel={() => setEdit(null)} onSaved={(s) => {
            upsert(s);
            setEdit(null);
            if (s.kind === 'schedulesdirect' && !s.config.lineups?.length) setLineups(s);
          }} />
        )}
      </Modal>
      <Modal open={!!lineups} onClose={() => { setLineups(null); sources.reload(); }} title={`Schedules Direct lineups · ${lineups?.name ?? ''}`} size="lg">
        {lineups && <SdLineups source={lineups} />}
      </Modal>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warning' }) {
  return (
    <div className={`epg-stat ${tone ?? ''}`}>
      <span className="epg-stat-value">{value}</span>
      <span className="epg-stat-label">{label}</span>
      {hint && <span className="epg-stat-hint muted">{hint}</span>}
    </div>
  );
}

type FormKind = 'xmltv' | 'preset' | 'schedulesdirect' | 'hdhomerun';

function GuideForm({ initial, liveSources, onCancel, onSaved }: { initial?: EpgSource; liveSources: LiveSource[]; onCancel: () => void; onSaved: (s: EpgSource) => void }) {
  const toast = useToast();
  const presets = useAsync(() => epgApi.presets(), []);
  const [kind, setKind] = useState<FormKind>(initial ? (initial.config.preset ? 'preset' : (initial.kind as FormKind)) : 'xmltv');
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.config.url ?? '');
  const [filePath, setFilePath] = useState(initial?.config.path ?? '');
  const [useFile, setUseFile] = useState(!!initial?.config.path);
  const [timezone, setTimezone] = useState(initial?.config.timezone ?? '');
  const [country, setCountry] = useState('');
  const [preset, setPreset] = useState(initial?.config.preset ?? '');
  const [username, setUsername] = useState(initial?.config.username ?? '');
  const [password, setPassword] = useState('');
  const [days, setDays] = useState(initial?.config.days ?? 7);
  const [artwork, setArtwork] = useState(!!initial?.config.artwork);
  const hdhrSources = liveSources.filter((l) => l.type === 'hdhomerun');
  const [liveSourceId, setLiveSourceId] = useState(initial?.config.liveSourceId ?? hdhrSources[0]?.id ?? '');
  const [deviceUrl, setDeviceUrl] = useState(initial?.config.deviceUrl ?? '');
  const [priority, setPriority] = useState(initial?.priority ?? 50);
  const [hours, setHours] = useState(initial?.refreshIntervalHours ?? 12);
  const [scope, setScope] = useState<string[] | null>(initial ? initial.liveSourceIds : null);
  const [busy, setBusy] = useState(false);

  const countries = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of presets.data ?? []) m.set(p.country, p.countryName);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [presets.data]);
  const shownPresets = (presets.data ?? []).filter((p) => !country || p.country === country);
  const pick = (p: EpgPreset) => {
    setPreset(p.id);
    if (!name || (presets.data ?? []).some((x) => x.name === name)) setName(p.name);
  };

  const save = async () => {
    setBusy(true);
    try {
      const apiKind = kind === 'preset' ? 'xmltv' : kind;
      const config =
        kind === 'xmltv' ? { url: useFile ? null : url, path: useFile ? filePath : null, timezone: timezone || null, preset: null }
          : kind === 'preset' ? { preset, timezone: timezone || null, url: (presets.data ?? []).find((p) => p.id === preset)?.url ?? null }
            : kind === 'schedulesdirect' ? { username, ...(password ? { password } : {}), days, artwork }
              : { liveSourceId: liveSourceId || null, deviceUrl: liveSourceId ? null : deviceUrl, days: Math.min(days, 14) };
      const body = { name: name || (kind === 'hdhomerun' ? 'HDHomeRun guide' : kind === 'schedulesdirect' ? 'Schedules Direct' : 'XMLTV guide'), config, priority, refreshIntervalHours: hours, liveSourceIds: scope };
      const s = initial ? await epgApi.update(initial.id, body) : await epgApi.create({ ...body, kind: apiKind });
      toast.success(initial ? 'Guide saved' : 'Guide added — loading it now');
      onSaved(s);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const kinds: { k: FormKind; label: string; icon: IconName; hint: string }[] = [
    { k: 'xmltv', label: 'XMLTV', icon: 'list', hint: 'Any XMLTV URL or local file (.xml, .gz, .xz)' },
    { k: 'preset', label: 'Free community guide', icon: 'globe', hint: 'epgshare01, iptv-org and epg.pw guides by country' },
    { k: 'schedulesdirect', label: 'Schedules Direct', icon: 'calendar', hint: 'Paid, accurate US/Canada and more' },
    { k: 'hdhomerun', label: 'HDHomeRun', icon: 'antenna', hint: 'Free for HDHomeRun owners' },
  ];

  return (
    <div className="form-grid">
      {!initial && (
        <div className="epg-kinds" role="radiogroup" aria-label="Guide type">
          {kinds.map((k) => (
            <button key={k.k} type="button" role="radio" aria-checked={kind === k.k} className={`epg-kind ${kind === k.k ? 'active' : ''}`} onClick={() => setKind(k.k)}>
              <Icon name={k.icon} size={20} /><strong>{k.label}</strong><span className="muted">{k.hint}</span>
            </button>
          ))}
        </div>
      )}
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. UK guide" /></Field>

      {kind === 'xmltv' && (
        <>
          <div className="row-gap">
            <label className="check-inline"><input type="radio" checked={!useFile} onChange={() => setUseFile(false)} /> URL</label>
            <label className="check-inline"><input type="radio" checked={useFile} onChange={() => setUseFile(true)} /> File on the server</label>
          </div>
          {useFile
            ? <Field label="File path" hint="Absolute path, readable by the server. .gz and .xz files are decompressed automatically."><input className="input" value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="/data/guide.xml.gz" /></Field>
            : <Field label="XMLTV URL" hint="gzip and .xz guides are detected automatically."><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/guide.xml.gz" /></Field>}
        </>
      )}
      {kind === 'preset' && (
        <>
          <p className="muted">Free guides run by volunteers (iptv-org, epg.pw). Coverage and availability vary, and URLs can move — you can always paste another URL with the XMLTV option.</p>
          <Field label="Country">
            <select className="select" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">All countries</option>
              {countries.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </select>
          </Field>
          <div className="epg-presets">
            {shownPresets.map((p) => (
              <button key={p.id} type="button" className={`epg-preset ${preset === p.id ? 'active' : ''}`} onClick={() => pick(p)}>
                <Badge tone={p.provider === 'epg.pw' ? 'accent' : 'primary'}>{p.provider}</Badge> <span>{p.countryName}</span>
                <span className="muted epg-url">{p.url}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {(kind === 'xmltv' || kind === 'preset') && (
        <Field label="Time zone override" hint="Only if the guide's times are off: its times are read as wall-clock times in this zone (e.g. Europe/London or +01:00). Per-channel shifts are on the matching tab.">
          <input className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Use the guide's own offsets" />
        </Field>
      )}
      {kind === 'schedulesdirect' && (
        <>
          <div className="epg-callout">
            <Icon name="info" size={18} />
            <div>
              <strong>Schedules Direct is a paid service</strong> (about $35 a year) with accurate listings for the US, Canada and many other countries — the same data Plex, Channels DVR and MythTV users rely on.
              Create an account at <a href="https://www.schedulesdirect.org" target="_blank" rel="noreferrer">schedulesdirect.org</a>, then add your lineups here by country and postcode.
              Vibe follows their rules: one login per day, md5 checks so unchanged listings are never downloaded twice, and no more than one refresh every 12 hours.
            </div>
          </div>
          <div className="form-row">
            <Field label="Username"><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></Field>
            <Field label="Password" hint={initial?.config.hasPassword ? 'Saved. Leave blank to keep it.' : 'Stored only as the SHA1 hash Schedules Direct asks for.'}>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={initial?.config.hasPassword ? '••••••••' : ''} autoComplete="new-password" />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Days of listings"><input className="input" type="number" min={1} max={21} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
            <Field label="Artwork"><Switch checked={artwork} onChange={setArtwork} label="Fetch programme images" /></Field>
          </div>
        </>
      )}
      {kind === 'hdhomerun' && (
        <>
          <p className="muted">SiliconDust provides guide data free for HDHomeRun owners. Channels on the tuner are matched by guide number.</p>
          <Field label="Tuner">
            <select className="select" value={liveSourceId} onChange={(e) => setLiveSourceId(e.target.value)}>
              {hdhrSources.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              <option value="">Another device (enter its address)</option>
            </select>
          </Field>
          {!liveSourceId && <Field label="Device address"><input className="input" value={deviceUrl} onChange={(e) => setDeviceUrl(e.target.value)} placeholder="http://192.168.1.50" /></Field>}
          <Field label="Days of listings" hint="The free guide usually covers about a day."><input className="input" type="number" min={1} max={14} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
        </>
      )}

      <div className="form-row">
        <Field label="Priority" hint="Higher wins. Live-source EPG URLs use 100, provider guides 0."><input className="input" type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} /></Field>
        <Field label="Refresh every (hours)"><input className="input" type="number" min={kind === 'schedulesdirect' ? 12 : 1} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></Field>
      </div>
      <Field label="Use for">
        <div className="epg-scope">
          <label className="check-inline"><input type="radio" checked={scope === null} onChange={() => setScope(null)} /> All live sources</label>
          <label className="check-inline"><input type="radio" checked={scope !== null} onChange={() => setScope(kind === 'hdhomerun' && liveSourceId ? [liveSourceId] : [])} /> Selected sources</label>
          {scope !== null && liveSources.map((l) => (
            <label key={l.id} className="check-inline epg-scope-item">
              <input type="checkbox" checked={scope.includes(l.id)} onChange={(e) => setScope(e.target.checked ? [...scope, l.id] : scope.filter((x) => x !== l.id))} /> {l.name}
            </label>
          ))}
        </div>
      </Field>
      <div className="modal-foot-inline">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || (kind === 'preset' && !preset)}>{busy ? 'Saving…' : initial ? 'Save' : 'Add guide'}</button>
      </div>
    </div>
  );
}

const SD_COUNTRIES: [string, string][] = [['USA', 'United States'], ['CAN', 'Canada'], ['GBR', 'United Kingdom'], ['AUS', 'Australia'], ['NZL', 'New Zealand'], ['DEU', 'Germany'], ['FRA', 'France'], ['ESP', 'Spain'], ['ITA', 'Italy'], ['NLD', 'Netherlands'], ['MEX', 'Mexico'], ['BRA', 'Brazil']];

function SdLineups({ source }: { source: EpgSource }) {
  const toast = useToast();
  const status = useAsync(() => epgApi.sdStatus(source.id), [source.id]);
  const [country, setCountry] = useState('USA');
  const [postcode, setPostcode] = useState('');
  const [heads, setHeads] = useState<SdHeadend[] | null>(null);
  const [busy, setBusy] = useState(false);
  const setStatus = (s: SdStatus) => status.setData(s);
  const search = async () => {
    setBusy(true);
    try {
      setHeads(await epgApi.sdHeadends(source.id, country, postcode));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const change = async (lineup: string, add: boolean) => {
    setBusy(true);
    try {
      const r = add ? await epgApi.sdAddLineup(source.id, lineup) : await epgApi.sdRemoveLineup(source.id, lineup);
      setStatus(r.status);
      toast.success(`${add ? 'Added' : 'Removed'} ${lineup}${r.changesRemaining != null ? ` · ${r.changesRemaining} lineup changes left today` : ''}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const have = new Set((status.data?.lineups ?? []).map((l) => l.lineup));
  return (
    <div className="form-grid">
      {status.loading && !status.data ? <Skeleton h={80} /> : status.error ? <ErrorState message={status.error} onRetry={status.reload} /> : status.data && (
        <>
          <div className="source-stats">
            <span><Icon name="user" size={14} /> Account {status.data.accountExpires ? `paid until ${new Date(status.data.accountExpires).toLocaleDateString()}` : 'status unknown'}</span>
            {status.data.maxLineups != null && <span><Icon name="layers" size={14} /> {status.data.lineups.length}/{status.data.maxLineups} lineups</span>}
            {status.data.systemStatus && <span><Icon name="activity" size={14} /> {status.data.systemStatus}</span>}
          </div>
          {status.data.messages.map((m, i) => <div key={i} className="test-result compact"><Icon name="info" size={16} /> {m}</div>)}
          <h3 className="epg-h3">Your lineups</h3>
          {!status.data.lineups.length ? <p className="muted">No lineups yet. Find yours below.</p> : (
            <ul className="epg-lineups">
              {status.data.lineups.map((l) => (
                <li key={l.lineup}>
                  <div><strong>{l.name}</strong><div className="muted">{l.lineup} · {l.transport} · {l.location}</div></div>
                  <button className="btn btn-sm btn-ghost" onClick={() => change(l.lineup, false)} disabled={busy}><Icon name="trash" size={14} /> Remove</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <h3 className="epg-h3">Add a lineup</h3>
      <div className="form-row">
        <Field label="Country">
          <select className="select" value={country} onChange={(e) => setCountry(e.target.value)}>
            {SD_COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </Field>
        <Field label="Postcode / ZIP"><input className="input" value={postcode} onChange={(e) => setPostcode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} /></Field>
      </div>
      <div><button className="btn" onClick={search} disabled={busy || !postcode.trim()}><Icon name="search" size={14} /> Find lineups</button></div>
      {heads && (heads.length ? (
        <ul className="epg-lineups">
          {heads.flatMap((h) => h.lineups.map((l) => (
            <li key={l.lineup}>
              <div><strong>{l.name}</strong><div className="muted">{h.transport} · {h.location} · {l.lineup}</div></div>
              {have.has(l.lineup) ? <Badge tone="success">Added</Badge> : <button className="btn btn-sm" onClick={() => change(l.lineup, true)} disabled={busy}><Icon name="plus" size={14} /> Add</button>}
            </li>
          )))}
        </ul>
      ) : <p className="muted">No lineups found for that postcode.</p>)}
      <p className="muted">Schedules Direct allows a few lineup changes per day and a handful of lineups per account.</p>
    </div>
  );
}

/* ------------------------------ matching ------------------------------ */

type Filter = 'all' | 'unmatched' | 'low' | 'missing';
const PAGE = 100;

function statusBadge(m: ChannelMatch) {
  if (m.status === 'manual') return <Badge tone="primary">Manual</Badge>;
  if (m.status === 'auto') return <Badge tone="success">Auto</Badge>;
  if (m.status === 'review') return <Badge tone="warning">Suggested</Badge>;
  return <Badge tone="muted">{m.method === 'manual' ? 'No guide' : 'Unmatched'}</Badge>;
}

function Confidence({ value }: { value: number | null }) {
  if (value == null) return <span className="muted">—</span>;
  const pct = Math.round(value * 100);
  return (
    <span className="epg-conf" title={`${pct}% confidence`}>
      <span className="epg-conf-bar"><span style={{ width: `${pct}%` }} className={pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo'} /></span>
      <span className="epg-conf-num">{pct}%</span>
    </span>
  );
}

function MatchingTab({ liveSources }: { liveSources: LiveSource[] }) {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [sourceId, setSourceId] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const [data, setData] = useState<MatchingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<ChannelMatch | null>(null);
  const req = useRef(0);

  const load = async (offset = 0) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const r = await epgApi.matching({ filter, sourceId: sourceId || undefined, search: q || undefined, offset, limit: PAGE });
      if (id !== req.current) return;
      setData((d) => (offset && d ? { ...r, items: [...d.items, ...r.items] } : r));
    } catch (e) {
      toast.error(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, sourceId, q]);

  const replace = (m: ChannelMatch) => setData((d) => (d ? { ...d, items: d.items.map((x) => (x.channelId === m.channelId ? m : x)) } : d));
  const accept = async (m: ChannelMatch) => {
    try {
      replace(await epgApi.setMatch(m.channelId, { epgSourceId: m.epgSourceId, epgChannelId: m.epgChannelId }));
    } catch (e) {
      toast.error(e);
    }
  };
  const acceptAll = async () => {
    try {
      const r = await epgApi.acceptAll(sourceId || undefined);
      toast.success(`Accepted ${r.accepted} suggestion${r.accepted === 1 ? '' : 's'}`);
      void load(0);
    } catch (e) {
      toast.error(e);
    }
  };
  const rematch = async () => {
    try {
      await epgApi.rematch();
      toast.success('Matching re-run');
      void load(0);
    } catch (e) {
      toast.error(e);
    }
  };
  const c = data?.counts;
  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: `All${c ? ` (${c.all})` : ''}` },
    { value: 'unmatched', label: `Unmatched${c ? ` (${c.unmatched})` : ''}` },
    { value: 'low', label: `Low confidence${c ? ` (${c.review})` : ''}` },
    { value: 'missing', label: `Missing guide${c ? ` (${c.missingGuide})` : ''}` },
  ];

  return (
    <div>
      <div className="toolbar epg-toolbar">
        <div className="segmented" role="tablist" aria-label="Filter">
          {filters.map((f) => <button key={f.value} role="tab" aria-selected={filter === f.value} className={filter === f.value ? 'active' : ''} onClick={() => setFilter(f.value)}>{f.label}</button>)}
        </div>
        <div className="search-mini"><Icon name="search" size={16} /><input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search channels" /></div>
        <select className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Live source">
          <option value="">All live sources</option>
          {liveSources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={rematch}><Icon name="refresh" size={14} /> Re-run matching</button>
        <button className="btn btn-sm btn-primary" onClick={acceptAll} disabled={!c?.review}><Icon name="check" size={14} /> Accept all suggestions{c?.review ? ` (${c.review})` : ''}</button>
      </div>
      {data && <p className="muted epg-note">Matches at {Math.round(data.thresholds.auto * 100)}% confidence or more are applied automatically; between {Math.round(data.thresholds.suggest * 100)}% and {Math.round(data.thresholds.auto * 100)}% they wait here as suggestions. Manual matches are kept across refreshes.</p>}
      {loading && !data ? <Skeleton h={300} /> : !data?.items.length ? (
        <EmptyState icon="guide" title={filter === 'all' ? 'No channels yet' : 'Nothing here'} message={filter === 'all' ? 'Add a live TV source first.' : 'No channels match this filter.'} />
      ) : (
        <div className="table-wrap">
          <table className="table epg-match-table">
            <thead><tr><th style={{ width: 60 }}>#</th><th>Channel</th><th>Status</th><th>Guide channel</th><th>Confidence</th><th>Shift</th><th /></tr></thead>
            <tbody>
              {data.items.map((m) => (
                <tr key={m.channelId} className={m.status === 'review' ? 'epg-row-review' : ''}>
                  <td className="muted">{m.channelNumber ?? ''}</td>
                  <td><div className="epg-ch-name">{m.channelName}</div><div className="muted epg-small">{m.sourceName}</div></td>
                  <td>{statusBadge(m)} {!m.hasGuide && m.status !== 'review' && <Badge tone="danger">Missing guide</Badge>}</td>
                  <td>
                    {m.epgChannelId ? (
                      <>
                        <div className={m.status === 'review' ? 'epg-suggested' : ''}>{m.epgChannelName ?? m.epgChannelId}</div>
                        <div className="muted epg-small">{m.epgSourceName ?? 'unknown guide'} · <code>{m.epgChannelId}</code>{m.method && m.method !== 'manual' ? ` · ${m.method}` : ''}</div>
                      </>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td><Confidence value={m.confidence} /></td>
                  <td className="muted">{m.offsetHours ? `${m.offsetHours > 0 ? '+' : ''}${m.offsetHours} h` : '—'}</td>
                  <td className="td-actions">
                    {m.status === 'review' && <button className="btn btn-sm" onClick={() => accept(m)}><Icon name="check" size={14} /> Accept</button>}
                    <button className="btn-icon" onClick={() => setEdit(m)} aria-label={`${m.status === 'none' ? 'Match' : 'Change'} guide for ${m.channelName}`} title={m.status === 'none' ? 'Pick a guide channel' : 'Change match or time shift'}><Icon name="edit" size={16} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.items.length < data.total && (
            <div className="center-pad"><button className="btn" onClick={() => load(data.items.length)} disabled={loading}>Load more ({data.total - data.items.length} remaining)</button></div>
          )}
        </div>
      )}
      {edit && <MatchEditor match={edit} onClose={() => setEdit(null)} onSaved={(m) => { replace(m); setEdit(null); }} />}
    </div>
  );
}

function MatchEditor({ match, onClose, onSaved }: { match: ChannelMatch; onClose: () => void; onSaved: (m: ChannelMatch) => void }) {
  const toast = useToast();
  const [search, setSearch] = useState(match.channelName);
  const q = useDebounced(search, 250);
  const results = useAsync((signal) => epgApi.guideChannels(q, undefined, signal), [q]);
  const [picked, setPicked] = useState<{ epgSourceId: string; id: string; name: string; epgSourceName: string } | null>(
    match.epgSourceId && match.epgChannelId ? { epgSourceId: match.epgSourceId, id: match.epgChannelId, name: match.epgChannelName ?? match.epgChannelId, epgSourceName: match.epgSourceName ?? '' } : null,
  );
  const [offset, setOffset] = useState(match.offsetHours ?? 0);
  const preview = useAsync((signal) => (picked ? epgApi.preview(picked.epgSourceId, picked.id, offset, signal) : Promise.resolve(null)), [picked?.epgSourceId, picked?.id, offset]);
  const save = async (body: Parameters<typeof epgApi.setMatch>[1]) => {
    try {
      onSaved(await epgApi.setMatch(match.channelId, body));
      toast.success('Guide match saved');
    } catch (e) {
      toast.error(e);
    }
  };
  const offsets = Array.from({ length: 49 }, (_, i) => (i - 24) / 2);
  return (
    <Modal open onClose={onClose} title={`Guide for ${match.channelName}`} size="lg" footer={
      <>
        <button className="btn btn-ghost" onClick={() => save({ epgChannelId: null, offsetHours: null })} title="Forget the manual match and let automatic matching decide">Use automatic</button>
        <button className="btn btn-ghost" onClick={() => save({ none: true })}>No guide</button>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!picked} onClick={() => picked && save({ epgSourceId: picked.epgSourceId, epgChannelId: picked.id, offsetHours: offset || null })}>Save match</button>
      </>
    }>
      <div className="epg-editor">
        <div className="epg-editor-search">
          <div className="search-mini"><Icon name="search" size={16} /><input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search every guide's channels" autoFocus /></div>
          <ul className="epg-results" role="listbox" aria-label="Guide channels">
            {results.loading && !results.data ? <li className="muted">Searching…</li> : !results.data?.length ? <li className="muted">No guide channels found.</li> : results.data.map((g: EpgGuideChannel) => {
              const active = picked?.epgSourceId === g.epgSourceId && picked.id === g.id;
              return (
                <li key={g.epgSourceId + g.id}>
                  <button type="button" role="option" aria-selected={active} className={`epg-result ${active ? 'active' : ''}`} onClick={() => setPicked({ epgSourceId: g.epgSourceId, id: g.id, name: g.name, epgSourceName: g.epgSourceName })}>
                    <span className="epg-result-name">{g.name}{g.number ? <span className="muted"> · {g.number}</span> : null}</span>
                    <span className="muted epg-small">{g.epgSourceName} · <code>{g.id}</code> · {g.programmes ? `${g.programmes} programmes` : 'no programmes stored'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="epg-editor-preview">
          <Field label="Time shift" hint="For a guide that runs early or late on this channel.">
            <select className="select" value={offset} onChange={(e) => setOffset(Number(e.target.value))}>
              {offsets.map((o) => <option key={o} value={o}>{o === 0 ? 'None' : `${o > 0 ? '+' : ''}${o} h`}</option>)}
            </select>
          </Field>
          <h3 className="epg-h3">Preview</h3>
          {!picked ? <p className="muted">Pick a guide channel to see what's on.</p> : preview.loading && !preview.data ? <Skeleton h={120} /> : (
            <div className="epg-preview">
              <div className="muted epg-small">{picked.name} · {picked.epgSourceName}</div>
              <PreviewRow label="Now" p={preview.data?.now ?? null} />
              <PreviewRow label="Next" p={preview.data?.next ?? null} />
              {(preview.data?.upcoming ?? []).slice(1, 4).map((p) => <PreviewRow key={p.id} label="" p={p} />)}
              {!preview.data?.now && !preview.data?.next && <p className="muted">No programmes stored for this channel right now{picked ? ' — big guides store a channel after it is matched and refreshed' : ''}.</p>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PreviewRow({ label, p }: { label: string; p: Program | null }) {
  if (!p) return null;
  return (
    <div className="epg-prev-row">
      <span className="epg-prev-label">{label}</span>
      <span className="epg-prev-time">{formatTime(p.start)}–{formatTime(p.end)}</span>
      <span className="epg-prev-title">{p.title}{p.subtitle ? <span className="muted"> · {p.subtitle}</span> : null}</span>
    </div>
  );
}
