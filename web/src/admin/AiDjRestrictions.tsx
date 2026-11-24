import { useState } from 'react';
import type { DjRules } from '@mediamax/shared';
import { Field, Switch } from '../components/ui';
import { compactRules } from './aiChain';

export { compactRules };

const list = (t: string): string[] | undefined => {
  const v = [...new Set(t.split(',').map((x) => x.trim()).filter(Boolean))];
  return v.length ? v : undefined;
};
const num = (t: string): number | undefined => (t.trim() === '' || !Number.isFinite(Number(t)) ? undefined : Number(t));

/**
 * Admin → Users → edit: DJ restrictions this user can't override (e.g. a kids' profile). They bound Your DJ, Mix /
 * endless and smart order on every device, on top of the user's own rules.
 */
export function DjRestrictionsEditor({ value, onChange }: { value: DjRules; onChange: (r: DjRules) => void }) {
  const [text, setText] = useState<Record<string, string>>({});
  const v = value;
  const set = (p: Partial<DjRules>) => onChange(compactRules({ ...v, ...p }));
  const listField = (k: 'includeGenres' | 'excludeGenres' | 'includeArtists' | 'excludeArtists', label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input className="input" value={text[k] ?? (v[k] ?? []).join(', ')} placeholder="Comma separated"
        onChange={(e) => setText({ ...text, [k]: e.target.value })}
        onBlur={() => {
          if (text[k] != null) set({ [k]: list(text[k]) });
          setText(({ [k]: _drop, ...rest }) => rest);
        }} />
    </Field>
  );
  const numField = (k: 'yearMin' | 'yearMax' | 'bpmMin' | 'bpmMax' | 'minRating', label: string, min: number, max: number) => (
    <Field label={label}>
      <input className="input" type="number" min={min} max={max} value={v[k] ?? ''} onChange={(e) => set({ [k]: num(e.target.value) })} />
    </Field>
  );
  const active = Object.keys(v).length > 0;
  return (
    <div className="dj-restrictions">
      <span className="field-label">DJ restrictions {active ? <span className="muted">(active)</span> : <span className="muted">(none)</span>}</span>
      <p className="field-hint">Limits what Your DJ, Mix / endless and smart order may play for this user, on every device. The user can add their own rules but can't loosen these. Library access and the content rating above still apply.</p>
      <div className="form-row">
        {listField('includeGenres', 'Only these genres')}
        {listField('excludeGenres', 'Never these genres')}
      </div>
      <div className="form-row">
        {listField('includeArtists', 'Only these artists')}
        {listField('excludeArtists', 'Never these artists')}
      </div>
      <div className="form-row">
        {numField('yearMin', 'Released from', 1900, 2100)}
        {numField('yearMax', 'Released until', 1900, 2100)}
        {numField('bpmMin', 'Tempo from (BPM)', 40, 250)}
        {numField('bpmMax', 'Tempo up to (BPM)', 40, 250)}
      </div>
      <div className="form-row">
        <Field label="Energy" hint="From the track analysis; unanalysed tracks are left out while set.">
          <select className="input" value={v.energyMax != null && v.energyMax <= 0.5 ? 'calm' : v.energyMin != null && v.energyMin >= 0.5 ? 'lively' : ''}
            onChange={(e) => set(e.target.value === 'calm' ? { energyMin: undefined, energyMax: 0.5 } : e.target.value === 'lively' ? { energyMin: 0.5, energyMax: undefined } : { energyMin: undefined, energyMax: undefined })}>
            <option value="">Any</option>
            <option value="calm">Calm only</option>
            <option value="lively">Lively only</option>
          </select>
        </Field>
        <Field label="Longest track (minutes)">
          <input className="input" type="number" min={1} max={360} value={v.maxDurationSec != null ? Math.round(v.maxDurationSec / 60) : ''} onChange={(e) => set({ maxDurationSec: num(e.target.value) != null ? Math.max(1, num(e.target.value)!) * 60 : undefined })} />
        </Field>
        {numField('minRating', 'Minimum rating (0–10)', 0, 10)}
      </div>
      <Switch checked={!!v.cleanOnly} onChange={(x) => set({ cleanOnly: x || undefined })} label="Clean only" hint="Leaves out tracks tagged explicit (an “explicit” tag or rating, or “(Explicit)” in the title)." />
    </div>
  );
}
