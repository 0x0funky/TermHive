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
/**
 * API keys live in a SEPARATE file so settings (safe to share / paste) stay
 * cleanly apart from secrets. Both files live under ~/.termhive — outside any
 * git repo — and are never echoed back to the browser in plain text.
 */
const KEYS_PATH = path.join(VOICE_DIR, 'api-keys.json');

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

/** API keys — stored in api-keys.json. .env still wins as an explicit override. */
export interface ApiKeys { openai?: string; gemini?: string }

export function loadApiKeys(): ApiKeys {
  try {
    if (fs.existsSync(KEYS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
      return {
        openai: typeof raw.openai === 'string' ? raw.openai : undefined,
        gemini: typeof raw.gemini === 'string' ? raw.gemini : undefined,
      };
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * Merge-save: only fields present in `partial` change; an empty-string value
 * means "clear this key" (delete the entry).
 */
export function saveApiKeys(partial: ApiKeys): void {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const cur = loadApiKeys();
  const next: ApiKeys = { ...cur };
  for (const k of ['openai', 'gemini'] as const) {
    const v = partial[k];
    if (typeof v !== 'string') continue;
    if (v === '') delete next[k];
    else next[k] = v;
  }
  fs.writeFileSync(KEYS_PATH, JSON.stringify(next, null, 2), 'utf-8');
  // Best-effort owner-only permissions (Windows ignores this — file lives in
  // the user's profile so the OS ACL already restricts access).
  try { fs.chmodSync(KEYS_PATH, 0o600); } catch { /* ignore */ }
}

export function getApiKey(provider: 'openai' | 'gemini'): string | undefined {
  // .env takes precedence (explicit override for power users / CI), then file.
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY || loadApiKeys().openai || undefined;
  }
  if (provider === 'gemini') {
    return (
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      loadApiKeys().gemini ||
      undefined
    );
  }
  return undefined;
}

export function hasKey(provider: 'browser' | 'openai' | 'gemini'): boolean {
  if (provider === 'browser') return true;
  return !!getApiKey(provider);
}
