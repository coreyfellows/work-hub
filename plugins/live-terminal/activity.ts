import { useEffect, useRef, useState } from 'react';
import { get, type Working } from '../../plugin-api/web.ts';
import { changeSize, readScreenText } from './screenText.ts';

function readScreen(html: string): { lines: string[]; quip: string } {
  const el = document.createElement('div');
  el.innerHTML = html;
  return readScreenText(el.textContent ?? '');
}

/**
 * While Claude works, the Chat view's pending bubble shows a quip (Claude's spinner word, off its screen) animating at
 * the pace the terminal is changing: the screen is polled every 1.5s and each poll's change size feeds a smoothed level.
 * The core turns it off (`enabled` false) in low data, for interactive sessions and while the Terminal view shows.
 */
export function useScreenActivity(sessionId: string, enabled: boolean): Working {
  const [activity, setActivity] = useState<Working>({ quip: '', level: 0 });
  const lastScreen = useRef<string[] | null>(null);
  useEffect(() => {
    lastScreen.current = null;
    if (!enabled) {
      setActivity({ quip: '', level: 0 });
      return;
    }
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const r = await get<{ html: string }>(`/api/sessions/${sessionId}/screen?lines=40`);
        if (!alive) return;
        const { lines, quip } = readScreen(r.html);
        const prev = lastScreen.current;
        lastScreen.current = lines;
        const change = prev ? Math.min(1, changeSize(prev, lines) / 240) : 0.3;
        setActivity((a) => ({ quip, level: a.level * 0.35 + change * 0.65 }));
      } catch {
        /* the animation just keeps its last pace */
      }
    };
    void load();
    const t = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled, sessionId]);
  return activity;
}
