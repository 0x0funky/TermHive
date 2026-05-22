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
import Ic from './Icons';
import { useSpeechInput } from '../hooks/useSpeechInput';
import type { AgentNotif } from './NotificationCenter';

function stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}

/**
 * Speak a short, spoken-friendly version of a Keeper reply — the Keeper opens
 * each reply with a plain summary sentence (see its persona), so we strip
 * markdown and speak just that first sentence. The screen still shows it all.
 */
function speakReply(text: string) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')            // drop code blocks
    .replace(/`([^`]+)`/g, '$1')                // inline code → plain
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // links → label
    .replace(/[*_#>]/g, '')                     // markdown symbols
    .replace(/^\s*[-•]\s*/gm, '')               // list bullets
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return;
  const spoken = (clean.split(/(?<=[。.!?！?])\s/)[0] || clean).slice(0, 220);
  const u = new SpeechSynthesisUtterance(spoken);
  u.lang = 'zh-TW';
  const zh = window.speechSynthesis.getVoices().find((v) => /^zh|cmn/i.test(v.lang));
  if (zh) u.voice = zh;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
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
  const reply = lastReply?.text || '';
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
                <span className="jv-reply-t">
                  {reply.slice(0, 280)}{reply.length > 280 ? '…' : ''}
                </span>
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
