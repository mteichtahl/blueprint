import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { preventZoom } from './lib/noZoom.ts';
import { lockToVisibleViewport } from './lib/viewport.ts';
import { registerServiceWorker } from './lib/push.ts';
import './index.css';

registerServiceWorker();
preventZoom();
lockToVisibleViewport();

// A screen's code can vanish when a new version is deployed while the app is
// open. Reload once to pick up the new version instead of showing an error.
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (sessionStorage.getItem('bmg-reloaded-for-update')) return;
    sessionStorage.setItem('bmg-reloaded-for-update', '1');
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
