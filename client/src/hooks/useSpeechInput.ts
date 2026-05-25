/**
 * useSpeechInput — push-to-talk speech-to-text.
 *
 * Two modes, picked per call via `options.provider`:
 *  - `'browser'` (default): Web Speech API. Free, in-browser, Chrome/Edge only,
 *    needs a secure context (https or http://localhost).
 *  - `'openai'` / `'gemini'`: records the mic with MediaRecorder and POSTs the
 *    audio blob to `/api/voice/transcribe`, which proxies to the API. Cleaner
 *    Mandarin, costs API quota.
 *
 * Returned API is the same regardless of mode — `toggle()` starts/stops, and
 * `onText(text, final)` fires with the result.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechResultHandler = (text: string, final: boolean) => void;
export interface SpeechOptions {
  provider?: 'browser' | 'openai' | 'gemini';
  language?: string;
}

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

type Active =
  | { kind: 'browser'; obj: { stop: () => void } }
  | { kind: 'recorder'; obj: MediaRecorder; stream: MediaStream }
  | null;

export function useSpeechInput(onText: SpeechResultHandler, options: SpeechOptions = {}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef<Active>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const optRef = useRef(options);
  optRef.current = options;

  const SR =
    typeof window !== 'undefined'
      ? (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
          .SpeechRecognition ||
        (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
      : undefined;
  const browserSupported = !!SR;
  const mediaSupported =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const provider = options.provider || 'browser';
  const supported = provider === 'browser' ? browserSupported : mediaSupported;
  const secure = typeof window !== 'undefined' ? window.isSecureContext : true;

  const stop = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    try { a.obj.stop(); } catch { /* ignore */ }
  }, []);

  const startBrowser = useCallback(() => {
    const Rec = SR as { new (): {
      lang: string; interimResults: boolean; continuous: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void;
      onerror: (e: { error?: string }) => void;
      onend: () => void;
      start: () => void; stop: () => void;
    } } | undefined;
    if (!Rec) { setError('not supported'); return; }
    if (!secure) { setError(explainError('', false)); return; }
    setError(null);
    const r = new Rec();
    r.lang = optRef.current.language || 'zh-TW';
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      let text = '';
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      onTextRef.current(text.trim(), final);
    };
    r.onerror = (e) => setError(explainError(String(e?.error || 'error'), secure));
    r.onend = () => { activeRef.current = null; setListening(false); };
    activeRef.current = { kind: 'browser', obj: r };
    setListening(true);
    try { r.start(); }
    catch (err) {
      console.warn('[speech] start failed:', err);
      activeRef.current = null;
      setListening(false);
      setError('could not start');
    }
  }, [SR, secure]);

  const startApi = useCallback(async () => {
    if (!mediaSupported) { setError('mic not supported'); return; }
    setError(null);
    let stream: MediaStream;
    try {
      // Disable the default browser audio processing — echoCancellation,
      // noiseSuppression and AGC need a second or two to adapt and end up
      // suppressing the first part of speech. We want the raw mic so STT
      // gets the full utterance.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch {
      setError('microphone blocked — allow mic access for this site');
      return;
    }

    const pick = (mimes: string[]) => mimes.find((m) => MediaRecorder.isTypeSupported(m));
    const mime = pick(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']);
    let mr: MediaRecorder;
    try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (err) {
      console.warn('[speech] MediaRecorder failed:', err);
      stream.getTracks().forEach((t) => t.stop());
      setError('recorder failed');
      return;
    }

    const chunks: BlobPart[] = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mr.onerror = (e) => console.warn('[speech] recorder error:', e);
    stream.getAudioTracks().forEach((t) => {
      t.onended = () => console.warn('[speech] mic track ended — stream taken away');
    });

    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      activeRef.current = null;
      setListening(false);
      const blobMime = mr.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunks, { type: blobMime });
      if (blob.size === 0) return;
      try {
        const r = await fetch('/api/voice/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': blobMime },
          body: blob,
        });
        if (!r.ok) {
          let msg = `transcribe ${r.status}`;
          try { const j = await r.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
          setError(msg);
          return;
        }
        const j = (await r.json()) as { text?: string };
        const text = (j.text || '').trim();
        if (text) onTextRef.current(text, true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    activeRef.current = { kind: 'recorder', obj: mr, stream };
    setListening(true);
    // No timeslice — one ondataavailable on stop() with the complete blob.
    // Push-to-talk clips are short; chunking added complexity without value.
    mr.start();
  }, [mediaSupported]);

  const toggle = useCallback(() => {
    if (activeRef.current) { stop(); return; }
    const p = optRef.current.provider || 'browser';
    if (p === 'browser') startBrowser();
    else void startApi();
  }, [stop, startBrowser, startApi]);

  // Abort any in-flight capture on unmount.
  useEffect(() => () => {
    const a = activeRef.current;
    if (!a) return;
    try { a.obj.stop(); } catch { /* ignore */ }
    if (a.kind === 'recorder') a.stream.getTracks().forEach((t) => t.stop());
  }, []);

  return { supported, listening, error, toggle };
}
