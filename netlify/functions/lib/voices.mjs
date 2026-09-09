// voices.mjs — the voice list the Settings picker shows, and language names.
//
// Vapi publishes NO voice-list API and no preview URLs (checked Sep 2026), so a
// curated list is the honest option. To hear one before committing: Vapi
// dashboard → Resources → Voice Library has a play button on every voice, and
// any voiceId from there can be pasted into the "Something else" box.
//
// COST NOTE, because it's the part that surprises people: TTS is billed per
// character of speech, not per minute of call. Rough per-minute at ~900 spoken
// characters: Deepgram Aura ~$0.014, OpenAI tts-1 ~$0.014, ElevenLabs ~$0.17+.
// On 4,500 minutes that is a ~$60/mo voice bill versus ~$765. ElevenLabs sounds
// better. It does not sound $700-a-month better for taking a pizza order.
// (Vapi's own voices have no published rate — check a real call's cost breakdown
// in the dashboard before assuming they're free.)

export const VOICE_CHOICES = [
  // provider: 'vapi' — multilingual in one voice via version 2 + language auto
  { id: 'vapi:Elliot', label: 'Elliot', note: 'Male, Canadian. Warm and even — the safe default.', tier: 'standard', multilingual: true, voice: { provider: 'vapi', voiceId: 'Elliot', version: 2, language: 'auto' } },
  { id: 'vapi:Savannah', label: 'Savannah', note: 'Female, US Southern. Friendly, unhurried.', tier: 'standard', multilingual: true, voice: { provider: 'vapi', voiceId: 'Savannah', version: 2, language: 'auto' } },
  { id: 'vapi:Emma', label: 'Emma', note: 'Female, neutral American. Clear and businesslike.', tier: 'standard', multilingual: true, voice: { provider: 'vapi', voiceId: 'Emma', version: 2, language: 'auto' } },
  { id: 'vapi:Clara', label: 'Clara', note: 'Female, softer and conversational.', tier: 'standard', multilingual: true, voice: { provider: 'vapi', voiceId: 'Clara', version: 2, language: 'auto' } },
  { id: 'vapi:Kai', label: 'Kai', note: 'Male, younger sounding, upbeat.', tier: 'standard', multilingual: true, voice: { provider: 'vapi', voiceId: 'Kai', version: 2, language: 'auto' } },
  { id: 'vapi:Nico', label: 'Nico', note: 'Male, relaxed.', tier: 'standard', multilingual: true, voice: { provider: 'vapi', voiceId: 'Nico', version: 2, language: 'auto' } },

  // Deepgram Aura — cheapest, English (Aura-2 adds Spanish + German)
  { id: 'deepgram:aura-2-thalia-en', label: 'Thalia', note: 'Female, US. Cheapest option, English + Spanish.', tier: 'cheap', multilingual: false, voice: { provider: 'deepgram', voiceId: 'aura-2-thalia-en' } },
  { id: 'deepgram:aura-2-apollo-en', label: 'Apollo', note: 'Male, US. Cheapest option, English + Spanish.', tier: 'cheap', multilingual: false, voice: { provider: 'deepgram', voiceId: 'aura-2-apollo-en' } },

  // OpenAI — cheap, follows the language of whatever text it's given
  { id: 'openai:nova', label: 'Nova (OpenAI)', note: 'Female, natural. Cheap, and speaks whatever language it is handed.', tier: 'cheap', multilingual: true, voice: { provider: 'openai', model: 'gpt-4o-mini-tts', voiceId: 'nova' } },
  { id: 'openai:ash', label: 'Ash (OpenAI)', note: 'Male, easy-going. Cheap, multilingual.', tier: 'cheap', multilingual: true, voice: { provider: 'openai', model: 'gpt-4o-mini-tts', voiceId: 'ash' } },

  // ElevenLabs — best sounding, roughly 10x the per-character cost
  { id: '11labs:sarah', label: 'Sarah (ElevenLabs)', note: 'The most human-sounding tier. Roughly 10× the voice cost — see the note below.', tier: 'premium', multilingual: true, voice: { provider: '11labs', model: 'eleven_flash_v2_5', voiceId: 'sarah' } },
];

