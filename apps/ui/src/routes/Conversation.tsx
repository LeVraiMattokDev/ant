import { useCallback, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useBotMap, useChannels } from '../lib/queries';
import { ChannelHeader } from '../components/chat/ChannelHeader';
import { MessageList } from '../components/chat/MessageList';
import { ActivityBar } from '../components/chat/ActivityBar';
import { Composer } from '../components/chat/Composer';
import { ThreadPane } from '../components/chat/ThreadPane';
import { Avatar, EmptyState, ErrorBlock, LoadingBlock } from '../components/ui';

export function ConversationPage() {
  const { channelId = '', messageId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const channels = useChannels();
  const bots = useBotMap();
  const channel = channels.data?.find((c) => c.id === channelId);

  const members = useMemo(
    () => (channel ? channel.botIds.map((id) => bots.get(id)).filter((b): b is NonNullable<typeof b> => !!b) : []),
    [channel, bots],
  );
  const dmBot = channel?.dmBotId ? bots.get(channel.dmBotId) : undefined;
  const closeThread = useCallback(() => navigate(`/c/${channelId}`), [navigate, channelId]);

  if (channels.isPending) return <LoadingBlock />;
  if (channels.isError) return <ErrorBlock error={channels.error} onRetry={() => void channels.refetch()} />;
  if (!channel) {
    return (
      <EmptyState title="Canal introuvable">
        Ce canal a peut-être été archivé.
      </EmptyState>
    );
  }

  const placeholder = channel.kind === 'dm' ? `Écrire à ${dmBot?.name ?? 'ce bot'}…` : `Écrire dans #${channel.name}…`;

  const empty =
    channel.kind === 'dm' && dmBot ? (
      <div className="px-5 pt-16 text-center">
        <Avatar emoji={dmBot.avatar} size="lg" />
        <div className="mt-3 font-semibold">{dmBot.name}</div>
        <div className="mx-auto mt-1 max-w-sm text-[13px] text-muted">{dmBot.role}</div>
      </div>
    ) : (
      <EmptyState title={`#${channel.name}`}>
        {channel.topic || 'Aucun message pour le moment.'} Mentionne un bot avec @ pour lui confier quelque chose.
      </EmptyState>
    );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelHeader channel={channel} members={members} dmBot={dmBot} />
        <MessageList channelId={channel.id} bots={bots} focusMessageId={params.get('m')} empty={empty} />
        <ActivityBar channelId={channel.id} bots={bots} />
        <Composer channelId={channel.id} members={members} placeholder={placeholder} autoFocus={!messageId} />
      </div>
      {messageId && <ThreadPane channelId={channel.id} rootId={messageId} bots={bots} members={members} onClose={closeThread} />}
    </div>
  );
}
