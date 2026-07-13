import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './types';

// Kept off adaptive thinking: replies here are short customer-support/staff
// answers, not multi-step reasoning tasks, so the latency/token cost of
// thinking isn't worth it. The system prompts instead ask for a direct
// final answer (see chat.ts) to avoid the verbose-reasoning-in-the-response
// behavior Opus 4.8 can show with thinking off.
const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 1024;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Thrown when ANTHROPIC_API_KEY isn't configured — callers turn this into a
// 503 rather than letting it surface as an unhandled error.
export class ChatNotConfiguredError extends Error {}

export async function chatReply(env: Env, systemPrompt: string, history: ChatTurn[], userMessage: string): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new ChatNotConfiguredError('ANTHROPIC_API_KEY is not set');

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    output_config: { effort: 'medium' },
    messages: [...history, { role: 'user', content: userMessage }],
  });

  const text = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
  return text?.text ?? '';
}
