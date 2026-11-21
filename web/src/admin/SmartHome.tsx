import { useEffect, useState } from 'react';
import type { HomeAssistantSettings, HomeAssistantStatus } from '@mediamax/shared';
import { smartHomeApi } from '../api/smarthome';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, ErrorState, Field, Skeleton, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

const STATE_TONE: Record<HomeAssistantStatus['mqtt']['state'], 'success' | 'warning' | 'danger' | 'muted'> = {
  connected: 'success', connecting: 'warning', disconnected: 'warning', error: 'danger', disabled: 'muted',
};
const STATE_LABEL: Record<HomeAssistantStatus['mqtt']['state'], string> = {
  connected: 'Connected', connecting: 'Connecting…', disconnected: 'Reconnecting', error: 'Not connected', disabled: 'Off',
};

const exampleAutomation = (hookId: string) => `automation:
  - alias: "Movie night lights"
    trigger:
      - platform: webhook
        webhook_id: ${hookId}
        allowed_methods: [POST]
        local_only: true
    condition:
      - "{{ trigger.json.device == 'Living Room TV' and trigger.json.is_video }}"
    action:
      - choose:
          - conditions: "{{ trigger.json.action in ['started', 'resumed'] }}"
            sequence:
              - service: light.turn_on
                target: { entity_id: light.living_room }
                data: { brightness_pct: 10, transition: 3 }
          - conditions: "{{ trigger.json.action in ['paused', 'stopped', 'ended'] }}"
            sequence:
              - service: light.turn_on
                target: { entity_id: light.living_room }
                data: { brightness_pct: 80, transition: 2 }`;

