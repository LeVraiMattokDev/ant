import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, FolderOpen, Monitor, Settings2 } from 'lucide-react';
import type { BotDTO, ChannelDTO } from '@ant/shared';
import { BotAvatar, GroupAvatar } from '../BotAvatar';
import { useShell } from '../layout/shell';
import { cx } from '../ui';
import { ChannelSettingsModal } from './ChannelSettingsModal';
import { ModelSelector } from './ModelSelector';

const iconBtn = 'btn btn-ghost btn-icon size-9 rounded-full';

export function ChannelHeader({ channel, members, dmBot }: { channel: ChannelDTO; members: BotDTO[]; dmBot: BotDTO | undefined }) {
  const { openFiles, toggleComputer, computerOpen } = useShell();
  const [settings, setSettings] = useState(false);

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-2 md:border-transparent md:px-5">
      <Link to="/" className={cx(iconBtn, 'md:hidden')} aria-label="Retour aux conversations">
        <ChevronLeft className="size-5" />
      </Link>
      {channel.kind === 'dm' && dmBot ? (
        <Link
          to={`/bots/${dmBot.id}`}
          title={`${dmBot.name} : ${dmBot.role}`}
          className="group flex min-w-0 items-center gap-2.5 rounded-[12px] py-1 pr-2 pl-1 hover:bg-hover"
        >
          <BotAvatar bot={dmBot} size={30} />
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-[15px] font-semibold">{dmBot.name}</h1>
            <div className={cx('truncate text-[12px]', dmBot.paused ? 'text-warning' : 'text-subtle')}>
              {dmBot.paused ? 'En pause' : dmBot.activity ? dmBot.activity : dmBot.role}
            </div>
          </div>
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => setSettings(true)}
          className="flex min-w-0 items-center gap-2.5 rounded-[12px] py-1 pr-2 pl-1 text-left hover:bg-hover"
          title="Réglages de l’équipe"
        >
          <GroupAvatar bots={members} size={32} />
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-[15px] font-semibold">{channel.name}</h1>
            <div className="truncate text-[12px] text-subtle">{channel.topic || `${members.length} bot${members.length > 1 ? 's' : ''}`}</div>
          </div>
        </button>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {channel.kind === 'group' && (
          <>
            <div className="mr-1 hidden items-center gap-0.5 lg:flex" aria-label={`${members.length} bots membres`}>
              {members.slice(0, 5).map((b) => (
                <Link key={b.id} to={`/bots/${b.id}`} title={`${b.name} (@${b.slug})`} className="rounded-[8px] p-0.5 hover:bg-hover">
                  <BotAvatar bot={b} size={22} label={b.name} />
                </Link>
              ))}
              {members.length > 5 && <span className="pl-1 text-[12px] text-subtle">+{members.length - 5}</span>}
            </div>
            <button type="button" className={iconBtn} onClick={() => setSettings(true)} aria-label="Réglages de l’équipe" title="Réglages de l’équipe">
              <Settings2 className="size-[18px]" />
            </button>
            <ChannelSettingsModal channel={channel} open={settings} onClose={() => setSettings(false)} />
          </>
        )}
        {channel.kind === 'dm' && dmBot && (
          <div className="min-w-0">
            <ModelSelector bot={dmBot} />
          </div>
        )}
        <button type="button" className={cx(iconBtn, 'hidden sm:inline-flex')} onClick={openFiles} aria-label="Fichiers de l’ordinateur" title="Fichiers de l’ordinateur">
          <FolderOpen className="size-[18px]" />
        </button>
        <button
          type="button"
          className={cx(iconBtn, computerOpen && 'bg-active text-fg')}
          onClick={toggleComputer}
          aria-pressed={computerOpen}
          aria-label="Écran de l’ordinateur"
          title="Écran de l’ordinateur"
        >
          <Monitor className="size-[18px]" />
        </button>
      </div>
    </header>
  );
}
