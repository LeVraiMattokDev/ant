/**
 * Render-error boundary. Without one, React unmounts the whole root on any render error: a lazy screen whose
 * chunk vanished with a new deployment (old hashed files are gone) would leave a blank app until a manual reload.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

/** True for a failed dynamic import: a lazily loaded screen whose file is no longer on the server. */
export function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|valid JavaScript MIME type/i.test(message);
}

interface Props {
  children: ReactNode;
  /** The boundary clears its error when this value changes (e.g. the route), so another screen can render. */
  resetKey?: unknown;
  /** Error message shown instead of the generic one. */
  label?: string;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Erreur d’affichage', error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ error: null });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const message = isChunkLoadError(error)
      ? 'Une nouvelle version d’Ant a été installée : recharge la page pour afficher cet écran.'
      : (this.props.label ?? 'Cet écran n’a pas pu s’afficher à cause d’une erreur inattendue.');
    // A lazy import that failed stays failed until the page reloads: retrying in place cannot help.
    return (
      <div role="alert" className="m-4 rounded-[12px] border border-danger/40 bg-danger-soft px-4 py-3 text-sm">
        <div className="text-danger">{message}</div>
        <button type="button" className="btn btn-sm mt-2" onClick={() => window.location.reload()}>
          Recharger
        </button>
      </div>
    );
  }
}
