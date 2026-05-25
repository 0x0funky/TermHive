/**
 * JarvisHud — a floating, non-modal voice cockpit for The Keeper.
 *
 * An always-present orb (bottom-right) that pulses with the Keeper's state —
 * breathing when idle, radiating rings while listening, spinning while it
 * works. Click it for a floating HUD: talk or type to the Keeper and glance
 * at which agents need you, without opening the full Command drawer and
 * without a scrim — everything underneath stays fully interactive.
 */

import { useState, useEffect, useRef } from 'react';
import { marked } from 'marked';
import Ic from './Icons';
import { useSpeechInput } from '../hooks/useSpeechInput';
import type { AgentNotif } from './NotificationCenter';

function renderMd(text: string): string {
  try { return marked.parse(text, { async: false }) as string; }
  catch { return text; }
}

interface TtsCfg {
  enabled: boolean;
  provider: 'browser' | 'openai' | 'gemini';
  model: string;
  voice: string;
  speed: number;
}

/**
 * Single global TTS queue — the Keeper's step narration and its closing 🔊
 * summary play back in order, and `stopSpeaking()` is the only thing that
 * clears them. Each job carries the per-call TTS config so we can switch
 * provider on the fly without dropping in-flight audio.
 */
let ttsQueue: Array<{ spoken: string; cfg: TtsCfg }> = [];
let ttsBusy = false;
let ttsCurrent: HTMLAudioElement | null = null;

function stopSpeaking() {
  ttsQueue = [];
  ttsBusy = false;
  if (ttsCurrent) { try { ttsCurrent.pause(); } catch { /* ignore */ } ttsCurrent = null; }
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}

/** Pull the Keeper's explicit spoken-summary line (`🔊 …`) out of a reply. */
const SPOKEN_RE = /🔊[ \t]*([^\n]+)/;

