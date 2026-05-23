/**
 * useVoiceConfig — fetch (and refresh) the active STT/TTS settings.
 *
 * The server-side config lives in ~/.termhive/voice.json; this hook mirrors it
 * into React state so the JarvisHud, CommandPanel, and the header quick-cmd
 * can pick the right provider per call.
 */

import { useCallback, useEffect, useState } from 'react';

export interface VoiceCfg {
  stt: { provider: 'browser' | 'openai' | 'gemini'; model: string; language: string };
  tts: { provider: 'browser' | 'openai' | 'gemini'; model: string; voice: string };
}

const DEFAULT_CFG: VoiceCfg = {
  stt: { provider: 'browser', model: '', language: 'zh-TW' },
  tts: { provider: 'browser', model: '', voice: '' },
};

export function useVoiceConfig() {
  const [cfg, setCfg] = useState<VoiceCfg>(DEFAULT_CFG);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    fetch('/api/voice/config')
      .then((r) => r.json())
      .then((d) => { if (d?.config) setCfg(d.config); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { cfg, loaded, refresh };
}
