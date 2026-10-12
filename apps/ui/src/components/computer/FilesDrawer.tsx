import { Modal } from '../Modal';
import { FilesBrowser } from './FilesBrowser';

/** The agents' /workspace, browsable from any conversation. */
export function FilesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Fichiers de l’ordinateur" description="Le dossier de travail partagé des bots." variant="drawer">
      <FilesBrowser />
    </Modal>
  );
}
