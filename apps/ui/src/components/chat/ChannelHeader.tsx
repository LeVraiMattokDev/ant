import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Hash, Menu, Settings2 } from 'lucide-react';
import type { BotDTO, ChannelDTO } from '@ant/shared';
import { MODEL_LABELS } from '@ant/shared';
import { useShell } from '../layout/AppShell';
import { Avatar } from '../ui';
import { ChannelSettingsModal } from './ChannelSettingsModal';

export function ChannelHeader({ channel, members, dmBot }: { channel: ChannelDTO; members: BotDTO[]; dmBot: BotDTO | undefined }) {
  const { openDrawer } = useShell();
  const [settings, setSettings] = useState(false);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2 md:px-5">
      <button type="button" className="btn btn-ghost btn-icon md:hidden" onClick={openDrawer} aria-label="Ouvrir la navigation">
        <Menu className="size-5" />
      </button>
      {channel.kind === 'dm' && dmBot ? (
        <Link to={`/bots/${dmBot.id}`} className="flex min-w-0 items-center gap-2.5 rounded-[4px] py-1 pr-2 hover:bg-hover">
          <Avatar emoji={dmBot.avatar} size="sm" />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h1 className="truncate text-[14.5px] font-semibold">{dmBot.name}</h1>
              <span className="hidden text-[12px] text-subtle sm:inline">{MODEL_LABELS[dmBot.model] ?? dmBot.model}</span>
            </div>
            <div className="truncate text-[12px] text-muted">
              {dmBot.paused ? 'En pause' : dmBot.activity ? dmBot.activity : dmBot.role}
            </div>
          </div>
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Hash className="size-4 shrink-0 text-subtle" />
          <div className="min-w-0">
            <h1 className="truncate text-[14.5px] font-semibold">{channel.name}</h1>
            {channel.topic && <div className="truncate text-[12px] text-muted">{channel.topic}</div>}
          </div>
        </div>
      )}
      <div className="ml-auto flex items-center gap-1">
        {channel.kind === 'group' && (
          <>
            <div className="hidden items-center -space-x-1 sm:flex" aria-label={`${members.length} bots membres`}>
              {members.slice(0, 5).map((b) => (
                <Link key={b.id} to={`/bots/${b.id}`} title={`${b.name} (@${b.slug})`}>
                  <Avatar emoji={b.avatar} size="sm" />
                </Link>
              ))}
              {members.length > 5 && <span className="pl-2 text-[12px] text-subtle">+{members.length - 5}</span>}
            </div>
            <button type="button" className="btn btn-ghost btn-sm btn-icon ml-1" onClick={() => setSettings(true)} aria-label="Réglages du canal">
              <Settings2 className="size-4" />
            </button>
            <ChannelSettingsModal channel={channel} open={settings} onClose={() => setSettings(false)} />
          </>
        )}
      </div>
    </header>
  );
}
