// Per-surface configuration for the น้องลิลลี่ AI assistant, edited from the
// admin panel's "ตั้งค่า AI Chat" screen.
//
// Three surfaces share one settings row (ai_chat_settings, single-row by
// CHECK constraint):
//   portal  — signed-in student/parent asking about their own account
//   general — anonymous visitor on the public marketing site
//   staff   — the assistant inside the legacy admin panel
//
// Each surface carries a kill switch, a daily message cap, a set of
// point-and-click options, and a free-form instruction block. The options
// are stored as JSON and rendered into prompt sentences here at request
// time rather than being saved as generated text, so this wording can be
// revised without migrating stored data.

export type AiSurface = 'staff' | 'portal' | 'general';

// Fallbacks for a surface with no stored row, and the values migration 0020
// seeds the columns with. These were the hardcoded limits in chat.ts before
// they became configurable.
export const DEFAULT_DAILY_LIMITS: Record<AiSurface, number> = { staff: 100, portal: 40, general: 20 };

export const AI_SURFACES: AiSurface[] = ['staff', 'portal', 'general'];

export interface AiChatOptions {
  tone?: 'friendly' | 'formal' | 'concise';
  length?: 'short' | 'medium' | 'detailed';
  emoji?: boolean;
  language?: 'auto' | 'th' | 'en';
  unknown?: 'admit' | 'referStaff';
  referContact?: boolean;
  noPricing?: boolean;
}

export interface AiSurfaceSettings {
  enabled: boolean;
  dailyLimit: number;
  options: AiChatOptions;
  instructions: string;
}

export type AiChatSettings = Record<AiSurface, AiSurfaceSettings>;

export const MAX_INSTRUCTIONS_LENGTH = 4000;
const MAX_DAILY_LIMIT = 1000;

// Every option value we will accept from the client. Anything outside these
// sets is dropped rather than rejected: an unknown value can only come from
// a stale client or a hand-rolled request, and silently ignoring it keeps a
// single bad field from failing the whole save.
const OPTION_VALUES = {
  tone: ['friendly', 'formal', 'concise'],
  length: ['short', 'medium', 'detailed'],
  language: ['auto', 'th', 'en'],
  unknown: ['admit', 'referStaff'],
} as const;

