import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ChannelDTO, ChannelInput } from '@ant/shared';
import { errorMessage, post } from '../../lib/api';
import { qk, useBots } from '../../lib/queries';
import { Modal } from '../Modal';
import { Field, Spinner } from '../ui';
import { BotPicker } from './BotPicker';

export function NewChannelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: bots } = useBots();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [botIds, setBotIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (input: ChannelInput) => post<ChannelDTO>('/api/channels', input),
    onSuccess: (ch) => {
      qc.setQueryData<ChannelDTO[]>(qk.channels, (d) => (d ? [...d, ch] : d));
      void qc.invalidateQueries({ queryKey: qk.channels });
      setName('');
      setTopic('');
      setBotIds([]);
      onClose();
      navigate(`/c/${ch.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate({ name: name.trim(), topic: topic.trim(), botIds });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nouveau canal"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" form="new-channel" className="btn btn-primary" disabled={!name.trim() || !botIds.length || create.isPending}>
            {create.isPending && <Spinner className="size-4 text-accent-fg" />}
            Créer le canal
          </button>
        </>
      }
    >
      <form id="new-channel" onSubmit={submit} className="space-y-4">
        {error && <div className="text-[13px] text-danger">{error}</div>}
        <Field label="Nom" htmlFor="ch-name">
          <input id="ch-name" data-autofocus className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="lancement-site" required />
        </Field>
        <Field label="Sujet" htmlFor="ch-topic" help="Une phrase qui dit aux bots à quoi sert ce canal.">
          <input id="ch-topic" className="input" maxLength={300} value={topic} onChange={(e) => setTopic(e.target.value)} />
        </Field>
        <div>
          <div className="label">Bots membres</div>
          <BotPicker bots={bots ?? []} value={botIds} onChange={setBotIds} />
          <div className="help">Sans @mention, c’est le premier bot du canal qui répond.</div>
        </div>
      </form>
    </Modal>
  );
}
