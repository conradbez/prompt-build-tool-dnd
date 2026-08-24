import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initServerUrlFromQuery } from './api';
import './index.css';

// Pick up a `?server=…` URL from the page address before the app reads it.
initServerUrlFromQuery();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
