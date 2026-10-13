import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ChannelDTO, ChannelInput } from '@ant/shared';
import { del, errorMessage, patch } from '../../lib/api';
import { qk, useBots } from '../../lib/queries';
import { toast } from '../../lib/toast';
import { Modal, useConfirm } from '../Modal';
import { Field, Spinner } from '../ui';
import { BotPicker } from './BotPicker';

export function ChannelSettingsModal({ channel, open, onClose }: { channel: ChannelDTO; open: boolean; onClose: () => void }) {
  const { data: bots } = useBots();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [botIds, setBotIds] = useState(channel.botIds);
  const [error, setError] = useState<string | null>(null);

  // Reset when the modal opens or the channel changes, not on every new channel object: each message in the
  // channel rebuilds it (preview, lastMessageAt) and would wipe what the owner is typing.
  useEffect(() => {
    if (!open) return;
    setName(channel.name);
    setTopic(channel.topic);
    setBotIds(channel.botIds);
    setError(null);
  }, [open, channel.id]);

  const save = useMutation({
    mutationFn: (input: Partial<ChannelInput>) => patch<ChannelDTO>(`/api/channels/${channel.id}`, input),
    onSuccess: (ch) => {
      qc.setQueryData<ChannelDTO[]>(qk.channels, (d) => d?.map((c) => (c.id === ch.id ? ch : c)));
      toast.success('Équipe mise à jour');
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const archive = useMutation({
    mutationFn: () => del(`/api/channels/${channel.id}`),
    onSuccess: () => {
      qc.setQueryData<ChannelDTO[]>(qk.channels, (d) => d?.filter((c) => c.id !== channel.id));
      toast.success('Équipe archivée', `#${channel.name}`);
      onClose();
      navigate('/');
    },
    onError: (err) => toast.fromError(err, 'Archivage impossible'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate({ name: name.trim(), topic: topic.trim(), botIds });
  };

  const onArchive = async () => {
    const ok = await confirm({
      title: `Archiver #${channel.name} ?`,
      body: 'L’équipe disparaît de la liste et les bots n’y répondent plus. L’historique reste dans la recherche et le journal.',
      confirmLabel: 'Archiver',
      danger: true,
    });
    if (ok) archive.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Réglages de #${channel.name}`}
      footer={
        <>
          <button type="button" className="btn btn-danger mr-auto" onClick={() => void onArchive()} disabled={archive.isPending}>
            Archiver
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" form="channel-settings" className="btn btn-primary" disabled={!name.trim() || !botIds.length || save.isPending}>
            {save.isPending && <Spinner className="size-4 text-accent-fg" />}
            Enregistrer
          </button>
        </>
      }
    >
      <form id="channel-settings" onSubmit={submit} className="space-y-4">
        {error && <div className="text-[13px] text-danger">{error}</div>}
        <Field label="Nom" htmlFor="cs-name">
          <input id="cs-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Sujet" htmlFor="cs-topic">
          <input id="cs-topic" className="input" maxLength={300} value={topic} onChange={(e) => setTopic(e.target.value)} />
        </Field>
        <div>
          <div className="label">Bots membres</div>
          <BotPicker bots={bots ?? []} value={botIds} onChange={setBotIds} />
        </div>
      </form>
    </Modal>
  );
}
