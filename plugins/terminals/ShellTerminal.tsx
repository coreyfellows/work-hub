import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export type ShellStatus = 'connecting' | 'live' | 'reconnecting' | 'failed' | 'exited';

export interface ShellHandle {
  send(data: string): void;
  focus(): void;
}

/**
 * One shell from the terminal daemon (termd.ts via /api/terms/:id/ws). On connect the daemon sends
 * the screen and scrollback first, so reloads and reconnects pick up where you left off; then live output.
 * Unlike the Claude session view, the scrollback lives here, so the wheel and touch drags scroll it.
 */
export const ShellTerminal = forwardRef<ShellHandle, { id: string; onStatus: (s: ShellStatus) => void; transformInput?: (d: string) => string }>(
  function ShellTerminal({ id, onStatus, transformInput }, ref) {
    const box = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const statusRef = useRef(onStatus);
    statusRef.current = onStatus;
    const xformRef = useRef(transformInput);
    xformRef.current = transformInput;

    const sendRaw = (d: string) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d }));
    };
    useImperativeHandle(ref, () => ({ send: sendRaw, focus: () => termRef.current?.focus() }));

    useEffect(() => {
      const el = box.current!;
      const term = new Terminal({
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        fontSize: 12.5,
        lineHeight: 1.15,
        scrollback: 5000,
        cursorBlink: true,
        theme: { background: '#0a0c0f', foreground: '#d8dee6', cursor: '#d8dee6', selectionBackground: '#2c5285' },
      });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }

      let disposed = false;
      let attempts = 0;
      let exited = false;
      let retry: ReturnType<typeof setTimeout> | undefined;

      const connect = () => {
        if (disposed) return;
        statusRef.current(attempts === 0 ? 'connecting' : 'reconnecting');
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/api/terms/${id}/ws?cols=${term.cols}&rows=${term.rows}`);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;
        let first = true;
        ws.onmessage = (e) => {
          if (typeof e.data === 'string') {
            if (e.data.includes('"exit"')) {
              exited = true;
              statusRef.current('exited');
            } else if (e.data.includes('"restarted"')) {
              exited = false;
              statusRef.current('live');
            }
            return;
          }
          if (first) {
            // The snapshot: the whole screen and scrollback, replacing whatever we showed before.
            first = false;
            attempts = 0;
            term.reset();
            if (!exited) statusRef.current('live');
          }
          term.write(new Uint8Array(e.data as ArrayBuffer));
        };
        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          if (disposed) return;
          attempts++;
          if (attempts > 8) return statusRef.current('failed');
          statusRef.current('reconnecting');
          retry = setTimeout(connect, Math.min(800 * attempts, 5000));
        };
      };

      const input = term.onData((d) => sendRaw(xformRef.current ? xformRef.current(d) : d));

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

      // Touch: a one-finger drag scrolls the scrollback (or, in full-screen apps like less/vim, sends wheel steps).
      let lastY = 0;
      let carry = 0;
      let moved = false;
      const lineH = () => el.clientHeight / Math.max(1, term.rows);
      const onStart = (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        lastY = e.touches[0].clientY;
        carry = 0;
        moved = false;
      };
      const onMove = (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        const y = e.touches[0].clientY;
        carry += y - lastY;
        lastY = y;
        if (Math.abs(carry) > 4) moved = true;
        if (!moved) return;
        e.preventDefault();
        e.stopPropagation();
        const step = lineH();
        while (Math.abs(carry) >= step) {
          const back = carry > 0; // finger down = look further back
          if (term.buffer.active.type === 'alternate') {
            sendRaw(`\x1b[<${back ? 64 : 65};${Math.ceil(term.cols / 2)};${Math.ceil(term.rows / 2)}M`);
          } else term.scrollLines(back ? -1 : 1);
          carry -= Math.sign(carry) * step;
        }
      };
      el.addEventListener('touchstart', onStart, { passive: true, capture: true });
      el.addEventListener('touchmove', onMove, { passive: false, capture: true });

      connect();
      return () => {
        disposed = true;
        el.removeEventListener('touchstart', onStart, { capture: true });
        el.removeEventListener('touchmove', onMove, { capture: true });
        clearTimeout(retry);
        clearTimeout(resizeTimer);
        ro.disconnect();
        input.dispose();
        wsRef.current?.close();
        term.dispose();
        termRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    return <div className="shell-term" ref={box} />;
  },
);
