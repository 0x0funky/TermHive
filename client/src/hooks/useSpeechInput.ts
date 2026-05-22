/**
 * useSpeechInput — push-to-talk speech-to-text via the browser Web Speech API.
 *
 * Chrome / Edge support it (localhost counts as a secure context); elsewhere
 * the hook reports `supported: false` and the caller hides the mic button.
 * Voice is the natural input for "talk to The Keeper" — this is the first
 * piece of the conversational-orchestrator wedge.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechResultHandler = (text: string, final: boolean) => void;

export function useSpeechInput(onText: SpeechResultHandler, lang = 'zh-TW') {
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  // Keep the latest callback reachable without rebuilding start().
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const SR =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : undefined;
  const supported = !!SR;

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
  }, []);

  const start = useCallback(() => {
    if (!SR || recRef.current) return;
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
      onTextRef.current(text.trim(), final);
    };
    rec.onerror = () => { /* surfaced via onend → listening:false */ };
    rec.onend = () => { recRef.current = null; setListening(false); };
    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      recRef.current = null;
      setListening(false);
    }
  }, [SR, lang]);

  const toggle = useCallback(() => {
    if (recRef.current) stop();
    else start();
  }, [start, stop]);

  // Abort any in-flight recognition when the component unmounts.
  useEffect(() => () => {
    try { recRef.current?.abort(); } catch { /* ignore */ }
  }, []);

  return { supported, listening, toggle };
}
