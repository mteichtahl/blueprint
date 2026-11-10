import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { preventZoom } from './lib/noZoom.ts';
import { registerServiceWorker } from './lib/push.ts';
import './index.css';

registerServiceWorker();
preventZoom();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
