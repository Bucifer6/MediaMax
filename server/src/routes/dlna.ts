import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db.js';
import { getSettings } from '../services/settings.js';
import { browse, connectionManagerScpd, contentDirectoryScpd, deviceDescription, dlnaUser, isLocalAddress, soapArg, soapResponse, systemUpdateId } from '../services/dlna.js';
import { assertCanSee } from '../services/items.js';
import { subtitleVtt } from '../services/playback.js';
import { sendFileRange } from './playback.js';
import { forbidden, notFound } from '../util/errors.js';
import { fileExists } from '../util/fileAsync.js';

const CDS = 'urn:schemas-upnp-org:service:ContentDirectory:1';
const CMS = 'urn:schemas-upnp-org:service:ConnectionManager:1';
const MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ts: 'video/mp2t', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

function guard(req: FastifyRequest) {
  if (!getSettings().dlna.enabled) throw notFound('DLNA is disabled');
  // Use the real TCP peer and refuse anything relayed by a proxy: DLNA has no login, so it must
  // only ever answer devices that are directly on the LAN.
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded) throw forbidden('DLNA is not available through a proxy');
  if (!isLocalAddress(req.socket.remoteAddress)) throw forbidden('DLNA is only available on the local network');
}

const xml = (reply: FastifyReply, body: string) => reply.type('text/xml; charset="utf-8"').header('Cache-Control', 'no-cache').send(body);

export default async function dlnaRoutes(app: FastifyInstance) {
  app.addContentTypeParser(['text/xml', 'application/xml', 'application/soap+xml'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.get('/dlna/description.xml', async (req, reply) => {
    guard(req);
    return xml(reply, deviceDescription());
  });
  app.get('/dlna/ContentDirectory.xml', async (req, reply) => {
    guard(req);
    return xml(reply, contentDirectoryScpd());
  });
  app.get('/dlna/ConnectionManager.xml', async (req, reply) => {
    guard(req);
    return xml(reply, connectionManagerScpd());
  });

  app.post('/dlna/control/ContentDirectory', async (req, reply) => {
    guard(req);
    const body = String(req.body ?? '');
    const action = String(req.headers.soapaction ?? '').replace(/"/g, '').split('#')[1] ?? '';
    if (action === 'Browse') {
      const r = browse(soapArg(body, 'ObjectID') || '0', soapArg(body, 'BrowseFlag') || 'BrowseDirectChildren', parseInt(soapArg(body, 'StartingIndex') || '0', 10), parseInt(soapArg(body, 'RequestedCount') || '0', 10));
      return xml(reply, soapResponse(CDS, 'Browse', { Result: r.result, NumberReturned: r.returned, TotalMatches: r.total, UpdateID: systemUpdateId() }));
    }
    if (action === 'GetSystemUpdateID') return xml(reply, soapResponse(CDS, action, { Id: systemUpdateId() }));
    if (action === 'GetSearchCapabilities') return xml(reply, soapResponse(CDS, action, { SearchCaps: '' }));
    if (action === 'GetSortCapabilities') return xml(reply, soapResponse(CDS, action, { SortCaps: '' }));
    if (action === 'X_GetFeatureList') return xml(reply, soapResponse(CDS, action, { FeatureList: '' }));
    reply.status(500);
    return xml(reply, '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
  });

  app.post('/dlna/control/ConnectionManager', async (req, reply) => {
    guard(req);
    const action = String(req.headers.soapaction ?? '').replace(/"/g, '').split('#')[1] ?? '';
    if (action === 'GetCurrentConnectionIDs') return xml(reply, soapResponse(CMS, action, { ConnectionIDs: '0' }));
    const source = Object.values(MIME).map((m) => `http-get:*:${m}:*`).join(',');
    return xml(reply, soapResponse(CMS, 'GetProtocolInfo', { Source: source, Sink: '' }));
  });

  // Eventing: acknowledge subscriptions (we don't push change events; clients re-browse).
  for (const m of ['SUBSCRIBE', 'UNSUBSCRIBE']) {
    try {
      (app as any).addHttpMethod(m);
    } catch {
      /* already registered */
    }
  }
  app.route({
    method: ['SUBSCRIBE', 'UNSUBSCRIBE'] as any,
    url: '/dlna/event/:service',
    handler: async (req, reply) => {
      guard(req);
      return reply.header('SID', `uuid:${Date.now().toString(16)}`).header('TIMEOUT', 'Second-1800').status(200).send();
    },
  });

  app.get<{ Params: { file: string } }>('/dlna/stream/:file', async (req, reply) => {
    guard(req);
    const mediaId = req.params.file.replace(/\.[^.]+$/, '');
    const m = db.get('SELECT * FROM media WHERE id = ?', mediaId);
    if (!m?.path || !(await fileExists(m.path))) throw notFound();
    const user = dlnaUser();
    if (!user) throw forbidden();
    assertCanSee(user, m.item_id);
    reply.header('transferMode.dlna.org', 'Streaming').header('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000');
    return sendFileRange(req, reply, m.path, MIME[(m.container ?? '').toLowerCase()] ?? 'application/octet-stream');
  });

  app.get<{ Params: { mediaId: string; file: string } }>('/dlna/subtitle/:mediaId/:file', async (req, reply) => {
    guard(req);
    const user = dlnaUser();
    const media = db.get('SELECT item_id FROM media WHERE id = ?', req.params.mediaId);
    if (!user || !media) throw notFound();
    assertCanSee(user, media.item_id);
    const vtt = fs.readFileSync(await subtitleVtt(req.params.mediaId, parseInt(req.params.file, 10)), 'utf8');
    // Convert WebVTT → SRT (most DLNA renderers want SRT).
    let n = 0;
    const srt = vtt.replace(/^WEBVTT.*\n+/, '').split(/\n{2,}/).filter((b) => b.includes('-->')).map((b) => `${++n}\n${b.replace(/(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})/g, (_m, h, mm, ss, ms) => `${h ?? '00:'}${mm}:${ss},${ms}`)}`).join('\n\n');
    return reply.type('text/srt; charset=utf-8').send(srt + '\n');
  });
}
