import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { get, useLowData, type SessionViewProps } from '../../plugin-api/web.ts';
import { LiveTerminal, type LiveHandle, type LiveStatus } from './LiveTerminal.tsx';

/** How often the snapshot is re-read in low-data mode (normally 1.5s for background jobs, 5s for interactive sessions). */
const LOW_DATA_POLL_MS = 10_000;

/** What the prompt box's key buttons type into the live terminal. */
const KEY_BYTES: Record<string, string> = {
  Enter: '\r',
  Escape: '\x1b',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Tab: '\t',
  'S-Tab': '\x1b[Z',
  'C-X-C-S': '\x18\x13', // Claude Code: send queued messages now
};

/**
 * The Terminal view: the live terminal for background jobs (snapshot fallback for interactive sessions, or if live
 * fails). It stays mounted (and connected) while another view shows, so switching back is instant, and while live it
 * takes the prompt box's text and keys (its input sink). Low data: it waits for "▶ Go live" (per visit) and the
 * snapshot is only polled while this view shows.
 */
export function TerminalView({ session, sessionId, visible, registerInput, viewHeight, setLiveStatus, stickToBottom }: SessionViewProps) {
  const canDrive = session.kind === 'background';
  const lowData = useLowData();
  const [goLive, setGoLive] = useState(false);
  useEffect(() => setGoLive(false), [sessionId]);
  const liveAllowed = canDrive && (!lowData || goLive);
  const [liveStatus, setStatus] = useState<LiveStatus>('connecting');
  // Background jobs get the live terminal; snapshots are the fallback (interactive sessions, or if live fails).
  const useSnapshot = !liveAllowed || liveStatus === 'failed';
  useLayoutEffect(() => setLiveStatus(useSnapshot ? null : liveStatus), [setLiveStatus, useSnapshot, liveStatus]);
  useLayoutEffect(() => () => setLiveStatus(null), [setLiveStatus]);

  const liveRef = useRef<LiveHandle>(null);
  useEffect(() => {
    registerInput({
      send: (text) => liveRef.current?.send(text) ?? false,
      key: (k) => liveRef.current?.send(KEY_BYTES[k] ?? k) ?? false,
    });
    return () => registerInput(null);
  }, [registerInput]);

  const [screen, setScreen] = useState('');
  const [screenSource, setScreenSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Low data only (so with it off, switching views doesn't restart the snapshot poll).
  const snapshotHidden = lowData && !visible;
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        // Server-built, HTML-escaped spans (see server/lib/termhtml.ts).
        const r = await get<{ html: string; source: string }>(`/api/sessions/${sessionId}/screen?lines=300`);
        if (!alive) return;
        setScreen(r.html);
        setScreenSource(r.source);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    if (!useSnapshot) return;
    if (snapshotHidden) return; // low data: only while the snapshot is showing
    void load();
    const t = setInterval(load, lowData ? LOW_DATA_POLL_MS : canDrive ? 1500 : 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId, canDrive, useSnapshot, lowData, snapshotHidden]);
  useEffect(() => stickToBottom(), [screen, stickToBottom]);

  return (
    <>
      {visible && canDrive && !liveAllowed && (
        <button className="go-live" onClick={() => setGoLive(true)} title="Low data is on: the live terminal streams every redraw">
          ▶ Go live
        </button>
      )}
      {visible &&
        useSnapshot &&
        (screen ? (
          <pre className="screen" dangerouslySetInnerHTML={{ __html: screen }} />
        ) : (
          <pre className="screen">{screenSource === 'none' ? 'No live screen for interactive sessions; see the Log tab.' : 'Loading…'}</pre>
        ))}
      {visible && useSnapshot && error && <div className="error">{error}</div>}
      {!useSnapshot && (
        <div style={{ display: visible ? 'block' : 'none' }}>
          <LiveTerminal ref={liveRef} sessionId={sessionId} height={viewHeight} onStatus={setStatus} />
        </div>
      )}
    </>
  );
}
