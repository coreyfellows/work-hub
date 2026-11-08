import { groupPlugins } from '../lib/pluginGroups.ts';
import { ApplyNow } from '../components/ApplyNow.tsx';
import { useEffect, useState } from 'react';
import { get, post } from '../api.ts';
import { setLowData, useLowData } from '../lowData.ts';
import { RECENT_IDLE_CHOICES, setRecentIdleMs, useRecentIdleMs } from '../recentIdle.ts';
import { useSlot } from '../slots.ts';
import { mergeByOrder } from '../lib/slotOrder.ts';
import type { SettingsPayload } from '../../../server/settings.ts';
import { Link } from '../router.tsx';
import { SettingsGroupForm } from './AppSettings.tsx';

/**
 * Settings: the core's sections (Workspaces, Data, Plugins), the app's own features' (Sessions, App rules, Health) and the
 * `settings-section` items marked `scope: 'app'`, sorted by `order`. A plugin's own settings are on its page
 * (`/settings/plugins/<id>`, linked from its row under Plugins).
 */
export function SettingsPage() {
  const items = useSlot('settings-section').filter((i) => i.scope === 'app');
  // The app's own settings and the ones plugins declare: one section each, from `GET /api/settings`.
  const [app, setApp] = useState<SettingsPayload | null>(null);
  useEffect(() => {
    get<SettingsPayload>('/api/settings').then(setApp, () => {});
  }, []);
  const core = [
    { order: 20, id: 'workspaces', title: 'Workspaces', node: <RecentIdleSetting /> },
    { order: 30, id: 'data', title: 'Data', node: <LowDataSetting /> },
    ...(app?.groups ?? []).filter((g) => g.builtin).map((g) => ({ order: g.order, id: `app-${g.id}`, title: g.title, node: <SettingsGroupForm group={g} onSaved={setApp} /> })),
    { order: 60, id: 'plugins', title: 'Plugins', node: <PluginsSetting groups={app?.groups ?? []} /> },
  ];
  return (
    <div className="page narrow">
      <h2>Settings</h2>
      {mergeByOrder(core, items).map((x) => {
        if (x.core) {
          return (
            <section key={x.core.id} className="block">
              <h3>{x.core.title}</h3>
              {x.core.node}
            </section>
          );
        }
        const Section = x.slot!.component;
        return (
          <section key={`${x.slot!.plugin}:${x.slot!.id}`} className="block">
            {x.slot!.title && <h3>{x.slot!.title}</h3>}
            <Section />
          </section>
        );
      })}
    </div>
  );
}

export interface PluginInfo {
  manifest: { id: string; title: string; description?: string; aliases?: string[] };
  official: boolean;
  dir: string;
  status: 'active' | 'disabled' | 'replaced' | 'skipped';
  reason?: string;
  replacedBy?: string;
}
export interface PluginsList {
  apiVersion: number;
  plugins: PluginInfo[];
  errors: string[];
}
interface PluginsConfigBody {
  local: string[];
  enabled: Record<string, boolean>;
}

/**
 * Every plugin found (`GET /api/plugins`) with an on/off switch, and the local plugin folders. Save sends the local list
 * and the switches you changed (`POST /api/plugins/config`, merged into plugins.json); it applies after a restart and
 * rebuild.
 */
