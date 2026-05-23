/**
 * Voice provider catalog — the lists shown in the settings page. The frontend
 * uses these for the provider/model/voice dropdowns and the server uses them
 * as the source of truth for what `config.provider/model/voice` may hold.
 *
 * "browser" means "do it in the browser" — Web Speech API (current behaviour);
 * the server doesn't handle these and the routes return an error if asked to.
 */

export interface ModelOption { id: string; label: string }
export interface VoiceOption { id: string; label: string }
export interface ProviderSpec {
  id: 'browser' | 'openai' | 'gemini';
  label: string;
  /** env var name — UI shows whether it's set. */
  needsKey?: 'OPENAI_API_KEY' | 'GEMINI_API_KEY';
  sttModels?: ModelOption[];
  ttsModels?: ModelOption[];
  voices?: VoiceOption[];
}

export const PROVIDERS: ProviderSpec[] = [
  { id: 'browser', label: 'Browser (free, current default)' },

  {
    id: 'openai',
    label: 'OpenAI',
    needsKey: 'OPENAI_API_KEY',
    sttModels: [
      { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe (best, $0.006/min)' },
      { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe (cheaper, $0.003/min)' },
      { id: 'whisper-1', label: 'whisper-1 (legacy)' },
    ],
    ttsModels: [
      { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts (steerable, 2025-03)' },
      { id: 'tts-1', label: 'tts-1' },
      { id: 'tts-1-hd', label: 'tts-1-hd' },
    ],
    voices: [
      { id: 'alloy', label: 'Alloy' },
      { id: 'ash', label: 'Ash' },
      { id: 'ballad', label: 'Ballad' },
      { id: 'coral', label: 'Coral' },
      { id: 'echo', label: 'Echo' },
      { id: 'fable', label: 'Fable' },
      { id: 'nova', label: 'Nova' },
      { id: 'onyx', label: 'Onyx' },
      { id: 'sage', label: 'Sage' },
      { id: 'shimmer', label: 'Shimmer' },
      { id: 'verse', label: 'Verse' },
    ],
  },

  {
    id: 'gemini',
    label: 'Google Gemini',
    needsKey: 'GEMINI_API_KEY',
    sttModels: [
      { id: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview (latest)' },
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
      { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
      { id: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite (cheap)' },
    ],
    ttsModels: [
      { id: 'gemini-3.1-flash-tts-preview', label: 'gemini-3.1-flash-tts-preview (latest, expressive)' },
      { id: 'gemini-2.5-flash-tts', label: 'gemini-2.5-flash-tts' },
      { id: 'gemini-2.5-pro-tts', label: 'gemini-2.5-pro-tts' },
      { id: 'gemini-2.5-flash-lite-preview-tts', label: 'gemini-2.5-flash-lite-preview-tts (cheap)' },
    ],
    voices: [
      { id: 'Kore', label: 'Kore (firm)' },
      { id: 'Puck', label: 'Puck (upbeat)' },
      { id: 'Charon', label: 'Charon (informative)' },
      { id: 'Leda', label: 'Leda (youthful)' },
      { id: 'Zephyr', label: 'Zephyr (bright)' },
      { id: 'Fenrir', label: 'Fenrir (excitable)' },
      { id: 'Aoede', label: 'Aoede (breezy)' },
      { id: 'Orus', label: 'Orus (firm)' },
      { id: 'Algieba', label: 'Algieba (smooth)' },
      { id: 'Callirrhoe', label: 'Callirrhoe (easy-going)' },
    ],
  },
];
