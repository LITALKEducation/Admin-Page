// Google Cloud Vertex AI (Gemini) client for the AI chat assistant.
// Auth is a self-signed JWT exchanged for an OAuth2 bearer token — the same
// service-account flow Google's own client libraries use, reimplemented
// with `jose` (already a dependency, used for Auth0 JWT verification)
// since Cloudflare Workers can't run Google's Node-only auth library.
import { importPKCS8, SignJWT } from 'jose';
import type { Env } from './types';

const MODEL = 'gemini-2.5-flash';
const MAX_OUTPUT_TOKENS = 1024;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Thrown when the Vertex AI service-account secrets aren't configured —
// callers turn this into a 503 rather than letting it surface as an
// unhandled error.
export class ChatNotConfiguredError extends Error {}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const clientEmail = env.GOOGLE_VERTEX_CLIENT_EMAIL;
  const privateKeyPem = env.GOOGLE_VERTEX_PRIVATE_KEY;
  if (!clientEmail || !privateKeyPem) throw new ChatNotConfiguredError('Google Vertex AI credentials are not set');

  // Secrets set via `wrangler secret put` from a one-line paste often carry
  // literal "\n" instead of real newlines — normalise before PEM parsing.
  const privateKey = await importPKCS8(privateKeyPem.replace(/\\n/g, '\n'), 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(clientEmail)
    .setSubject(clientEmail)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth token exchange failed (HTTP ${res.status})`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

export async function chatReply(env: Env, systemPrompt: string, history: ChatTurn[], userMessage: string): Promise<string> {
  if (!env.GOOGLE_VERTEX_PROJECT_ID || !env.GOOGLE_VERTEX_CLIENT_EMAIL || !env.GOOGLE_VERTEX_PRIVATE_KEY) {
    throw new ChatNotConfiguredError('Google Vertex AI is not configured');
  }

  const accessToken = await getAccessToken(env);
  const location = env.GOOGLE_VERTEX_LOCATION || 'us-central1';
  const url =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${env.GOOGLE_VERTEX_PROJECT_ID}` +
    `/locations/${location}/publishers/google/models/${MODEL}:generateContent`;

  const contents = [...history, { role: 'user' as const, content: userMessage }].map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
  });
  if (!res.ok) throw new Error(`Vertex AI request failed (HTTP ${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