function PluginsSetting({ groups }: { groups: SettingsPayload['groups'] }) {
  const sections = useSlot('settings-section');
  const actions = useSlot('plugins-action');
  // A plugin has a settings page when it declares settings or contributes a section (its own, not the app's).
  const hasSettings = (id: string) => groups.some((g) => g.id === id && !g.builtin) || sections.some((s) => s.plugin === id && s.scope !== 'app');
  const [list, setList] = useState<PluginsList | null>(null);
  const [cfg, setCfg] = useState<PluginsConfigBody | null>(null);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [local, setLocal] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    Promise.all([get<PluginsList>('/api/plugins'), get<PluginsConfigBody>('/api/plugins/config')]).then(
      ([l, c]) => {
        setList(l);
        setCfg(c);
        setEnabled(c.enabled);
        setLocal(c.local.join('\n'));
      },
      (e) => setMsg({ ok: false, text: (e as Error).message }),
    );
  }, []);

  if (!list || !cfg) return msg ? <div className="bad">{msg.text}</div> : <div className="muted">Loading…</div>;
  // On unless switched off (or its saved switch/default says so): what the switch shows before you touch it.
  const isOn = (p: PluginInfo) => enabled[p.manifest.id] ?? (p.status === 'active' || p.status === 'replaced');
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body: PluginsConfigBody = {
        local: local
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        // Only the switches you changed: a stored switch for a plugin that's gone is left alone (and can't block the save).
        enabled: Object.fromEntries(Object.entries(enabled).filter(([id, on]) => cfg.enabled[id] !== on)),
      };
      const next = await post<PluginsConfigBody>('/api/plugins/config', body);
      setCfg(next);
      setEnabled(next.enabled);
      setLocal(next.local.join('\n'));
      setMsg({ ok: true, text: 'Saved.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const renderRow = (p: PluginInfo) => (
    <div key={`${p.dir}:${p.manifest.id}`} className="menu-row plugin-row">
      <label className="readable-toggle grow">
        <input
          type="checkbox"
          checked={isOn(p)}
          disabled={p.status === 'skipped' || busy}
          onChange={(e) => setEnabled((cur) => ({ ...cur, [p.manifest.id]: e.target.checked }))}
        />
        <span>
          <b>{p.manifest.title}</b>
          {p.manifest.description && <div className="muted small-text">{p.manifest.description}</div>}
          {p.status !== 'active' && (
            <div className={`small-text ${p.status === 'skipped' ? 'bad' : 'muted'}`}>
              {p.status}
              {p.replacedBy ? ` by ${p.replacedBy}` : ''}
              {p.reason ? `: ${p.reason}` : ''}
            </div>
          )}
        </span>
      </label>
      {p.status === 'active' && hasSettings(p.manifest.id) && (
        <Link to={`/settings/plugins/${encodeURIComponent(p.manifest.id)}`} className="plugin-settings-link">
          Settings
        </Link>
      )}
    </div>
  );
  const pluginGroups = groupPlugins(list.plugins, cfg.local);
  return (
    <>
      {actions.length > 0 && (
        <div className="plugins-actions">
          {actions.map((a) => (
            <a.component key={`${a.plugin}:${a.id}`} />
          ))}
        </div>
      )}
      {list.errors.map((e, i) => (
        <div key={i} className="bad small-text">
          {e}
        </div>
      ))}
      {list.plugins.length === 0 && <div className="muted">No plugins found.</div>}
      {pluginGroups.map((g) => (
        <section key={g.key} className="plugin-group">
          <h4 className="plugin-group-title">
            {g.title}
            {g.detail && <span className="muted small-text plugin-group-detail"> {g.detail}</span>}
            <span className="muted small-text"> · {g.plugins.length}</span>
          </h4>
          {g.plugins.length === 0 && <div className="muted small-text">No plugins found here.</div>}
          {g.plugins.map(renderRow)}
        </section>
      ))}
      <label className="plugins-local">
        <span className="muted small-text">Local plugin folders (one absolute path per line: a plugin, or a folder of plugins)</span>
        <textarea rows={3} value={local} onChange={(e) => setLocal(e.target.value)} placeholder="/path/to/my-plugins" disabled={busy} spellCheck={false} />
      </label>
      <div className="menu-row">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {msg && (msg.ok ? <ApplyNow what={msg.text} /> : <span className="bad">{msg.text}</span>)}
      </div>
    </>
  );
}

function RecentIdleSetting() {
  const ms = useRecentIdleMs();
  return (
    <>
      <div className="menu-row" style={{ flexWrap: 'wrap' }}>
        <span className="grow">Call idle workspaces and sessions “warm” for</span>
        <div className="seg small-seg">
          {RECENT_IDLE_CHOICES.map(([value, label]) => (
            <button key={value} className={ms === value ? 'on' : ''} onClick={() => setRecentIdleMs(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="muted">After that they move down to “Idle for a while” on the front page, and their badges go back to “idle”. Applies on this device.</div>
    </>
  );
}

function LowDataSetting() {
  const on = useLowData();
  return (
    <>
      <label className="readable-toggle">
        <input type="checkbox" checked={on} onChange={(e) => setLowData(e.target.checked)} />
        Low data (for cellular), on this device
      </label>
      <p className="muted">Live terminal off by default, slower status updates, Diff/PR/Checks refresh on tap.</p>
    </>
  );
}
