import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { installChunkReload } from './lib/chunk-reload';
import { ErrorBoundary } from './lib/error-boundary';
import { createQueryClient } from './lib/queries';
import { registerServiceWorker } from './lib/sw-register';
import '@fontsource-variable/inter/wght.css';
import './index.css';

const queryClient = createQueryClient();

installChunkReload();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Last resort (login, setup, toasts): screens have their own boundary in App. */}
    <ErrorBoundary label="Ant n’a pas pu s’afficher à cause d’une erreur inattendue.">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

registerServiceWorker();
