import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <EmptyState
      title="Page introuvable"
      action={
        <Link to="/" className="btn">
          Retour à l’accueil
        </Link>
      }
    >
      Cette adresse ne correspond à aucun écran d’Ant.
    </EmptyState>
  );
}