export const COST_NOTE =
  'Voice is billed per character spoken, not per minute. The cheap and standard voices land around a penny or two a minute; ElevenLabs is roughly ten times that. At your volume that is the difference between about $60 and about $700 a month.';

// Languages worth offering a Rhode Island pizza shop. Portuguese is not padding —
// RI has one of the largest Portuguese-speaking populations in the country.
export const LANGUAGE_CHOICES = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'pt', label: 'Portuguese', native: 'Português' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'it', label: 'Italian', native: 'Italiano' },
  { code: 'zh', label: 'Mandarin', native: '中文' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'ru', label: 'Russian', native: 'Русский' },
  { code: 'pl', label: 'Polish', native: 'Polski' },
  { code: 'ar', label: 'Arabic', native: 'العربية' },
];

export const languageName = (code) => LANGUAGE_CHOICES.find((l) => l.code === code)?.label ?? code;

export function voiceChoiceFor(voice) {
  if (!voice) return null;
  return VOICE_CHOICES.find((c) => c.voice.provider === voice.provider && c.voice.voiceId === voice.voiceId) ?? null;
}

/** A voice can only carry a language if it's actually multilingual. */
export function voiceSupportsMultilingual(voice) {
  const c = voiceChoiceFor(voice);
  if (c) return c.multilingual;
  // custom voiceId pasted from the Vapi dashboard — assume the provider's rules
  if (voice.provider === 'vapi') return Number(voice.version) >= 2;
  if (voice.provider === 'openai') return true;
  if (voice.provider === '11labs') return /multilingual|flash_v2_5|eleven_v3/.test(String(voice.model || ''));
  if (voice.provider === 'cartesia') return !/sonic-english/.test(String(voice.model || ''));
  return false;
}

// ---------------------------------------------------------------------------
// Models. What matters for a phone order, in order: LATENCY (a thinking pause is
// dead air), tool-calling reliability, then instruction-following. Raw
// intelligence barely matters — the menu is in the prompt, prices are computed
// server-side, and the tools do the hard parts. A frontier model here is slower
// and dearer for no gain, so the list is deliberately the small/fast tier.
//
// The per-minute figures are the relative shape, not a quote. Verify the exact
// model string against Vapi's own model dropdown before trusting one — these
// identifiers change, and a wrong one fails the call.
export const MODEL_CHOICES = [
  { id: 'anthropic:claude-haiku-4-5', label: 'Claude Haiku', note: 'Strong at following a long list of "never do X" rules — and this prompt has ten. Good default.', cost: '~$0.02/min', provider: 'anthropic', model: 'claude-haiku-4-5' },
  { id: 'openai:gpt-5-mini', label: 'GPT-5 mini', note: 'Fast and cheaper. Very capable at this kind of scripted task.', cost: '~$0.01/min', provider: 'openai', model: 'gpt-5-mini' },
  { id: 'google:gemini-3.0-flash', label: 'Gemini Flash', note: 'Fast, cheap, solid tool use. Worth a try if the others feel slow.', cost: '~$0.03/min', provider: 'google', model: 'gemini-3.0-flash' },
  { id: 'openai:gpt-5-nano', label: 'GPT-5 nano', note: 'Cheapest and quickest. Watch it on complicated orders before trusting it.', cost: '~$0.003/min', provider: 'openai', model: 'gpt-5-nano' },
];

export const MODEL_NOTE =
  'Bigger is not better here. A frontier model adds a pause before every reply and several times the cost, and takes the order no more accurately — the menu, the prices and the rules are all handled outside the model. Judge these by how quickly they come back and whether they get the order right, not by benchmarks.';

export const DEFAULT_MODEL = { provider: 'anthropic', model: 'claude-haiku-4-5' };