export function SmartHomeAdmin() {
  const toast = useToast();
  const data = useAsync(() => smartHomeApi.homeAssistant(), []);
  const [s, setS] = useState<HomeAssistantSettings | null>(null);
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'discovery' | 'hook'>('');
  const [haUrl, setHaUrl] = useState('http://homeassistant.local:8123');
  const [hookId, setHookId] = useState(() => `kinora_${Math.random().toString(36).slice(2, 10)}`);

  useEffect(() => {
    if (data.data) setS(data.data.settings);
  }, [data.data]);

  // Keep the connection badge fresh while the page is open.
  useEffect(() => {
    const t = window.setInterval(() => {
      void smartHomeApi.homeAssistant().then((r) => data.setData((d) => (d ? { ...d, status: r.status } : r))).catch(() => {});
    }, 5000);
    return () => window.clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const m = s?.mqtt;
  const setM = (p: Partial<HomeAssistantSettings['mqtt']>) => setS((x) => (x ? { mqtt: { ...x.mqtt, ...p } } : x));
  const dirty = !!s && !!data.data && JSON.stringify(s) !== JSON.stringify(data.data.settings);
  const st = data.data?.status;

  const save = async () => {
    if (!s) return;
    setBusy('save');
    try {
      data.setData(await smartHomeApi.saveHomeAssistant(s));
      toast.success(s.mqtt.enabled ? 'Saved — connecting to the broker' : 'Saved');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy('');
    }
  };
  const test = async () => {
    if (!s) return;
    setBusy('test');
    try {
      const r = await smartHomeApi.testMqtt(s);
      toast.show(r.ok ? r.message : `MQTT test failed: ${r.message}`, r.ok ? 'success' : 'error');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy('');
    }
  };
  const discovery = async () => {
    setBusy('discovery');
    try {
      const r = await smartHomeApi.publishDiscovery();
      data.setData((d) => (d ? { ...d, status: r.status } : d));
      toast.success(`Published ${r.entities} entities to Home Assistant`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy('');
    }
  };
  const addHook = async () => {
    setBusy('hook');
    try {
      const r = await smartHomeApi.addHaWebhook(haUrl, hookId);
      const t = await smartHomeApi.testHaWebhook(r.webhook.url);
      toast.show(t.ok ? 'Webhook added and Home Assistant answered the test' : `Webhook added, but the test failed: ${t.error ?? `HTTP ${t.status}`}`, t.ok ? 'success' : 'error');
      void api.admin.settings().catch(() => {});
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <AdminHeader help="admin-home-assistant"
        title="Smart home"
        subtitle="Connect Kinora to Home Assistant: now-playing sensors, a “someone is watching” switch for your lights, and playback events."
        actions={<button className="btn btn-primary" onClick={save} disabled={!dirty || busy === 'save'}>{busy === 'save' ? <Spinner size={18} /> : 'Save changes'}</button>}
      />

      <div className="settings-card">
        <h2><Icon name="zap" size={18} /> Home Assistant — MQTT</h2>
        {data.loading && !s ? <Skeleton h={260} /> : data.error ? <ErrorState message={data.error} onRetry={data.reload} /> : m && st ? (
          <>
            <dl className="kv-list">
              <dt>Connection</dt>
              <dd>
                <Badge tone={STATE_TONE[st.mqtt.state]}>{STATE_LABEL[st.mqtt.state]}</Badge>
                {st.mqtt.error && st.mqtt.state !== 'connected' && <span className="form-error">{st.mqtt.error}</span>}
                {st.mqtt.connectedAt && st.mqtt.state === 'connected' && <span className="muted">since {relativeTime(st.mqtt.connectedAt)}</span>}
              </dd>
              <dt>Entities</dt>
              <dd>{st.mqtt.entities ? `${st.mqtt.entities} announced${st.mqtt.lastDiscoveryAt ? ` · ${relativeTime(st.mqtt.lastDiscoveryAt)}` : ''}` : <span className="muted">None yet</span>}</dd>
              {st.mqtt.availabilityTopic && (<><dt>Availability topic</dt><dd><code>{st.mqtt.availabilityTopic}</code></dd></>)}
            </dl>
            <div className="form-grid">
              <Switch checked={m.enabled} onChange={(v) => setM({ enabled: v })} label="Publish to Home Assistant over MQTT"
                hint="Uses MQTT discovery, so entities appear in Home Assistant by themselves (Settings → Devices → MQTT). Needs the Mosquitto add-on or any MQTT broker." />
              <div className="form-row form-row-3">
                <Field label="Broker URL" hint="mqtt://host:1883, or mqtts://host:8883 for TLS.">
                  <input className="input mono" value={m.brokerUrl} onChange={(e) => setM({ brokerUrl: e.target.value })} placeholder="mqtt://192.168.1.10:1883" spellCheck={false} autoCapitalize="none" />
                </Field>
                <Field label="Username">
                  <input className="input" value={m.username ?? ''} onChange={(e) => setM({ username: e.target.value || null })} autoComplete="off" autoCapitalize="none" />
                </Field>
                <Field label="Password" hint={m.password === '••••' ? 'Saved — type to replace.' : undefined}>
                  <input className="input" type="password" value={m.password ?? ''} onFocus={(e) => m.password === '••••' && e.target.select()} onChange={(e) => setM({ password: e.target.value || null })} autoComplete="new-password" />
                </Field>
              </div>
              <div className="form-row">
                <Field label="Base topic" hint="Kinora publishes its states under this topic.">
                  <input className="input mono" value={m.baseTopic} onChange={(e) => setM({ baseTopic: e.target.value })} placeholder="mediamax" />
                </Field>
                <Field label="Discovery prefix" hint="Home Assistant’s default is homeassistant.">
                  <input className="input mono" value={m.discoveryPrefix} onChange={(e) => setM({ discoveryPrefix: e.target.value })} placeholder="homeassistant" />
                </Field>
              </div>
              <Switch checked={m.tls} onChange={(v) => setM({ tls: v })} label="Use TLS" hint="Always on for mqtts:// URLs." />
              {(m.tls || /^mqtts:/i.test(m.brokerUrl)) && <Switch checked={m.tlsInsecure} onChange={(v) => setM({ tlsInsecure: v })} label="Allow self-signed broker certificates" />}
              <Switch checked={m.perDeviceSensors} onChange={(v) => setM({ perDeviceSensors: v })} label="One “Now playing” sensor per device"
                hint="Each TV, phone or browser that plays something gets its own sensor (with title, series, poster, progress, transcode and HDR attributes)." />
              <div className="row-gap">
                <button className="btn" onClick={test} disabled={busy === 'test' || !m.brokerUrl}>{busy === 'test' ? <Spinner size={16} /> : <Icon name="zap" size={16} />} Test connection</button>
                <button className="btn" onClick={discovery} disabled={busy === 'discovery' || st.mqtt.state !== 'connected' || dirty}>{busy === 'discovery' ? <Spinner size={16} /> : <Icon name="refresh" size={16} />} Publish discovery now</button>
              </div>
            </div>
            <details>
              <summary>What Home Assistant gets</summary>
              <ul className="muted">
                <li><strong>Sensors:</strong> Active streams, Transcodes, Streaming bandwidth (kbit/s), Now playing (state playing / paused / idle with title, series, season, episode, poster, progress…), Recently added.</li>
                <li><strong>Binary sensor:</strong> Someone is watching (on while anything plays; off when paused or idle).</li>
                <li><strong>Per device:</strong> a Now playing sensor for each client, e.g. <code>sensor.living_room_tv_alice_now_playing</code>.</li>
                <li><strong>Button:</strong> Scan libraries. <strong>Event:</strong> Playback (started, paused, resumed, stopped, ended).</li>
                <li>Everything goes unavailable when Kinora stops (MQTT last will).</li>
              </ul>
            </details>
          </>
        ) : null}
      </div>

      <div className="settings-card">
        <h2><Icon name="link" size={18} /> Home Assistant — webhook (no MQTT needed)</h2>
        <p className="muted">Adds a webhook in Home Assistant’s format that calls your automation’s webhook trigger on play, pause, resume, stop and new media. Create an automation with a <em>Webhook</em> trigger using the ID below (example underneath), then click Add.</p>
        <div className="form-row">
          <Field label="Home Assistant URL">
            <input className="input mono" value={haUrl} onChange={(e) => setHaUrl(e.target.value)} placeholder="http://homeassistant.local:8123" spellCheck={false} autoCapitalize="none" />
          </Field>
          <Field label="Webhook ID">
            <input className="input mono" value={hookId} onChange={(e) => setHookId(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} />
          </Field>
        </div>
        <div className="row-gap">
          <button className="btn btn-primary" onClick={addHook} disabled={busy === 'hook' || !haUrl || !hookId}>{busy === 'hook' ? <Spinner size={16} /> : <Icon name="plus" size={16} />} Add Home Assistant webhook</button>
          <span className="muted">Manage it later under Server settings → Webhooks.</span>
        </div>
        <details>
          <summary>Example automation: dim the lights when a movie starts, raise them on pause</summary>
          <pre className="code-block"><code>{exampleAutomation(hookId)}</code></pre>
        </details>
      </div>

      <div className="settings-card guidance">
        <h2><Icon name="code" size={18} /> REST sensor &amp; dashboards</h2>
        <p className="muted">For Home Assistant’s REST sensor, Homepage or Homarr widgets: <code>GET {st?.restPath ?? '/api/v1/status/now-playing'}</code> with an API key (header <code>X-Api-Key</code>). Create a key under Settings → Security → API keys; an admin’s key sees every stream, other users only their own.</p>
        <pre className="code-block"><code>{`sensor:
  - platform: rest
    name: Kinora streams
    resource: ${location.origin}${st?.restPath ?? '/api/v1/status/now-playing'}
    headers: { X-Api-Key: !secret kinora_api_key }
    value_template: "{{ value_json.activeStreams }}"
    json_attributes: [watching, transcodes, bandwidthKbps, sessions]
    scan_interval: 30`}</code></pre>
      </div>
    </div>
  );
}
