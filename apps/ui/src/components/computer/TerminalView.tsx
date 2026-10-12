import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { backoffDelay, wsUrl } from '../../lib/ws';

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Shared terminal of the agents' computer. Typing is enabled only while the user holds control. */
export function TerminalView({ interactive }: { interactive: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      disableStdin: true,
      theme: {
        background: cssVar('--ant-bg', '#141518'),
        foreground: cssVar('--ant-fg', '#e9eaed'),
        cursor: cssVar('--ant-accent', '#e09a3e'),
        selectionBackground: 'rgba(224,154,62,0.3)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;

    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const decoder = new TextDecoder();

    const sendResize = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    const connect = () => {
      setStatus('connecting');
      const socket = new WebSocket(wsUrl('/api/computer/terminal'));
      socket.binaryType = 'arraybuffer';
      ws = socket;
      socket.onopen = () => {
        attempt = 0;
        setStatus('open');
        sendResize();
      };
      socket.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === 'string') term.write(ev.data);
        else if (ev.data instanceof ArrayBuffer) term.write(decoder.decode(ev.data));
      };
      socket.onclose = () => {
        setStatus('closed');
        if (!disposed) timer = setTimeout(connect, backoffDelay(attempt++));
      };
    };
    connect();

    const dataSub = term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResize();
      } catch {
        /* container hidden */
      }
    });
    ro.observe(el);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ro.disconnect();
      dataSub.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = !interactive;
    if (interactive) term.focus();
  }, [interactive]);

  return (
    <div className="flex h-full min-h-[280px] flex-col overflow-hidden rounded-[6px] border border-line bg-bg">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[12px] text-muted">
        <span className={status === 'open' ? 'text-success' : status === 'connecting' ? 'text-warning' : 'text-danger'}>●</span>
        {status === 'open' ? 'Terminal connecté' : status === 'connecting' ? 'Connexion…' : 'Déconnecté, nouvelle tentative…'}
        {!interactive && <span className="ml-auto text-subtle">Lecture seule : prends la main pour taper</span>}
      </div>
      <div ref={container} className="min-h-0 flex-1 p-2" aria-label="Terminal de l’ordinateur des agents" />
    </div>
  );
}