export function parseOptions(raw: unknown): AiChatOptions {
  const source: Record<string, unknown> =
    typeof raw === 'string' ? safeJson(raw) : raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const parsed: AiChatOptions = {};
  for (const key of ['tone', 'length', 'language', 'unknown'] as const) {
    const value = source[key];
    if (typeof value === 'string' && (OPTION_VALUES[key] as readonly string[]).includes(value)) {
      // The membership check above is what makes this cast safe.
      parsed[key] = value as never;
    }
  }
  for (const key of ['emoji', 'referContact', 'noPricing'] as const) {
    if (typeof source[key] === 'boolean') parsed[key] = source[key] as boolean;
  }
  return parsed;
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Reply-language and formatting instruction. This replaces (rather than
// appends to) the assistant's default "reply in whatever language the user
// wrote in" line, since pinning a language has to override that default.
export function styleLine(options: AiChatOptions): string {
  const parts: string[] = [];
  if (options.language === 'th') parts.push('Always reply in Thai, even if the user writes in another language.');
  else if (options.language === 'en') parts.push('Always reply in English, even if the user writes in another language.');
  else parts.push('Reply in whichever language the user just wrote in (Thai or English).');

  if (options.length === 'short') parts.push('Keep replies very short — one or two sentences, or a few bullet points at most.');
  else if (options.length === 'detailed') parts.push('Give thorough replies with the relevant background and examples, while staying readable.');
  else parts.push('Keep replies to a short paragraph or a handful of bullet points.');

  if (options.tone === 'formal') parts.push('Use a polite, formal tone; in Thai, use ครับ/ค่ะ and address the user respectfully.');
  else if (options.tone === 'concise') parts.push('Use a neutral, matter-of-fact tone with no small talk.');
  else parts.push('Use a warm, friendly, approachable tone.');

  if (options.emoji === true) parts.push('A small number of emoji is welcome where it suits the tone.');
  else if (options.emoji === false) parts.push('Do not use emoji.');

  parts.push('No preamble, and do not show your reasoning process — just the final answer.');
  return parts.join(' ');
}

// The admin's steering block: the remaining options rendered as sentences,
// followed by their free-form text. Returned as one string to slot into the
// system prompt, or null when the admin has configured nothing at all.
export function composeGuidance(settings: AiSurfaceSettings): string | null {
  const { options, instructions } = settings;
  const lines: string[] = [];

  // Unset behaves as 'admit' — the settings screen shows that as the default,
  // so it has to actually be sent, not merely be the value you would pick.
  if (options.unknown === 'referStaff') {
    lines.push('If you do not know something, say so and point the user to LITALK staff via the LINE OA rather than guessing.');
  } else {
    lines.push('If you do not know something, say so plainly rather than guessing.');
  }
  if (options.referContact) {
    lines.push('Where it genuinely helps, mention that LITALK staff can be reached on the LINE OA for anything you cannot handle.');
  }
  if (options.noPricing) {
    lines.push('Never state specific prices, discounts, or promotions — send those questions to LITALK staff instead.');
  }

  const freeText = instructions.trim();
  if (freeText) lines.push(freeText);
  return lines.length ? lines.join('\n') : null;
}

interface SettingsRow {
  staff_instructions: string;
  portal_instructions: string;
  general_instructions: string;
  staff_options: string;
  portal_options: string;
  general_options: string;
  staff_enabled: number;
  portal_enabled: number;
  general_enabled: number;
  staff_daily_limit: number;
  portal_daily_limit: number;
  general_daily_limit: number;
}

function defaults(surface: AiSurface): AiSurfaceSettings {
  return { enabled: true, dailyLimit: DEFAULT_DAILY_LIMITS[surface], options: {}, instructions: '' };
}

export async function loadAiChatSettings(db: D1Database): Promise<AiChatSettings> {
  const row = await db
    .prepare(
      `SELECT staff_instructions, portal_instructions, general_instructions,
              staff_options, portal_options, general_options,
              staff_enabled, portal_enabled, general_enabled,
              staff_daily_limit, portal_daily_limit, general_daily_limit
         FROM ai_chat_settings WHERE id = 1`,
    )
    .first<SettingsRow>();

  const build = (surface: AiSurface): AiSurfaceSettings => {
    if (!row) return defaults(surface);
    return {
      enabled: row[`${surface}_enabled`] !== 0,
      dailyLimit: row[`${surface}_daily_limit`] ?? DEFAULT_DAILY_LIMITS[surface],
      options: parseOptions(row[`${surface}_options`]),
      instructions: row[`${surface}_instructions`] ?? '',
    };
  };

  return { staff: build('staff'), portal: build('portal'), general: build('general') };
}

export async function loadSurfaceSettings(db: D1Database, surface: AiSurface): Promise<AiSurfaceSettings> {
  return (await loadAiChatSettings(db))[surface];
}

// Clamps whatever the client sent into something storable. Instructions are
// truncated rather than rejected (matching the pre-existing behaviour of
// PUT /settings/ai-instructions), and the daily limit is floored at 0 —
// which is a valid setting meaning "answer nothing", distinct from
// disabling the surface outright.
export function sanitizeSurface(raw: unknown, surface: AiSurface): AiSurfaceSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const limit = Number(source.dailyLimit);
  return {
    enabled: source.enabled !== false,
    dailyLimit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 0), MAX_DAILY_LIMIT) : DEFAULT_DAILY_LIMITS[surface],
    options: parseOptions(source.options),
    instructions: typeof source.instructions === 'string' ? source.instructions.slice(0, MAX_INSTRUCTIONS_LENGTH) : '',
  };
}

export async function saveAiChatSettings(db: D1Database, settings: AiChatSettings, updatedBy: string): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_chat_settings SET
         staff_instructions = ?, portal_instructions = ?, general_instructions = ?,
         staff_options = ?, portal_options = ?, general_options = ?,
         staff_enabled = ?, portal_enabled = ?, general_enabled = ?,
         staff_daily_limit = ?, portal_daily_limit = ?, general_daily_limit = ?,
         updated_at = CURRENT_TIMESTAMP, updated_by = ?
       WHERE id = 1`,
    )
    .bind(
      settings.staff.instructions,
      settings.portal.instructions,
      settings.general.instructions,
      JSON.stringify(settings.staff.options),
      JSON.stringify(settings.portal.options),
      JSON.stringify(settings.general.options),
      settings.staff.enabled ? 1 : 0,
      settings.portal.enabled ? 1 : 0,
      settings.general.enabled ? 1 : 0,
      settings.staff.dailyLimit,
      settings.portal.dailyLimit,
      settings.general.dailyLimit,
      updatedBy,
    )
    .run();
}
