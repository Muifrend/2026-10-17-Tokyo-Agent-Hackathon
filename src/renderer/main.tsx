import { createRoot } from 'react-dom/client';

async function boot() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('capture') === '1') {
    await import('./capture');
    return;
  }
  const [{ default: App }, css] = await Promise.all([
    import('./App'),
    import('./styles.css'),
  ]);
  createRoot(document.getElementById('root')!).render(<App />);
}

void boot();
