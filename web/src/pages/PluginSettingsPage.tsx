import { useEffect, useState } from 'react';
import type { SettingsPayload } from '../../../server/settings.ts';
import { get } from '../api.ts';
import { Link } from '../router.tsx';
import { useSlot } from '../slots.ts';
import { SettingsGroupForm } from './AppSettings.tsx';
import type { PluginsList } from './SettingsPage.tsx';

/**
 * One plugin's settings (`/settings/plugins/<id>`, linked from its row under Settings → Plugins): the settings its
 * manifest declares, then the sections it contributes to the `settings-section` slot (its own UI, e.g. menagerie's
 * cast editor).
 */
export function PluginSettingsPage({ id }: { id: string }) {
  const sections = useSlot('settings-section')
    .filter((s) => s.plugin === id && s.scope !== 'app')
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const [app, setApp] = useState<SettingsPayload | null>(null);
  const [plugins, setPlugins] = useState<PluginsList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    get<SettingsPayload>('/api/settings').then(setApp, (e: Error) => setFailed(e.message));
    get<PluginsList>('/api/plugins').then(setPlugins, (e: Error) => setFailed(e.message));
  }, []);

  const info = plugins?.plugins.find((p) => p.manifest.id === id);
  const group = app?.groups.find((g) => g.id === id && !g.builtin);
  const loading = !failed && (!app || !plugins);
  const nothing = !loading && !group && sections.length === 0;

  return (
    <div className="page narrow">
      <Link to="/settings" className="back">
        ← Settings
      </Link>
      <h2>{info?.manifest.title ?? id}</h2>
      {info?.manifest.description && <div className="muted">{info.manifest.description}</div>}
      {failed && <div className="bad small-text">{failed}</div>}
      {loading && <div className="muted">Loading…</div>}
      {info && info.status !== 'active' && <div className="muted">This plugin is {info.status}{info.reason ? `: ${info.reason}` : ''}. Its settings show here while it is on.</div>}
      {group && (
        <section className="block">
          <SettingsGroupForm group={{ ...group, description: undefined }} onSaved={setApp} />
        </section>
      )}
      {sections.map((s) => {
        const Section = s.component;
        return (
          <section key={s.id} className="block">
            {s.title && <h3>{s.title}</h3>}
            <Section />
          </section>
        );
      })}
      {nothing && <div className="muted">This plugin has no settings.</div>}
    </div>
  );
}
