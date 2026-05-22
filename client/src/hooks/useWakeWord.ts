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
 */

import { useEffect, useRef, useState } from 'react';

const WAKE_TERMS = ['hey queen', 'queen', '皇后', '皇後'];
const ARM_TIMEOUT = 9000; // disarm if no command follows the wake phrase

interface WakeOptions {
  enabled: boolean;
  onWake: () => void;
  onCommand: (text: string) => void;
}

export function useWakeWord({ enabled, onWake, onCommand }: WakeOptions) {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
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
    if (!Rec || !enabled) return;
    let stopped = false;
    let rec: SpeechRecognitionLike | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let armTimer: ReturnType<typeof setTimeout> | null = null;

    const setArmedState = (v: boolean) => { armedRef.current = v; setArmed(v); };
    const clearArmTimer = () => { if (armTimer) { clearTimeout(armTimer); armTimer = null; } };

    const handleResult = (e: SpeechResultEvent) => {
      const last = e.results?.[e.results.length - 1];
      if (!last || !last.isFinal) return;
      const raw = String(last[0]?.transcript || '').trim();
      if (!raw) return;

      if (armedRef.current) {
        clearArmTimer();
        setArmedState(false);
        cbRef.current.onCommand(raw);
        return;
      }
      const lc = raw.toLowerCase();
      let hit = -1;
      let hitLen = 0;
      for (const term of WAKE_TERMS) {
        const i = lc.indexOf(term);
        if (i >= 0 && (hit < 0 || i < hit)) { hit = i; hitLen = term.length; }
      }
      if (hit < 0) return;
      const after = raw.slice(hit + hitLen).replace(/^[\s,，。、:：!！?？]+/, '').trim();
      if (after) {
        cbRef.current.onCommand(after);
      } else {
        setArmedState(true);
        cbRef.current.onWake();
        clearArmTimer();
        armTimer = setTimeout(() => { armTimer = null; setArmedState(false); }, ARM_TIMEOUT);
      }
    };

    const scheduleRestart = () => {
      if (stopped || restartTimer) return;
      restartTimer = setTimeout(() => { restartTimer = null; start(); }, 600);
    };

    const start = () => {
      if (stopped) return;
      const r = new Rec();
      r.lang = 'zh-TW';
      r.continuous = true;
      r.interimResults = false;
      r.onresult = handleResult;
      r.onerror = (ev: { error?: string }) => {
        const code = String(ev?.error || '');
        if (code === 'not-allowed' || code === 'service-not-allowed') stopped = true;
      };
      r.onend = () => { rec = null; scheduleRestart(); };
      rec = r;
      try { r.start(); } catch { rec = null; scheduleRestart(); }
    };

    start();

    return () => {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      clearArmTimer();
      setArmedState(false);
      try { rec?.abort(); } catch { /* ignore */ }
      rec = null;
    };
  }, [SR, enabled]);

  return { supported, armed };
}

// Minimal structural types for the Web Speech API (not in lib.dom for webkit).
interface SpeechResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: (e: SpeechResultEvent) => void;
  onerror: (e: { error?: string }) => void;
  onend: () => void;
  start: () => void;
  abort: () => void;
}
