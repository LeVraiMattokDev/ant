import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type RFB from '@novnc/novnc';
import { backoffDelay, wsUrl } from '../../lib/ws';
import { Spinner } from '../ui';
import { confirmSessionEnded } from './session';

type VncState = 'connecting' | 'connected' | 'disconnected' | 'expired';

/** Live screen of the agents' computer. View-only unless the user holds control. */
export function VncScreen({ interactive }: { interactive: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const interactiveRef = useRef(interactive);
  const qc = useQueryClient();
  const [state, setState] = useState<VncState>('connecting');
  const [error, setError] = useState<string | null>(null);

  interactiveRef.current = interactive;

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      if (cancelled || !container.current) return;
      setState('connecting');
      let RFBClass: typeof RFB;
      try {
        RFBClass = (await import('@novnc/novnc')).default;
      } catch {
        setError('Impossible de charger le client VNC.');
        setState('disconnected');
        return;
      }
      if (cancelled || !container.current) return;
      const rfb = new RFBClass(container.current, wsUrl('/api/computer/vnc'), { shared: true });
      rfb.viewOnly = !interactiveRef.current;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.background = 'transparent';
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 2;
      rfbRef.current = rfb;

      rfb.addEventListener('connect', () => {
        attempt = 0;
        setError(null);
        setState('connected');
      });
      rfb.addEventListener('disconnect', (e) => {
        rfbRef.current = null;
        if (cancelled) return;
        setState('disconnected');
        const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
        if (!clean) setError('Connexion à l’écran perdue.');
        // noVNC does not expose the close code: the session may have ended (4401). The server tells, before a retry.
        void confirmSessionEnded(qc).then((ended) => {
          if (cancelled) return;
          if (ended) setState('expired');
          else timer = setTimeout(() => void connect(), backoffDelay(attempt++));
        });
      });
      rfb.addEventListener('securityfailure', () => setError('Le serveur VNC a refusé la connexion.'));
    };

    void connect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, []);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = !interactive;
    if (interactive) rfb.focus();
  }, [interactive, state]);

  return (
    <div className="relative h-full min-h-[280px] w-full overflow-hidden rounded-[12px] border border-line bg-black">
      <div ref={container} className="absolute inset-0" aria-label="Écran de l’ordinateur des agents" role="img" />
      {state !== 'connected' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg/80 text-[13px] text-muted">
          {state === 'connecting' ? (
            <>
              <Spinner />
              Connexion à l’écran…
            </>
          ) : state === 'expired' ? (
            <span>Session expirée : reconnecte-toi.</span>
          ) : (
            <>
              <span>{error ?? 'Écran déconnecté.'}</span>
              <span className="text-[12px] text-subtle">Nouvelle tentative automatique…</span>
            </>
          )}
        </div>
      )}
      {state === 'connected' && !interactive && (
        <div className="pointer-events-none absolute top-2 left-2 rounded-[8px] bg-black/60 px-2 py-0.5 text-[11.5px] text-white/85">
          Lecture seule : prends la main pour interagir
        </div>
      )}
    </div>
  );
}
