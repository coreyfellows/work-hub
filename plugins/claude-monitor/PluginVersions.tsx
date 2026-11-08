import { useEffect, useState } from 'react';
import { AsOf, get, Link, post, useSource } from '../../plugin-api/web.ts';
import { API, SOURCE_ID, type MonitorData, type PluginRow } from './types.ts';
import { openWhatsNew } from './WhatsNew.tsx';

const ACTION: Record<string, string> = { seen: 'first seen', skipped: 'skipped', updating: 'update started' };

/** The plugin's settings page: the versions it knows, and the version each plugin was last looked at for. */
export function PluginVersions() {
  const data = useSource<MonitorData>(SOURCE_ID)?.data ?? null;
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    get<{ plugins: PluginRow[] }>(`${API}/plugins`).then((r) => setRows(r.plugins), () => setRows([]));
  }, [data?.analysis.status]);

  const check = async () => {
    setChecking(true);
    await post(`${API}/check`, {}).catch(() => {});
    setChecking(false);
  };

  return (
    <div className="cm-settings">
      <div className="cm-row">
        <span className="grow">
          Installed <strong>{data?.installed ?? 'unknown'}</strong> · {data?.channel ?? 'latest'} on npm <strong>{data?.latest ?? 'not checked yet'}</strong>
          {data?.checkError ? <span className="error"> · {data.checkError}</span> : null}
        </span>
        <AsOf at={data?.checkedAt ?? null} onRefresh={check} busy={checking} />
        <button onClick={openWhatsNew}>What's new</button>
      </div>
      <p className="muted">
        Suggestions for a plugin only cover Claude Code versions newer than its baseline: the newer of its plugin.json <code>claudeVersion</code> (set by an
        update session) and what's recorded here.
      </p>
      <div className="cm-table-wrap">
        <table className="cm-table">
          <thead>
            <tr>
              <th>Plugin</th>
              <th>Baseline</th>
              <th>plugin.json</th>
              <th>Recorded here</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id}>
                <td>
                  {r.title} <span className="muted">{r.kind === 'local' ? 'local' : ''}</span>
                </td>
                <td>{r.baseline ?? '—'}</td>
                <td>{r.manifestVersion ?? '—'}</td>
                <td>
                  {r.record ? (
                    <>
                      {r.record.version} {ACTION[r.record.action] ?? r.record.action}
                      {r.record.workspaceId ? (
                        <>
                          {' '}
                          <Link to={`/workspaces/${r.record.workspaceId}`}>workspace</Link>
                        </>
                      ) : null}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
