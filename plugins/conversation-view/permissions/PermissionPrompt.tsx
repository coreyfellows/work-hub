import { useCallback, useEffect, useState } from 'react';
import { get, post, useLowData, useToast, type ComposerAddonProps } from '../../../plugin-api/web.ts';
import type { PermissionPrompt } from './prompt.ts';

/** The `composer-addon` item: Claude's tool-permission menu as a card above the prompt box, one button per choice. */
export function PermissionAddon({ session, sessionId }: ComposerAddonProps) {
  const waiting = session.kind === 'background' && session.waitingFor === 'permission prompt';
  const low = useLowData();
  const toast = useToast();
  const [prompt, setPrompt] = useState<PermissionPrompt | null>(null);
  const [rule, setRule] = useState<string | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await get<{ prompt: PermissionPrompt | null; rule?: string | null }>(`/api/sessions/${sessionId}/permission`);
      setPrompt(r.prompt);
      setRule(r.rule ?? null);
    } catch {
      /* keep what's shown; the next poll retries */
    }
  }, [sessionId]);

  // Loaded when the menu appears, then re-read while it's up: a second prompt can follow the first with no status change.
  useEffect(() => {
    if (!waiting) {
      setPrompt(null);
      setSending(null);
      setError(null);
      return;
    }
    void load();
    const t = setInterval(() => void load(), low ? 15_000 : 4_000);
    return () => clearInterval(t);
  }, [waiting, load, low]);

  if (!waiting || !prompt) return null;

  const pick = async (o: PermissionPrompt['options'][number], always = false) => {
    setSending(always ? -o.n : o.n);
    setError(null);
    try {
      const r = await post<{ rule?: string; added?: boolean }>(`/api/sessions/${sessionId}/permission`, { option: o.n, label: o.label, ...(always ? { always: true } : {}) });
      if (always && r.rule) {
        toast.show({ text: r.added ? `Always allowed: ${r.rule}` : `Already allowed: ${r.rule}` });
      }
      setPrompt(null);
      setTimeout(() => void load(), 1500);
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setSending(null);
    }
  };

  return (
    <div className="qform-slot">
      <div className="permform" role="group" aria-label="Permission request">
        <div className="qform-title">Claude wants permission{prompt.title ? ` · ${prompt.title}` : ''}</div>
        {prompt.body.length > 0 && <pre className="permform-body">{prompt.body.join('\n')}</pre>}
        <div className="permform-q">{prompt.question}</div>
        <div className="permform-options">
          {prompt.options.map((o) => (
            <button
              key={o.n}
              type="button"
              className={o.n === 1 ? 'primary' : /^no\b/i.test(o.label) ? 'danger' : ''}
              disabled={sending !== null}
              onClick={() => void pick(o)}
            >
              {sending === o.n ? 'Sending…' : o.label}
            </button>
          ))}
          {rule && (
            <button type="button" disabled={sending !== null} title={`Say yes, and add ${rule} to Settings → Session permissions, so sessions started from now on don't ask`} onClick={() => void pick(prompt.options[0], true)}>
              {sending !== null && sending < 0 ? 'Saving…' : <>Yes, always allow <code>{rule.replace(/^Bash\(|\)$/g, '')}</code></>}
            </button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
