import { useEffect, useState, type ReactNode } from 'react';
import { get, post } from '../api.ts';
import type { PrereqCheck } from '../../../server/lib/prereqs.ts';
import type { SetupStatus } from '../../../server/setupRoute.ts';

/**
 * First run: until the setup page has been answered or skipped once, show it instead of the app. It asks for the repos and
 * worktrees folders and for whatever the active plugins marked `firstRun` (e.g. the Jira URL), and lists the tools the app
 * needs. One fetch on load, no polling; the tool checks run when the page opens. If the question can't be loaded the app
 * opens anyway (everything asked is also in Settings).
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SetupStatus | null | 'unknown'>(null);
  useEffect(() => {
    get<SetupStatus>('/api/setup').then(setStatus, () => setStatus('unknown'));
  }, []);
  if (status === null) return null;
  if (status === 'unknown' || !status.needed) return <>{children}</>;
  return <SetupPage status={status} onDone={() => setStatus('unknown')} />;
}

function SetupPage({ status, onDone }: { status: SetupStatus; onDone: () => void }) {
  const [reposDir, setRepos] = useState(status.reposDir);
  const [worktreesDir, setTrees] = useState(status.worktreesDir);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<PrereqCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [rebuild, setRebuild] = useState(false);
  const [enable, setEnable] = useState<Record<string, boolean>>({});
  const [offerAnswers, setOfferAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    get<{ checks: PrereqCheck[] }>('/api/setup/checks').then((r) => setChecks(r.checks), () => setChecks([]));
  }, []);

  const finish = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ restart?: boolean; rebuild?: boolean }>(path, body);
      if (r.restart) {
        // Some answers only apply after a restart: say so before the page goes away.
        setRestart(true);
        setRebuild(!!r.rebuild);
        setBusy(false);
      } else onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const save = () => {
    const values: Record<string, string> = {};
    for (const q of status.questions) for (const k of q.keys) if (answers[q.keys[0]]?.trim()) values[k] = answers[q.keys[0]];
    const on = status.offers.filter((o) => enable[o.id]);
    const offerValues: Record<string, string> = {};
    for (const o of on) if (o.ask && offerAnswers[o.ask.key]?.trim()) offerValues[o.ask.key] = offerAnswers[o.ask.key];
    return finish('/api/setup', { reposDir, worktreesDir, values, ...(on.length && { enable: on.map((o) => o.id), offerValues }) });
  };

  if (restart) {
    return (
      <div className="page narrow">
        <h2>Saved</h2>
        <p className="muted">
          {rebuild
            ? 'The plugins you turned on load after a rebuild and restart (pnpm build, then restart work-hub; scripts/update.sh --no-pull does both).'
            : 'Some of those only take effect after work-hub restarts.'}{' '}
          Folders and the rest apply now.
        </p>
        <button className="primary" onClick={onDone}>
          Open work-hub
        </button>
      </div>
    );
  }

  const folder = (label: string, help: string, value: string, set: (v: string) => void, locked: boolean, exists: boolean, willCreate: boolean) => (
    <div className="setting-field">
      <label>
        <div>{label}</div>
        <input type="text" value={value} disabled={busy || locked} spellCheck={false} onChange={(e) => set(e.target.value)} />
      </label>
      <div className="muted small-text">{help}</div>
      {locked && <div className="muted small-text">Fixed by an environment variable.</div>}
      {!locked && !exists && <div className="muted small-text">{willCreate ? "It doesn't exist yet; it will be created." : "That folder doesn't exist yet."}</div>}
    </div>
  );

  const problems = (checks ?? []).filter((c) => !c.ok);
  return (
    <div className="page narrow">
      <h2>Welcome</h2>
      <p className="muted">A few questions, once. Everything here can be changed later in Settings, and you can skip it to use the defaults.</p>

      {status.foldersOpen && (
        <>
          <h3>Where your code lives</h3>
          {folder('Repos folder', 'Where your repositories are cloned, one folder per repo.', reposDir, setRepos, status.locked.reposDir, status.reposExists, false)}
          {folder('Worktrees folder', 'Where new worktrees are created, as <folder>/<repo>/<ticket or short name>.', worktreesDir, setTrees, status.locked.worktreesDir, status.worktreesExists, true)}
        </>
      )}

      {status.questions.length > 0 && (
        <>
          <h3>Your tools</h3>
          {status.questions.map((q) => (
            <div className="setting-field" key={q.keys[0]}>
              <label>
                <div>
                  {q.label} <span className="muted small-text">· {q.from.join(', ')}{q.restart ? ' · needs a restart' : ''}</span>
                </div>
                <input
                  type="text"
                  value={answers[q.keys[0]] ?? ''}
                  placeholder={q.placeholder}
                  disabled={busy}
                  spellCheck={false}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.keys[0]]: e.target.value }))}
                />
              </label>
              {q.description && <div className="muted small-text">{q.description}</div>}
              <div className="muted small-text">Leave empty to skip.</div>
            </div>
          ))}
        </>
      )}

      {status.offers.length > 0 && (
        <>
          <h3>Extras</h3>
          {status.offers.map((o) => (
            <div className="setting-field" key={o.id}>
              <label className="setup-offer">
                <input type="checkbox" checked={!!enable[o.id]} disabled={busy} onChange={(e) => setEnable((m) => ({ ...m, [o.id]: e.target.checked }))} />
                <span>{o.label}</span>
              </label>
              {o.description && <div className="muted small-text">{o.description}</div>}
              {enable[o.id] && o.ask && (
                <label>
                  <div>{o.ask.label}</div>
                  <input
                    type="text"
                    value={offerAnswers[o.ask.key] ?? ''}
                    placeholder={o.ask.placeholder}
                    disabled={busy}
                    spellCheck={false}
                    onChange={(e) => setOfferAnswers((a) => ({ ...a, [o.ask!.key]: e.target.value }))}
                  />
                </label>
              )}
            </div>
          ))}
        </>
      )}

      <h3>This machine</h3>
      {checks === null ? (
        <div className="muted small-text">Checking…</div>
      ) : checks.length === 0 ? (
        <div className="muted small-text">Couldn't run the checks.</div>
      ) : (
        <ul className="setup-checks">
          {checks.map((c) => (
            <li key={c.id}>
              <span className={c.ok ? 'ok' : c.required ? 'bad' : 'warn'}>{c.ok ? '✓' : c.required ? '✗' : '!'}</span> {c.label}
              {!c.ok && <span className="muted small-text"> · {c.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {problems.some((c) => c.required) && <div className="muted small-text">Fix the ✗ items first; the app needs them.</div>}
      <p className="muted small-text">
        The app answers on this machine only, with no sign-in. To reach it from other devices, turn on the auth plugin with a hostname (<code>scripts/setup-lan.sh</code>; on Windows <code>scripts\windows\setup-lan.ps1</code>).
      </p>

      <div className="menu-row">
        <button className="primary" disabled={busy || (status.foldersOpen && (!reposDir.trim() || !worktreesDir.trim()))} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
        <button className="ghost" disabled={busy} onClick={() => void finish('/api/setup/skip', {})}>
          Skip for now
        </button>
        {error && <span className="bad">{error}</span>}
      </div>
    </div>
  );
}
