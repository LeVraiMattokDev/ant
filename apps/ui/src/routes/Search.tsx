import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search as SearchIcon } from 'lucide-react';
import type { SearchResultDTO } from '@ant/shared';
import { parseSnippet } from '../lib/cache';
import { formatFull, formatShort } from '../lib/format';
import { useBotMap, useChannels, useSearch } from '../lib/queries';
import { Avatar, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui';

export function Snippet({ text }: { text: string }) {
  return (
    <>
      {parseSnippet(text).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

function resultLink(r: SearchResultDTO): string {
  const m = r.message;
  if (m.threadRootId) return `/c/${m.channelId}/t/${m.threadRootId}`;
  return `/c/${m.channelId}?m=${m.id}`;
}

/** "2025-03-01" (date input) → ISO at local midnight; `end` → end of that day. */
function dayToIso(day: string, end: boolean): string | undefined {
  if (!day) return undefined;
  const d = new Date(`${day}T${end ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const channelId = params.get('channel') ?? '';
  const botId = params.get('bot') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);

  const channels = useChannels();
  const bots = useBotMap();
  const search = useSearch({
    q,
    channelId: channelId || undefined,
    botId: botId || undefined,
    from: dayToIso(from, false),
    to: dayToIso(to, true),
  });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setParam('q', draft.trim());
  };

  const channelName = (id: string) => {
    const c = channels.data?.find((x) => x.id === id);
    if (!c) return '';
    if (c.kind === 'dm') return bots.get(c.dmBotId ?? '')?.name ?? c.name;
    return `#${c.name}`;
  };

  return (
    <>
      <PageHeader title="Recherche" description="Dans tous les messages, fils compris." />
      <div className="border-b border-line px-4 py-3 md:px-6">
        <form onSubmit={submit} role="search" className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" />
            <input
              type="search"
              className="input pl-8"
              placeholder="Rechercher des messages…"
              aria-label="Termes recherchés"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
            Rechercher
          </button>
        </form>
        <div className="mt-2 grid grid-cols-2 gap-2 md:flex md:flex-wrap">
          <select className="select md:w-48" aria-label="Filtrer par canal" value={channelId} onChange={(e) => setParam('channel', e.target.value)}>
            <option value="">Tous les canaux</option>
            {(channels.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {channelName(c.id)}
              </option>
            ))}
          </select>
          <select className="select md:w-44" aria-label="Filtrer par bot" value={botId} onChange={(e) => setParam('bot', e.target.value)}>
            <option value="">Tous les bots</option>
            {[...bots.values()].map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
            Du
            <input type="date" className="input md:w-40" value={from} max={to || undefined} onChange={(e) => setParam('from', e.target.value)} />
          </label>
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
            au
            <input type="date" className="input md:w-40" value={to} min={from || undefined} onChange={(e) => setParam('to', e.target.value)} />
          </label>
        </div>
      </div>

      <div className="scroll-y flex-1">
        {!q ? (
          <EmptyState title="Que cherches-tu ?">La recherche ignore les accents et reconnaît les formes d’un même mot (« relance », « relancer »).</EmptyState>
        ) : search.isPending ? (
          <LoadingBlock label="Recherche…" />
        ) : search.isError ? (
          <ErrorBlock error={search.error} onRetry={() => void search.refetch()} />
        ) : search.data.length === 0 ? (
          <EmptyState title="Aucun résultat">Essaie d’autres mots ou retire des filtres.</EmptyState>
        ) : (
          <>
            <div className="px-4 pt-3 text-[12px] text-subtle md:px-6">
              {search.data.length} résultat{search.data.length > 1 ? 's' : ''}
            </div>
            <ul className="divide-y divide-line">
              {search.data.map((r) => {
                const bot = r.message.botId ? bots.get(r.message.botId) : undefined;
                const author = r.message.authorKind === 'user' ? 'Toi' : r.message.authorKind === 'system' ? 'Système' : (bot?.name ?? 'Bot');
                return (
                  <li key={r.message.id}>
                    <Link to={resultLink(r)} className="flex gap-3 px-4 py-3 hover:bg-surface md:px-6">
                      {bot ? <Avatar emoji={bot.avatar} size="sm" /> : <span className="size-5 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                          <span className="font-semibold">{author}</span>
                          <span className="text-muted">{r.channelName}</span>
                          {r.message.threadRootId && <span className="text-subtle">dans un fil</span>}
                          <time className="text-subtle" dateTime={r.message.createdAt} title={formatFull(r.message.createdAt)}>
                            {formatShort(r.message.createdAt)}
                          </time>
                        </div>
                        <p className="mt-0.5 text-[13.5px] leading-relaxed">
                          <Snippet text={r.snippet} />
                        </p>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
