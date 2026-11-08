import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'failed' | 'ended';

export interface LiveHandle {
  /** Type into the session; false if the live connection isn't open. */
  send(data: string): boolean;
}

/**
 * A real terminal attached to a background session over a WebSocket (live.ts): output streams
 * in as it happens, and keystrokes go straight to Claude. Sized to its container; the server resizes
 * the attach to match. Claude runs full-screen with mouse reporting on, so the wheel goes to Claude and
 * scrolls its own view of the whole conversation (shared by every viewer of the session).
 */
export const LiveTerminal = forwardRef<LiveHandle, { sessionId: string; height: number; onStatus: (s: LiveStatus) => void }>(
  function LiveTerminal({ sessionId, height, onStatus }, ref) {
    const box = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const statusRef = useRef(onStatus);
    statusRef.current = onStatus;

    useImperativeHandle(ref, () => ({
      send(data: string) {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify({ t: 'in', d: data }));
        return true;
      },
    }));

    useEffect(() => {
      const el = box.current!;
      const term = new Terminal({
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        fontSize: 12,
        lineHeight: 1.15,
        scrollback: 0,
        cursorBlink: true,
        theme: { background: '#0a0c0f', foreground: '#d8dee6', cursor: '#d8dee6', selectionBackground: '#2c5285' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fitRef.current = fit;
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }

      let disposed = false;
      let attempts = 0;
      let retry: ReturnType<typeof setTimeout> | undefined;

      const connect = () => {
        if (disposed) return;
        statusRef.current(attempts === 0 ? 'connecting' : 'reconnecting');
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/api/sessions/${sessionId}/term?cols=${term.cols}&rows=${term.rows}`);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;
        let ended = false;
        ws.onopen = () => {
          attempts = 0;
          term.reset();
          statusRef.current('live');
        };
        ws.onmessage = (e) => {
          if (typeof e.data === 'string') {
            if (e.data.includes('"exit"')) ended = true;
            return;
          }
          term.write(new Uint8Array(e.data as ArrayBuffer));
        };
        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          if (disposed) return;
          if (ended) return statusRef.current('ended');
          attempts++;
          if (attempts > 5) return statusRef.current('failed');
          statusRef.current('reconnecting');
          retry = setTimeout(connect, Math.min(1000 * attempts, 5000));
        };
      };

      const input = term.onData((d) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d }));
      });

      let lastSize = `${term.cols}x${term.rows}`;
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            fit.fit();
          } catch {
            return;
          }
          const size = `${term.cols}x${term.rows}`;
          if (size === lastSize) return;
          lastSize = size;
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
        }, 150);
      });
      ro.observe(el);

      // Touch: a finger drag scrolls Claude's view (xterm only turns *wheel* input into mouse events).
      // Every ~16px of drag sends one wheel step at the middle of the screen; a flick keeps going briefly.
      const wheel = (up: boolean) => {
        const ws = wsRef.current;
        if (ws?.readyState !== WebSocket.OPEN) return;
        const col = Math.max(1, Math.floor(term.cols / 2));
        const row = Math.max(1, Math.floor(term.rows / 2));
        ws.send(JSON.stringify({ t: 'in', d: `\x1b[<${up ? 64 : 65};${col};${row}M` }));
      };
      const STEP = 16;
      let lastY = 0;
      let carry = 0;
      let moved = false;
      let velocity = 0;
      let lastT = 0;
      let inertia: ReturnType<typeof setInterval> | undefined;
      const onStart = (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        clearInterval(inertia);
        lastY = e.touches[0].clientY;
        lastT = performance.now();
        carry = 0;
        velocity = 0;
        moved = false;
      };
      const onMove = (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        const y = e.touches[0].clientY;
        const now = performance.now();
        const dy = y - lastY;
        velocity = dy / Math.max(1, now - lastT);
        lastY = y;
        lastT = now;
        carry += dy;
        if (Math.abs(carry) > 4) moved = true;
        if (moved) {
          e.preventDefault(); // no page scroll/bounce while dragging the terminal
          e.stopPropagation(); // and keep xterm from scrolling its own (empty) buffer
        }
        while (Math.abs(carry) >= STEP) {
          wheel(carry > 0); // finger moving down = look further back
          carry -= Math.sign(carry) * STEP;
        }
      };
      const onEnd = () => {
        if (!moved || Math.abs(velocity) < 0.4) return;
        let v = velocity; // px/ms; decays to a stop
        inertia = setInterval(() => {
          wheel(v > 0);
          v *= 0.85;
          if (Math.abs(v) < 0.25) clearInterval(inertia);
        }, 45);
      };
      el.addEventListener('touchstart', onStart, { passive: true, capture: true });
      el.addEventListener('touchmove', onMove, { passive: false, capture: true });
      el.addEventListener('touchend', onEnd, { passive: true, capture: true });

      connect();
      return () => {
        disposed = true;
        clearInterval(inertia);
        el.removeEventListener('touchstart', onStart, { capture: true });
        el.removeEventListener('touchmove', onMove, { capture: true });
        el.removeEventListener('touchend', onEnd, { capture: true });
        clearTimeout(retry);
        clearTimeout(resizeTimer);
        ro.disconnect();
        input.dispose();
        wsRef.current?.close();
        term.dispose();
      };
    }, [sessionId]);

    const press = (seq: string) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d: seq }));
    };
    return (
      <div className="live-wrap" style={{ height }}>
        <div className="live-term" ref={box} />
        <div className="scroll-ctl" aria-label="Scroll the session">
          <button title="Page up (scroll back)" onClick={() => press('\x1b[5~')}>
            ⇞
          </button>
          <button title="Page down" onClick={() => press('\x1b[6~')}>
            ⇟
          </button>
          <button title="Jump to the latest output" onClick={() => press('\x1b[1;5F')}>
            ⤓
          </button>
        </div>
      </div>
    );
  },
);
