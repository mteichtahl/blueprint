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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
