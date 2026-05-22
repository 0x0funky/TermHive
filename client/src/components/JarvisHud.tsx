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

function stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}

/** Pull the Keeper's explicit spoken-summary line (`🔊 …`) out of a reply. */
const SPOKEN_RE = /🔊[ \t]*([^\n]+)/;

/**
 * Speak a Keeper reply. The Keeper ends every reply with an explicit
 * `🔊 <one sentence>` line — its own chosen takeaway — and we speak exactly
 * that. If it's missing (old reply / non-compliance), fall back to the first
 * two sentences, markdown stripped.
 */
function speakReply(text: string) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
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
  spoken = spoken.slice(0, 500).trim();
  if (!spoken) return;
  const synth = window.speechSynthesis;
  const zh = synth.getVoices().find((v) => /^zh|cmn/i.test(v.lang));
  // When the synth is idle the audio device sleeps; waking it clips the start
  // of the next utterance. Queue a short, quiet warm-up to take that hit, so
  // the real line is heard from its first word.
  if (!synth.speaking && !synth.pending) {
    const warm = new SpeechSynthesisUtterance('嗯。嗯。嗯。');
    warm.lang = 'zh-TW';
    warm.volume = 0.1;
    if (zh) warm.voice = zh;
    synth.speak(warm);
  }
  const u = new SpeechSynthesisUtterance(spoken);
  u.lang = 'zh-TW';
  if (zh) u.voice = zh;
  // No cancel() — utterances queue, so the step-by-step narration and the
  // closing summary are spoken in order. stopSpeaking() clears the queue.
  synth.speak(u);
}

interface Props {
  send: (msg: object) => void;
  /** Brain state, fed from App (whose ws.onmessage is the reliable sink). */
  working: boolean;
  lastReply: { text: string; ts: number } | null;
  awaiting: AgentNotif[];
  running: number;
  idle: number;
  onSelectAgent: (projectId: string, agentId: string) => void;
  onOpenFull: () => void;
}

export default function JarvisHud({
  send, working, lastReply, awaiting, running, idle, onSelectAgent, onOpenFull,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [voiceOut, setVoiceOut] = useState(
    () => localStorage.getItem('termhive:voice-out') === '1',
  );
  const reply = (lastReply?.text || '').trim();
  const speech = useSpeechInput((t) => setInput(t));
  const inputRef = useRef<HTMLInputElement>(null);
  const voiceOutRef = useRef(voiceOut);
  voiceOutRef.current = voiceOut;

  useEffect(() => {
    localStorage.setItem('termhive:voice-out', voiceOut ? '1' : '0');
    if (!voiceOut) stopSpeaking();
  }, [voiceOut]);

  // Speak each new Keeper reply when voice replies are on.
  useEffect(() => {
    if (lastReply && voiceOutRef.current) speakReply(lastReply.text);
  }, [lastReply]);

  // A new turn starting cuts off any in-progress speech.
  useEffect(() => {
    if (working) stopSpeaking();
  }, [working]);

  useEffect(() => {
    if (expanded) setTimeout(() => inputRef.current?.focus(), 80);
  }, [expanded]);

  const state = working ? 'thinking' : speech.listening ? 'listening' : 'idle';

  const submit = () => {
    const t = input.trim();
    if (!t) return;
    send({ type: 'brain:send', message: t });
    setInput('');
  };

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
            <button className="jv-x" onClick={onOpenFull} title="Open full conversation">
              <Ic.message size={12} />
            </button>
            <button className="jv-x" onClick={() => setExpanded(false)} title="Collapse">
              <Ic.x size={12} />
            </button>
          </div>

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
            <button className="jv-send" onClick={submit} disabled={!input.trim()} title="Send">
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
