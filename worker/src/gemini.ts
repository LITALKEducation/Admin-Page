// Gemini Developer API (Google AI Studio) client for the AI chat assistant.
// Simple API-key auth — no service account / OAuth token exchange needed.
import type { Env } from './types';

const MODEL = 'gemini-3.1-flash-lite';
const MAX_OUTPUT_TOKENS = 1024;
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Thrown when GEMINI_API_KEY isn't configured — callers turn this into a
// 503 rather than letting it surface as an unhandled error.
export class ChatNotConfiguredError extends Error {}

export async function chatReply(env: Env, systemPrompt: string, history: ChatTurn[], userMessage: string): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new ChatNotConfiguredError('Gemini API is not configured');

  const contents = [...history, { role: 'user' as const, content: userMessage }].map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API request failed (HTTP ${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
