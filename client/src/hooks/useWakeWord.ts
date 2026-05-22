/**
 * useWakeWord — always-on wake-word listening via the Web Speech API.
 *
 * When enabled, runs a continuous SpeechRecognition. The wake phrase
 * ("hey queen" / "queen" / "皇后") arms it and the next utterance is taken as
 * a command; saying "queen, <command>" in one breath fires immediately.
 *
 * Chrome / Edge only, secure context only, and the tab should stay in the
 * foreground (browsers throttle background-tab audio). Chrome ends continuous
 * recognition periodically — it is restarted automatically.
 *
 * Everything is logged under the `[wake]` prefix — open the browser console
 * (F12 → Console) to see what it hears and whether the phrase matched.
 */

import { useEffect, useRef, useState } from 'react';

const ARM_TIMEOUT = 9000; // disarm if no command follows the wake phrase

interface WakeOptions {
  enabled: boolean;
  /** The wake phrase to listen for. Must be Chinese — the recognition runs in
   *  zh-TW (for the commands), and a zh model won't transcribe English. */
  phrase: string;
  onWake: () => void;
  onCommand: (text: string) => void;
}

export function useWakeWord({ enabled, phrase, onWake, onCommand }: WakeOptions) {
  const [armed, setArmed] = useState(false);
  const [listening, setListening] = useState(false);
  const armedRef = useRef(false);
  const phraseRef = useRef(phrase);
  phraseRef.current = phrase;
  const cbRef = useRef({ onWake, onCommand });
  cbRef.current = { onWake, onCommand };

  const SR =
    typeof window !== 'undefined'
      ? (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
          .SpeechRecognition ||
        (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
      : undefined;
  const supported = !!SR;

  useEffect(() => {
    const Rec = SR as { new (): SpeechRecognitionLike } | undefined;
    const secure = typeof window !== 'undefined' ? window.isSecureContext : false;
    console.log('[wake] effect — enabled:', enabled, 'supported:', !!Rec, 'secureContext:', secure);
    if (!Rec || !enabled) return;
    if (!secure) {
      console.warn('[wake] not a secure context — open Termhive via http://localhost, not an IP');
    }
    let stopped = false;
    let rec: SpeechRecognitionLike | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let armTimer: ReturnType<typeof setTimeout> | null = null;

    const setArmedState = (v: boolean) => { armedRef.current = v; setArmed(v); };
    const clearArmTimer = () => { if (armTimer) { clearTimeout(armTimer); armTimer = null; } };

    const handleResult = (e: SpeechResultEvent) => {
      const last = e.results?.[e.results.length - 1];
      if (!last) return;
      const raw = String(last[0]?.transcript || '').trim();
      console.log(`[wake] heard ${last.isFinal ? 'FINAL' : 'interim'}:`, JSON.stringify(raw));
      if (!last.isFinal || !raw) return;

      if (armedRef.current) {
        clearArmTimer();
        setArmedState(false);
        console.log('[wake] ✦ command (was armed):', raw);
        cbRef.current.onCommand(raw);
        return;
      }
      const lc = raw.toLowerCase();
      const term = phraseRef.current.trim().toLowerCase();
      const hit = term ? lc.indexOf(term) : -1;
      if (hit < 0) {
        console.log(`[wake] · no wake word ("${term}") in that — ignored`);
        return;
      }
      const after = raw.slice(hit + term.length).replace(/^[\s,，。、:：!！?？]+/, '').trim();
      if (after) {
        console.log('[wake] ✦ wake word + command in one breath:', after);
        cbRef.current.onCommand(after);
      } else {
        console.log('[wake] ✦ wake word matched — armed, waiting for the command');
        setArmedState(true);
        cbRef.current.onWake();
        clearArmTimer();
        armTimer = setTimeout(() => {
          armTimer = null;
          console.log('[wake] arm timed out — disarmed');
          setArmedState(false);
        }, ARM_TIMEOUT);
      }
    };

    const scheduleRestart = () => {
      if (stopped || restartTimer) return;
      restartTimer = setTimeout(() => { restartTimer = null; start(); }, 600);
    };

    const start = () => {
      if (stopped) return;
      let r: SpeechRecognitionLike;
      try { r = new Rec(); }
      catch (err) { console.warn('[wake] new SpeechRecognition() threw:', err); return; }
      r.lang = 'zh-TW';
      r.continuous = true;
      r.interimResults = true;
      r.onstart = () => { console.log('[wake] ▶ recognition started — listening'); setListening(true); };
      r.onspeechstart = () => console.log('[wake] · speech detected');
      r.onresult = handleResult;
      r.onerror = (ev: { error?: string }) => {
        const code = String(ev?.error || '');
        if (code === 'no-speech' || code === 'aborted') {
          console.log('[wake] (', code, '— normal, will restart)');
        } else {
          console.warn('[wake] error:', code);
        }
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          stopped = true;
          console.warn('[wake] microphone blocked — toggle wake word off and on after allowing mic access');
        }
      };
      r.onend = () => {
        rec = null;
        setListening(false);
        if (!stopped) { console.log('[wake] ■ ended — restarting in 600ms'); scheduleRestart(); }
      };
      rec = r;
      try { console.log('[wake] starting recognition…'); r.start(); }
      catch (err) { console.warn('[wake] start() threw:', err); rec = null; scheduleRestart(); }
    };

    start();

    return () => {
      console.log('[wake] cleanup — stopping');
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      clearArmTimer();
      setArmedState(false);
      setListening(false);
      try { rec?.abort(); } catch { /* ignore */ }
      rec = null;
    };
  }, [SR, enabled]);

  return { supported, armed, listening };
}

// Minimal structural types for the Web Speech API (not in lib.dom for webkit).
interface SpeechResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: () => void;
  onspeechstart: () => void;
  onresult: (e: SpeechResultEvent) => void;
  onerror: (e: { error?: string }) => void;
  onend: () => void;
  start: () => void;
  abort: () => void;
}
