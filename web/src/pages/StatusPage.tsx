import { Fragment, useEffect, useState } from 'react';
import { ago, get, type SourceState } from '../api.ts';
import type { Issue } from '../health.ts';
import { useSlot } from '../slots.ts';
import { mergeByOrder } from '../lib/slotOrder.ts';
import { RefreshButton, Row } from '../components/StatusRows.tsx';

/**
 * Connection health: what's wrong, the plugins, then the `status-block` slot's blocks (local checks, plugins' services…) and the
 * data sources. Slot blocks sort among the core's (Needs attention 10, Plugins 15, Data sources 40) by `order`.
 */
export function StatusPage({ sources, issues }: { sources: Record<string, SourceState>; issues: Issue[] }) {
  const blocks = useSlot('status-block');
  const core = [
    { order: 10, id: 'attention', node: <NeedsAttention issues={issues} /> },
    { order: 15, id: 'plugins', node: <PluginsBlock /> },
    { order: 40, id: 'sources', node: <DataSources sources={sources} /> },
  ];
  return (
    <div className="page">
      <div className="page-head">
        <h2>Status</h2>
      </div>
      {mergeByOrder(core, blocks).map((x) => {
        if (x.core) return <Fragment key={x.core.id}>{x.core.node}</Fragment>;
        const Block = x.slot!.component;
        return <Block key={`${x.slot!.plugin}:${x.slot!.id}`} sources={sources} issues={issues} />;
      })}
    </div>
  );
}

function NeedsAttention({ issues }: { issues: Issue[] }) {
  return (
    <section className="block">
      <h3>Needs attention</h3>
      {issues.length === 0 && <div className="ok">All good.</div>}
      {issues.map((i, n) => (
        <div key={n} className={`issue ${i.level}`}>
          <span className="issue-dot">{i.level === 'fire' ? '🔴' : '🟡'}</span>
          <div className="grow">
            {i.href && !i.action ? (
              <a href={i.href} target="_blank" rel="noreferrer">
                <b>{i.title}</b>
              </a>
            ) : (
              <b>{i.title}</b>
            )}
            <div className="muted small-text">{i.detail}</div>
          </div>
          {i.href && i.action && (
            <a className="button" href={i.href} target="_blank" rel="noreferrer">
              {i.action}
            </a>
          )}
        </div>
      ))}
    </section>
  );
}

function DataSources({ sources }: { sources: Record<string, SourceState> }) {
  return (
    <section className="block">
      <h3>Data sources</h3>
      {Object.values(sources).map((s) => (
        <Row
          key={s.id}
          ok={!s.error}
          label={s.title}
          detail={s.error ?? (s.updatedAt ? `updated ${ago(s.updatedAt)} ago` : s.loading ? 'loading…' : 'not fetched yet')}
          action={<RefreshButton id={s.id} loading={s.loading} />}
        />
      ))}
    </section>
  );
}

interface PluginsList {
  apiVersion: number;
  plugins: Array<{ manifest: { id: string; title: string }; official: boolean; status: 'active' | 'disabled' | 'replaced' | 'skipped'; reason?: string; replacedBy?: string }>;
  errors: string[];
}

/** Every plugin found and what became of it (loaded once per visit; it only changes on a restart). */
function PluginsBlock() {
  const [list, setList] = useState<PluginsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<PluginsList>('/api/plugins').then(setList, (e) => setError((e as Error).message));
  }, []);
  return (
    <section className="block">
      <div className="block-head">
        <h3>Plugins</h3>
        {list && <span className="muted small-text">plugin API v{list.apiVersion}</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {list?.errors.map((e, i) => (
        <div key={i} className="error">
          {e}
        </div>
      ))}
      {list && list.plugins.length === 0 && <div className="muted">No plugins found.</div>}
      {list?.plugins.map((p) => (
        <div key={`${p.manifest.id}:${p.official}`} className="status-row">
          <span className={`tag plugin-status plugin-${p.status}`}>{p.status}</span>
          <span className="label">{p.manifest.title}</span>
          <span className="muted small-text grow">
            {p.official ? 'official' : 'local'}
            {p.replacedBy ? ` · replaced by ${p.replacedBy}` : ''}
            {p.reason ? ` · ${p.reason}` : ''}
          </span>
        </div>
      ))}
    </section>
  );
}
