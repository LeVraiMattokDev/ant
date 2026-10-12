import { useState } from 'react';
import { ChevronRight, Download, File, Folder, RefreshCw } from 'lucide-react';
import { WORKSPACE_ROOT } from '@ant/shared';
import { buildUrl } from '../../lib/api';
import { formatBytes, formatShort } from '../../lib/format';
import { useComputerFiles } from '../../lib/queries';
import { EmptyState, ErrorBlock, LoadingBlock } from '../ui';

export function breadcrumbs(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((p, i) => ({ label: p, path: `/${parts.slice(0, i + 1).join('/')}` }));
}

export function FilesBrowser() {
  const [path, setPath] = useState(WORKSPACE_ROOT);
  const files = useComputerFiles(path, true);
  const sorted = [...(files.data ?? [])].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'fr') : a.type === 'dir' ? -1 : 1));
  const crumbs = breadcrumbs(path);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-3 py-2 text-[13px]">
        <nav aria-label="Chemin" className="flex min-w-0 items-center gap-0.5">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight className="size-3.5 text-subtle" />}
              <button
                type="button"
                className="mono rounded-[6px] px-1 py-0.5 hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
                disabled={c.path === path || !c.path.startsWith(WORKSPACE_ROOT)}
                onClick={() => setPath(c.path)}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <button type="button" className="btn btn-ghost btn-sm btn-icon ml-auto" aria-label="Actualiser" onClick={() => void files.refetch()}>
          <RefreshCw className={files.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </button>
      </div>
      {files.isPending ? (
        <LoadingBlock />
      ) : files.isError ? (
        <ErrorBlock error={files.error} onRetry={() => void files.refetch()} />
      ) : sorted.length === 0 ? (
        <EmptyState title="Dossier vide" />
      ) : (
        <ul className="divide-y divide-line">
          {sorted.map((f) => (
            <li key={f.path} className="flex items-center gap-3 px-3 py-1.5 text-[13px] hover:bg-hover">
              {f.type === 'dir' ? (
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setPath(f.path)}>
                  <Folder className="size-4 shrink-0 text-accent-text" />
                  <span className="truncate font-medium">{f.name}</span>
                </button>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <File className="size-4 shrink-0 text-subtle" />
                  <span className="truncate">{f.name}</span>
                </span>
              )}
              <span className="hidden w-20 text-right text-[12px] text-subtle sm:block">{f.type === 'file' ? formatBytes(f.size) : ''}</span>
              <span className="hidden w-28 text-right text-[12px] text-subtle sm:block">{formatShort(f.modifiedAt)}</span>
              <span className="w-8">
                {f.type === 'file' && (
                  <a
                    className="btn btn-ghost btn-sm btn-icon"
                    href={buildUrl('/api/computer/files/download', { path: f.path })}
                    download={f.name}
                    aria-label={`Télécharger ${f.name}`}
                  >
                    <Download className="size-3.5" />
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
