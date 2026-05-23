/**
 * Settings modal — pick STT/TTS provider, model, and voice.
 *
 * Fetches `/api/voice/config` for current settings, the provider catalog, and
 * whether each API key is present in .env. PUT-saves on Save.
 */

import { useEffect, useState } from 'react';
import Ic from './Icons';

interface ModelOption { id: string; label: string }
interface VoiceOption { id: string; label: string }
interface ProviderSpec {
  id: 'browser' | 'openai' | 'gemini';
  label: string;
  needsKey?: 'OPENAI_API_KEY' | 'GEMINI_API_KEY';
  sttModels?: ModelOption[];
  ttsModels?: ModelOption[];
  voices?: VoiceOption[];
}

interface VoiceConfig {
  stt: { provider: 'browser' | 'openai' | 'gemini'; model: string; language: string };
  tts: {
    enabled: boolean;
    provider: 'browser' | 'openai' | 'gemini';
    model: string;
    voice: string;
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const LANGS: ModelOption[] = [
  { id: 'zh-TW', label: 'Chinese (Taiwan)' },
  { id: 'zh', label: 'Chinese (Mainland)' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: 'Japanese' },
  { id: '', label: 'Auto-detect' },
];

export default function SettingsModal({ open, onClose, onSaved }: Props) {
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [providers, setProviders] = useState<ProviderSpec[]>([]);
  const [keys, setKeys] = useState<{ openai: boolean; gemini: boolean }>({ openai: false, gemini: false });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    fetch('/api/voice/config')
      .then((r) => r.json())
      .then((d) => {
        setCfg(d.config);
        setProviders(d.providers);
        setKeys(d.keys);
      })
      .catch((e) => setErr(String(e)));
  }, [open]);

  if (!open) return null;
  if (!cfg) {
    return (
      <div className="settings-scrim" onClick={onClose}>
        <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
          <div style={{ padding: 40, color: 'var(--text-3)' }}>{err || 'Loading…'}</div>
        </div>
      </div>
    );
  }

  const sttProv = providers.find((p) => p.id === cfg.stt.provider);
  const ttsProv = providers.find((p) => p.id === cfg.tts.provider);
  const keyOK = (id: 'browser' | 'openai' | 'gemini') =>
    id === 'browser' ? true : id === 'openai' ? keys.openai : keys.gemini;

  const sttProviders = providers.filter(
    (p) => p.id === 'browser' || (p.sttModels && p.sttModels.length > 0),
  );
  const ttsProviders = providers.filter(
    (p) => p.id === 'browser' || (p.ttsModels && p.ttsModels.length > 0),
  );

  const setSttProvider = (id: VoiceConfig['stt']['provider']) => {
    const p = providers.find((x) => x.id === id);
    setCfg({
      ...cfg,
      stt: { ...cfg.stt, provider: id, model: p?.sttModels?.[0]?.id || '' },
    });
  };
  const setTtsProvider = (id: VoiceConfig['tts']['provider']) => {
    const p = providers.find((x) => x.id === id);
    setCfg({
      ...cfg,
      tts: {
        ...cfg.tts,
        provider: id,
        model: p?.ttsModels?.[0]?.id || '',
        voice: p?.voices?.[0]?.id || '',
      },
    });
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch('/api/voice/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `save ${r.status}`);
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="settings-h">
          <div className="settings-title"><Ic.settings size={15} /> Voice settings</div>
          <button className="hbtn" onClick={onClose} title="Close"><Ic.x size={13} /></button>
        </header>

        <div className="settings-body">
          <section className="settings-sec">
            <h4>Speech-to-text</h4>
            <Row label="Provider">
              <select
                value={cfg.stt.provider}
                onChange={(e) => setSttProvider(e.target.value as VoiceConfig['stt']['provider'])}
              >
                {sttProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}{p.needsKey && !keyOK(p.id) ? ' (key missing)' : ''}
                  </option>
                ))}
              </select>
            </Row>
            {sttProv?.sttModels && sttProv.sttModels.length > 0 && (
              <Row label="Model">
                <select
                  value={cfg.stt.model}
                  onChange={(e) => setCfg({ ...cfg, stt: { ...cfg.stt, model: e.target.value } })}
                >
                  {sttProv.sttModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </Row>
            )}
            <Row label="Language">
              <select
                value={cfg.stt.language}
                onChange={(e) => setCfg({ ...cfg, stt: { ...cfg.stt, language: e.target.value } })}
              >
                {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </Row>
          </section>

          <section className="settings-sec">
            <h4>Text-to-speech</h4>
            <Row label="Speak replies">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={cfg.tts.enabled}
                  onChange={(e) => setCfg({ ...cfg, tts: { ...cfg.tts, enabled: e.target.checked } })}
                />
                <span>{cfg.tts.enabled ? 'On — the Keeper reads its replies aloud' : 'Off — silent'}</span>
              </label>
            </Row>
            <Row label="Provider">
              <select
                value={cfg.tts.provider}
                disabled={!cfg.tts.enabled}
                onChange={(e) => setTtsProvider(e.target.value as VoiceConfig['tts']['provider'])}
              >
                {ttsProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}{p.needsKey && !keyOK(p.id) ? ' (key missing)' : ''}
                  </option>
                ))}
              </select>
            </Row>
            {ttsProv?.ttsModels && ttsProv.ttsModels.length > 0 && (
              <Row label="Model">
                <select
                  value={cfg.tts.model}
                  onChange={(e) => setCfg({ ...cfg, tts: { ...cfg.tts, model: e.target.value } })}
                >
                  {ttsProv.ttsModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </Row>
            )}
            {ttsProv?.voices && ttsProv.voices.length > 0 && (
              <Row label="Voice">
                <select
                  value={cfg.tts.voice}
                  onChange={(e) => setCfg({ ...cfg, tts: { ...cfg.tts, voice: e.target.value } })}
                >
                  {ttsProv.voices.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
              </Row>
            )}
          </section>

          <section className="settings-keys">
            <div className="settings-keys-h">
              API keys (set in <code>.env</code> at the project root)
            </div>
            <div className={'key-row ' + (keys.openai ? 'ok' : 'miss')}>
              <code>OPENAI_API_KEY</code>
              <span>{keys.openai ? '✓ set' : '— not set'}</span>
            </div>
            <div className={'key-row ' + (keys.gemini ? 'ok' : 'miss')}>
              <code>GEMINI_API_KEY</code>
              <span>{keys.gemini ? '✓ set' : '— not set'}</span>
            </div>
            <div className="settings-keys-note">
              After editing <code>.env</code>, restart the web server (<code>npm start</code>).
            </div>
          </section>

          {err && <div className="settings-err">{err}</div>}
        </div>

        <footer className="settings-f">
          <button className="hbtn" onClick={onClose}>Cancel</button>
          <button className="hbtn primary" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <label>{label}</label>
      <div className="settings-row-ctrl">{children}</div>
    </div>
  );
}
