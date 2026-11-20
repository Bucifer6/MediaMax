import type { EpgPreset } from '@mediamax/shared';

/**
 * Free community XMLTV guides. These are third-party, community-run services: URLs can move or go stale,
 * so admins can always paste any other XMLTV URL instead.
 *  - epg.pw publishes one XMLTV file per country: https://epg.pw/xmltv/epg_<CC>.xml
 *  - iptv-org/epg guides, as published on GitHub Pages: https://iptv-org.github.io/epg/guides/<cc>/<site>.epg.xml
 */
const EPG_PW: [string, string][] = [
  ['GB', 'United Kingdom'], ['US', 'United States'], ['CA', 'Canada'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['IE', 'Ireland'],
  ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['IT', 'Italy'], ['NL', 'Netherlands'], ['IN', 'India'], ['JP', 'Japan'],
  ['KR', 'South Korea'], ['HK', 'Hong Kong'], ['TW', 'Taiwan'], ['SG', 'Singapore'], ['MY', 'Malaysia'], ['PH', 'Philippines'],
  ['ID', 'Indonesia'], ['VN', 'Vietnam'], ['CN', 'China'], ['RU', 'Russia'], ['BR', 'Brazil'], ['MX', 'Mexico'], ['ZA', 'South Africa'],
];

const IPTV_ORG: [string, string, string][] = [
  ['uk', 'United Kingdom', 'sky.com'], ['uk', 'United Kingdom', 'bt.com'], ['us', 'United States', 'tvtv.us'], ['us', 'United States', 'directv.com'],
  ['ca', 'Canada', 'tvtv.us'], ['au', 'Australia', 'ontvtonight.com'], ['ie', 'Ireland', 'virginmediatv.ie'], ['de', 'Germany', 'hd-plus.de'],
  ['fr', 'France', 'programme-tv.net'], ['es', 'Spain', 'movistarplus.es'], ['it', 'Italy', 'guidatv.sky.it'], ['nl', 'Netherlands', 'delta.nl'],
  ['in', 'India', 'tataplay.com'], ['br', 'Brazil', 'mi.tv'], ['mx', 'Mexico', 'mi.tv'],
];

export const EPG_PRESETS: EpgPreset[] = [
  ...EPG_PW.map(([cc, name]) => ({ id: `epgpw-${cc.toLowerCase()}`, provider: 'epg.pw' as const, country: cc, countryName: name, name: `epg.pw · ${name}`, url: `https://epg.pw/xmltv/epg_${cc}.xml` })),
  ...IPTV_ORG.map(([cc, name, site]) => ({ id: `iptvorg-${cc}-${site}`, provider: 'iptv-org' as const, country: cc.toUpperCase() === 'UK' ? 'GB' : cc.toUpperCase(), countryName: name, name: `iptv-org · ${name} (${site})`, url: `https://iptv-org.github.io/epg/guides/${cc}/${site}.epg.xml` })),
];

export const findPreset = (id: string | null | undefined) => (id ? EPG_PRESETS.find((p) => p.id === id) ?? null : null);
