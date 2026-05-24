/** OpenAI Audio API — STT (transcriptions) + TTS (speech). */

import { getApiKey } from './config.js';

export async function transcribeOpenAI(
  audio: Buffer,
  mime: string,
  model: string,
  language?: string,
): Promise<string> {
  const apiKey = getApiKey('openai');
  if (!apiKey) throw new Error('OpenAI API key not set — add it in Voice Settings or .env');

  const ext = mime.split('/')[1]?.split(';')[0] || 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `audio.${ext}`);
  form.append('model', model || 'gpt-4o-transcribe');
  if (language) form.append('language', language);

  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!r.ok) throw new Error(`OpenAI STT ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { text?: string };
  return j.text || '';
}

export async function ttsOpenAI(
  text: string,
  model: string,
  voice: string,
): Promise<{ audio: Buffer; mime: string }> {
  const apiKey = getApiKey('openai');
  if (!apiKey) throw new Error('OpenAI API key not set — add it in Voice Settings or .env');

  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini-tts',
      voice: voice || 'alloy',
      input: text,
      response_format: 'mp3',
    }),
  });
  if (!r.ok) throw new Error(`OpenAI TTS ${r.status}: ${await r.text()}`);
  return { audio: Buffer.from(await r.arrayBuffer()), mime: 'audio/mpeg' };
}
