/**
 * useSpeechInput — push-to-talk speech-to-text via the browser Web Speech API.
 *
 * Chrome / Edge support it. The recognition service needs a **secure context**
 * (https, or http://localhost) — over a plain http://<ip> it will start but
 * never return results. Errors are surfaced via `error` and logged to the
 * console so failures are diagnosable instead of silent.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechResultHandler = (text: string, final: boolean) => void;

/** Friendly explanation for a SpeechRecognition error code. */
function explainError(code: string, secure: boolean): string {
  if (!secure) return 'not a secure context — open Termhive via http://localhost, not an IP';
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'microphone blocked — allow mic access for this site';
    case 'no-speech':
      return 'no speech heard — check the mic is not muted / is the right device';
    case 'audio-capture':
      return 'no microphone found';
    case 'network':
      return 'speech service unreachable — check the network';
    default:
      return code || 'unknown error';
  }
}

export function useSpeechInput(onText: SpeechResultHandler, lang = 'zh-TW') {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<any>(null);
  // Keep the latest callback reachable without rebuilding start().
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const SR =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : undefined;
  const supported = !!SR;
  const secure = typeof window !== 'undefined' ? window.isSecureContext : true;

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
  }, []);

  const start = useCallback(() => {
    if (!SR || recRef.current) return;
    setError(null);

    if (!secure) {
      // The API exists but won't transcribe off a secure origin.
      console.warn('[speech] insecure context — open Termhive via http://localhost');
      setError(explainError('', false));
      return;
    }

    const rec = new SR();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;

    rec.onresult = (e: any) => {
      let text = '';
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      console.debug('[speech] heard:', JSON.stringify(text), 'final:', final);
      onTextRef.current(text.trim(), final);
    };
    rec.onerror = (e: any) => {
      const code = String(e?.error || 'error');
      console.warn('[speech] error:', code, '—', explainError(code, secure));
      setError(explainError(code, secure));
    };
    rec.onend = () => {
      console.debug('[speech] ended');
      recRef.current = null;
      setListening(false);
    };

    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
      console.debug('[speech] listening… lang=', lang);
    } catch (err) {
      console.warn('[speech] start failed:', err);
      recRef.current = null;
      setListening(false);
      setError('could not start');
    }
  }, [SR, lang, secure]);

  const toggle = useCallback(() => {
    if (recRef.current) stop();
    else start();
  }, [start, stop]);

  // Abort any in-flight recognition when the component unmounts.
  useEffect(() => () => {
    try { recRef.current?.abort(); } catch { /* ignore */ }
  }, []);

  return { supported, listening, error, toggle };
}
