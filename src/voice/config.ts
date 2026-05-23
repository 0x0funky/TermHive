/**
 * Voice settings persistence — provider/model/voice selections live in
 * ~/.termhive/voice.json so they survive across daemon/web restarts. API keys
 * never live here — those go in .env.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const VOICE_DIR = path.join(os.homedir(), '.termhive');
const VOICE_PATH = path.join(VOICE_DIR, 'voice.json');

export interface VoiceConfig {
  stt: { provider: 'browser' | 'openai' | 'gemini'; model: string; language: string };
  tts: {
    enabled: boolean;
    provider: 'browser' | 'openai' | 'gemini';
    model: string;
    voice: string;
  };
}

const DEFAULT: VoiceConfig = {
  stt: { provider: 'browser', model: '', language: 'zh-TW' },
  tts: { enabled: true, provider: 'browser', model: '', voice: '' },
};

export function loadConfig(): VoiceConfig {
  try {
    if (fs.existsSync(VOICE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(VOICE_PATH, 'utf-8'));
      return {
        stt: { ...DEFAULT.stt, ...(raw.stt || {}) },
        tts: { ...DEFAULT.tts, ...(raw.tts || {}) },
      };
    }
  } catch { /* fall through */ }
  return DEFAULT;
}

export function saveConfig(cfg: VoiceConfig): void {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  fs.writeFileSync(VOICE_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

export function hasKey(provider: 'browser' | 'openai' | 'gemini'): boolean {
  if (provider === 'browser') return true;
  if (provider === 'openai') return !!process.env.OPENAI_API_KEY;
  if (provider === 'gemini') return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  return false;
}
