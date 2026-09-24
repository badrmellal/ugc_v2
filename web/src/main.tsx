import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createQueryClient } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App queryClient={createQueryClient()} />
  </StrictMode>,
);
