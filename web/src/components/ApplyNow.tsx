import { useEffect, useState } from 'react';
import { get, post } from '../api.ts';
import { useToast } from './Toast.tsx';

/**
 * "Apply now" after a change that needs a rebuild and restart (Settings → Plugins, a setting marked `restart`):
 * `POST /api/server/apply` runs the rebuild as a job (the header tray shows it) and, when a supervisor (launchd, systemd,
 * the Windows task) will bring the server back, restarts it; open tabs then reload on the new build by themselves.
 * Without one it only rebuilds and says to restart by hand.
 */
export function ApplyNow({ what = 'Saved.' }: { what?: string }) {
  const { show } = useToast();
  const [supervised, setSupervised] = useState<boolean | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'started'>('idle');

  useEffect(() => {
    get<{ supervised: boolean; jobId: string | null }>('/api/server/apply').then(
      (r) => {
        setSupervised(r.supervised);
        if (r.jobId) setState('started');
      },
      () => setSupervised(false),
    );
  }, []);

  const apply = async () => {
    setState('busy');
    try {
      const r = await post<{ jobId: string; supervised: boolean }>('/api/server/apply', {});
      setState('started');
      show({ text: r.supervised ? 'Rebuilding; the server restarts when that is done and this page reloads.' : 'Rebuilding; restart the server when it is done.' });
    } catch (e) {
      setState('idle');
      show({ kind: 'error', text: `Couldn't apply: ${(e as Error).message}` });
    }
  };

  if (supervised === null) return <span className="muted small-text">{what}</span>;
  return (
    <span className="apply-now">
      <span className="muted small-text">
        {what}{' '}
        {state === 'started'
          ? supervised
            ? 'Applying: see the jobs tray; this page reloads when the server is back.'
            : 'Rebuilding: see the jobs tray, then restart the server.'
          : supervised
            ? 'It takes effect after a rebuild and restart.'
            : 'It takes effect after a rebuild and restart; nothing restarts this server automatically (it runs without launchd, systemd or a Windows task).'}
      </span>
      {state !== 'started' && (
        <button className="small" disabled={state === 'busy'} onClick={() => void apply()} title="Rebuild the web bundle and restart the server">
          {state === 'busy' ? 'Starting…' : supervised ? 'Apply now' : 'Rebuild now'}
        </button>
      )}
    </span>
  );
}
