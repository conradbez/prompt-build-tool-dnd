import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initServerUrlFromQuery } from './api';
import { startAutoSave, syncFromServer } from './lib/saves';
import './index.css';

// Pick up a `?server=…` URL from the page address before the app reads it.
initServerUrlFromQuery();

// Edits flow back into whichever save is open (see `lib/saves`).
startAutoSave();

// Signed in: open the map saved last on the server.
syncFromServer().catch((e) => console.warn('Could not fetch your maps:', e));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
