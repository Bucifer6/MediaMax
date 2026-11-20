import type { AudioDecisionInfo, AudioStream } from '@mediamax/shared';

/** "7.1", "5.1", "2.0", "Mono" from the layout or channel count. */
export function channelText(a: Pick<AudioStream, 'channels' | 'channelLayout'>): string {
  const m = /^(\d\.\d)/.exec(a.channelLayout ?? '');
  if (m) return m[1];
  if (a.channels >= 6) return `${a.channels - 1}.1`;
  if (a.channels === 1) return 'Mono';
  return `${a.channels}.0`;
}

/** Format name; files scanned before audio detection only have the codec. */
export function audioFormat(a: AudioStream): string {
  if (a.formatLabel) return a.formatLabel;
  const c = a.codec.toLowerCase();
  const names: Record<string, string> = { truehd: 'TrueHD', eac3: 'E-AC-3', ac3: 'AC-3', dts: 'DTS', aac: 'AAC', flac: 'FLAC', opus: 'Opus', mp3: 'MP3', alac: 'ALAC', vorbis: 'Vorbis' };
  return names[c] ?? (c.startsWith('pcm_') ? 'PCM' : c.toUpperCase());
}

/** "TrueHD Atmos · 7.1" */
export const audioSummary = (a: AudioStream) => `${audioFormat(a)} · ${channelText(a)}`;

/** Premium-format badges: Dolby Atmos, DTS:X, DTS-HD MA, TrueHD, plus the channel layout for multichannel tracks. */
export function AudioBadges({ stream, channels = true }: { stream: AudioStream; channels?: boolean }) {
  const a = stream;
  const out: { key: string; cls: string; text: string; title: string }[] = [];
  if (a.atmos) out.push({ key: 'atmos', cls: 'badge-audio-atmos', text: 'Dolby Atmos', title: a.codec === 'truehd' ? 'Dolby TrueHD with Atmos' : 'Dolby Digital Plus with Atmos (JOC)' });
  if (a.dtsX) out.push({ key: 'dtsx', cls: 'badge-audio-dts', text: 'DTS:X', title: 'DTS:X (DTS-HD MA core)' });
  else if (a.dtsHdMa) out.push({ key: 'dtsma', cls: 'badge-audio-dts', text: 'DTS-HD MA', title: 'DTS-HD Master Audio (lossless)' });
  if (a.codec === 'truehd') out.push({ key: 'thd', cls: 'badge-audio-dolby', text: 'TrueHD', title: 'Dolby TrueHD (lossless)' });
  if (channels && a.channels > 2) out.push({ key: 'ch', cls: 'badge-audio-ch', text: channelText(a), title: `${a.channels} channels${a.channelLayout ? ` (${a.channelLayout})` : ''}` });
  if (!out.length) return null;
  return (
    <span className="audio-badges">
      {out.map((b) => <span key={b.key} className={`badge badge-audio ${b.cls}`} title={b.title}>{b.text}</span>)}
    </span>
  );
}

/** "TrueHD Atmos 7.1 → E-AC-3 5.1 (device can't play TrueHD)" for the stats overlay. */
export function audioDecisionText(d: AudioDecisionInfo): string {
  if (d.delivery === 'direct' || (d.delivery === 'copy' && d.output === d.source)) {
    return `${d.source} (${d.delivery === 'direct' ? 'direct' : 'passed through'}${d.objects === 'kept' ? ', objects kept' : d.objects === 'lost' ? ', played as channels' : ''})`;
  }
  const why = d.reason ? d.reason.replace(/^.*?: /, '') : null;
  return `${d.source} → ${d.output}${why ? ` (${why})` : ''}`;
}