/** Distill the speakable line out of a Keeper reply. */
function extractSpoken(text: string): string {
  let spoken = '';
  const marked = text.match(SPOKEN_RE);
  if (marked) {
    spoken = marked[1].replace(/[*_`#>]/g, '').trim();
  } else {
    const clean = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_#>]/g, '')
      .replace(/^\s*[-•]\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    const sentences = clean.split(/(?<=[。.!?！?])\s*/).filter((s) => s.trim());
    spoken = sentences.slice(0, 2).join('') || clean;
  }
  return spoken.slice(0, 500).trim();
}

function speakReply(text: string, cfg: TtsCfg) {
  if (!cfg.enabled) return;   // master TTS off
  const spoken = extractSpoken(text);
  if (!spoken) return;
  ttsQueue.push({ spoken, cfg });
  void processTtsQueue();
}

async function processTtsQueue(): Promise<void> {
  if (ttsBusy || ttsQueue.length === 0) return;
  ttsBusy = true;
  const job = ttsQueue.shift()!;
  try {
    if (job.cfg.provider === 'openai' || job.cfg.provider === 'gemini') {
      await playApi(job.spoken);
    } else {
      await playBrowser(job.spoken);
    }
  } catch (err) {
    console.warn('[tts] failed:', err);
  } finally {
    ttsBusy = false;
    if (ttsQueue.length > 0) void processTtsQueue();
  }
}

async function playApi(text: string): Promise<void> {
  const r = await fetch('/api/voice/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}: ${await r.text().catch(() => '')}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  ttsCurrent = a;
  await new Promise<void>((resolve) => {
    const done = () => { URL.revokeObjectURL(url); if (ttsCurrent === a) ttsCurrent = null; resolve(); };
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  });
}

async function playBrowser(text: string): Promise<void> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const synth = window.speechSynthesis;
  return new Promise((resolve) => {
    const zh = synth.getVoices().find((v) => /^zh|cmn/i.test(v.lang));
    // Quiet warm-up absorbs the audio-device wake-up clip on the first line.
    if (!synth.speaking && !synth.pending) {
      const warm = new SpeechSynthesisUtterance('嗯。嗯。嗯。');
      warm.lang = 'zh-TW';
      warm.volume = 0.1;
      if (zh) warm.voice = zh;
      synth.speak(warm);
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW';
    if (zh) u.voice = zh;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
  });
}

interface Props {
  send: (msg: object) => void;
  /** Brain state, fed from App (whose ws.onmessage is the reliable sink). */
  working: boolean;
  lastReply: { text: string; ts: number } | null;
  sttCfg: { provider: 'browser' | 'openai' | 'gemini'; language: string };
  ttsCfg: TtsCfg;
  wake: {
    enabled: boolean; supported: boolean; armed: boolean; phrase: string;
    onToggle: () => void; onPhraseChange: (v: string) => void;
  };
  awaiting: AgentNotif[];
  running: number;
  idle: number;
  onSelectAgent: (projectId: string, agentId: string) => void;
  onOpenFull: () => void;
}

export default function JarvisHud({
  send, working, lastReply, sttCfg, ttsCfg, wake, awaiting, running, idle, onSelectAgent, onOpenFull,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [voiceOut, setVoiceOut] = useState(
    () => localStorage.getItem('termhive:voice-out') === '1',
  );
  const reply = (lastReply?.text || '').trim();

  const submit = (textArg?: string) => {
    const t = (textArg ?? input).trim();
    if (!t) return;
    send({ type: 'brain:send', message: t });
    setInput('');
  };

  // Voice input — fill the box, and on a final result send automatically.
  // The provider/language come from the user's settings (Browser / OpenAI / Gemini).
  const speech = useSpeechInput(
    (t, final) => { setInput(t); if (final && t.trim()) submit(t); },
    { provider: sttCfg.provider, language: sttCfg.language },
  );
  const ttsCfgRef = useRef(ttsCfg);
  ttsCfgRef.current = ttsCfg;
  const inputRef = useRef<HTMLInputElement>(null);
  const voiceOutRef = useRef(voiceOut);
  voiceOutRef.current = voiceOut;

  useEffect(() => {
    localStorage.setItem('termhive:voice-out', voiceOut ? '1' : '0');
    if (!voiceOut) stopSpeaking();
  }, [voiceOut]);

  // Speak each new Keeper reply when voice replies are on.
  useEffect(() => {
    if (lastReply && voiceOutRef.current) speakReply(lastReply.text, ttsCfgRef.current);
  }, [lastReply]);

  // A new turn starting cuts off any in-progress speech.
  useEffect(() => {
    if (working) stopSpeaking();
  }, [working]);

  useEffect(() => {
    if (expanded) setTimeout(() => inputRef.current?.focus(), 80);
  }, [expanded]);

  const state = working ? 'thinking'
    : (speech.listening || wake.armed) ? 'listening'
    : 'idle';

  return (
    <div className="jv">
      {expanded && (
        <div className="jv-panel">
          <div className="jv-panel-h">
            <div className={'jv-mini-orb ' + state}><Ic.logo size={12} /></div>
            <span className="jv-panel-t">The Keeper</span>
            <button
              className={'jv-x' + (voiceOut ? ' on' : '')}
              onClick={() => setVoiceOut((v) => !v)}
              title={voiceOut ? 'Voice replies: on' : 'Voice replies: off'}
            >
              <Ic.volume size={13} />
            </button>
            {wake.supported && (
              <button
                className={'jv-x' + (wake.enabled ? ' on' : '')}
                onClick={wake.onToggle}
                title={wake.enabled ? 'Wake word on — say “Hey Queen”' : 'Wake word off'}
              >
                <Ic.mic size={13} />
              </button>
            )}
            <button className="jv-x" onClick={onOpenFull} title="Open full conversation">
              <Ic.message size={12} />
            </button>
            <button className="jv-x" onClick={() => setExpanded(false)} title="Collapse">
              <Ic.x size={12} />
            </button>
          </div>

          {wake.enabled && (
            <div className="jv-wake-cfg">
              <Ic.mic size={11} />
              <span className="jv-wake-lbl">喚醒詞</span>
              <input
                className="jv-wake-input"
                value={wake.phrase}
                onChange={(e) => wake.onPhraseChange(e.target.value)}
                placeholder="中文喚醒詞…"
                spellCheck={false}
              />
            </div>
          )}

          <div className="jv-status">
            <span className="jv-stat"><i className="sdot running" />{running} running</span>
            <span className="jv-stat"><i className="sdot awaiting_input" />{awaiting.length} awaiting</span>
            <span className="jv-stat"><i className="sdot idle" />{idle} idle</span>
          </div>

          {awaiting.length > 0 && (
            <div className="jv-await">
              {awaiting.slice(0, 6).map((n) => (
                <button
                  key={n.agentId}
                  className="jv-await-row"
                  onClick={() => onSelectAgent(n.projectId, n.agentId)}
                >
                  <span className="sdot awaiting_input" />
                  <span className="jv-await-t">{n.agentName}</span>
                  <span className="jv-await-s">{n.projectName}</span>
                </button>
              ))}
            </div>
          )}

          {(working || reply) && (
            <div className="jv-reply">
              {working ? (
                <span className="jv-reply-w">
                  <span className="cmd-dot" /><span className="cmd-dot" /><span className="cmd-dot" />
                  The Keeper is working…
                </span>
              ) : (
                <div
                  className="jv-reply-t cmd-md"
                  dangerouslySetInnerHTML={{ __html: renderMd(reply) }}
                />
              )}
            </div>
          )}

          <div className="jv-compose">
            {speech.supported && (
              <button
                className={'jv-mic' + (speech.listening ? ' on' : '')}
                onClick={speech.toggle}
                title={speech.error || (speech.listening ? 'Stop listening' : 'Voice')}
              >
                <Ic.mic size={14} />
              </button>
            )}
            <input
              ref={inputRef}
              className="jv-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
              placeholder="Speak or type to The Keeper…"
            />
            <button className="jv-send" onClick={() => submit()} disabled={!input.trim()} title="Send">
              <Ic.send size={13} />
            </button>
          </div>
        </div>
      )}

      <button
        className={'jv-orb ' + state}
        onClick={() => setExpanded((e) => !e)}
        title="The Keeper"
      >
        <span className="jv-ring" />
        <span className="jv-ring jv-ring2" />
        <span className="jv-core"><Ic.logo size={21} /></span>
        {awaiting.length > 0 && <span className="jv-orb-badge">{awaiting.length}</span>}
      </button>
    </div>
  );
}
