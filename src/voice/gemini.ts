/**
 * Google Gemini API — STT via multimodal audio input (no dedicated STT
 * endpoint) and TTS via the generateContent AUDIO modality.
 *
 * Gemini TTS returns raw PCM (LINEAR16, 24kHz, mono); we wrap it in a WAV
 * container so the browser <audio> element can play it directly.
 */

import { getApiKey } from './config.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function key(): string {
  const k = getApiKey('gemini');
  if (!k) throw new Error('Gemini API key not set — add it in Voice Settings or .env');
  return k;
}

export async function transcribeGemini(
  audio: Buffer,
  mime: string,
  model: string,
  language?: string,
): Promise<string> {
  const prompt = language
    ? `Transcribe this audio in ${language}. Return only the transcribed text, no explanation, no quotes.`
    : 'Transcribe this audio. Return only the transcribed text, no explanation, no quotes.';

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime, data: audio.toString('base64') } },
        ],
      },
    ],
  };
  const r = await fetch(
    `${GEMINI_BASE}/models/${model || 'gemini-2.5-flash'}:generateContent?key=${key()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) throw new Error(`Gemini STT ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (j.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

export async function ttsGemini(
  text: string,
  model: string,
  voice: string,
): Promise<{ audio: Buffer; mime: string }> {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } },
      },
    },
  };
  const r = await fetch(
    `${GEMINI_BASE}/models/${model || 'gemini-2.5-flash-tts'}:generateContent?key=${key()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) throw new Error(`Gemini TTS ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
    }>;
  };
  const part = j.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!part?.data) throw new Error('Gemini TTS returned no audio');
  const pcm = Buffer.from(part.data, 'base64');
  const wav = pcmToWav(pcm, 24000, 1, 16);
  return { audio: wav, mime: 'audio/wav' };
}

/** Wrap raw PCM bytes in a minimal WAV (RIFF) container. */
function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
