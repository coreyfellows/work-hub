import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { SetupGate } from './pages/SetupGate.tsx';
import './styles.css';
// The active plugins (written by server/plugins/generateWebModule.ts): each registers its slot items while this
// module evaluates, i.e. before the render below. Imported after styles.css so plugin CSS comes after the core's
// and the layout overrides (imported last by that module) come after both.
import './builtin.ts';
import './plugins.generated.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SetupGate>
      <App />
    </SetupGate>
  </StrictMode>,
);

// A fresh load (reload, new tab) lands in the current input too: the Chat footer takes this window (see Composer) when it mounts.
(window as unknown as { whFocusInputUntil?: number }).whFocusInputUntil = Date.now() + 6000;
