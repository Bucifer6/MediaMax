import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/fonts.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/pages.css';
import './styles/player.css';
import './styles/admin.css';
import './styles/stats.css';
import './styles/tv.css';
import './styles/discovery.css';
import './styles/audio.css';
import './styles/help.css';
import './styles/karaoke.css';
import './styles/lumen.css';
import { detectTv, installTvMode } from './tv/spatial';
import { installFx } from './theme/fx';
import { initCapabilities } from './player/capabilities';
import { initAudioCaps } from './player/audioCaps';

if (detectTv()) installTvMode();
// Lite visual effects on TVs and low-end devices (after TV detection; see theme/fx.ts).
installFx();
// Start HDR / codec capability detection early (async MediaCapabilities); the player awaits it briefly.
void initCapabilities();
void initAudioCaps();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
