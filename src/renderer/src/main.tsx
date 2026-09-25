import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { store } from './store';

void store.init();
createRoot(document.getElementById('root')!).render(<App />);
