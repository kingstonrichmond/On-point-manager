// vapi-adapter.mjs — turns the vendor-independent brain into a Vapi assistant,
// and translates Vapi's server-URL webhooks into tool calls.
// Docs: https://docs.vapi.ai/server-url  https://docs.vapi.ai/tools/custom-tools
//       https://docs.vapi.ai/call-forwarding  https://docs.vapi.ai/assistants/dynamic-assistants

import { buildSystemPrompt, greeting, TOOLS, createHandlers, runTool } from './agent-core.mjs';

function parseJSON(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

/** Build a complete Vapi assistant object for THIS shop, right now (fresh menu + 86 list). */
export function buildVapiAssistant(shop, env = process.env, { serverUrl } = {}) {
  const functionTools = TOOLS.map((t) => ({
    type: 'function',
    async: false,
    function: { name: t.name, description: t.description, parameters: t.parameters },
    ...(serverUrl ? { server: { url: serverUrl } } : {}),
  }));
  const transfer = shop.agent.transferNumber
    ? [{
        type: 'transferCall',
        destinations: [{ type: 'number', number: toE164(shop.agent.transferNumber), message: 'Let me grab someone at the counter for you.', description: 'The front counter' }],
      }]
    : [];

  return {
    name: `${shop.profile.name} phone host`,
    firstMessage: greeting(shop),
    firstMessageMode: 'assistant-speaks-first',
    model: {
      // An env override wins (it's what's known to work on this account); the
      // Brain picker in Setup is what applies when none is set.
      provider: env.VAPI_MODEL_PROVIDER || shop.agent.modelProvider || 'anthropic',
      model: env.VAPI_MODEL || shop.agent.model || 'claude-haiku-4-5-20251001',
      temperature: 0.3,
      maxTokens: 250,
      messages: [{ role: 'system', content: buildSystemPrompt(shop) }],
      tools: [...functionTools, ...transfer],
    },
    transcriber: parseJSON(env.VAPI_TRANSCRIBER_JSON, { provider: 'deepgram', model: 'nova-3', language: (shop.agent.languages || ['en']).length > 1 ? 'multi' : 'en', keywords: keywordsFor(shop) }),
    // Vapi retired Paige on 1 March 2026 and now REJECTS any assistant that asks
    // for a retired voice, which fails assistant-request outright — no call, no
    // fallback. version 2 is what Vapi's own voices need (see DEFAULT_VOICE in
    // shop-data.mjs). Pick a different one in the Vapi dashboard; any provider works.
    // The voice is shop data (Setup's picker), not an env var: changing it is a
    // tap, not a redeploy. Speed rides along only when it's been moved off 1.
    voice: withSpeed(shop.agent.voice || parseJSON(env.VAPI_VOICE_JSON, { provider: 'vapi', voiceId: 'Savannah', version: 2 }), shop.agent.voiceSpeed),
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 900,
    backgroundSound: shop.agent.ambient === 'office' ? 'office' : 'off',
    // One field from Vapi's end-of-call analysis: the frustration mark on the
    // Calls list. "fine" is drawn as nothing — a mark on most rows is a mark on none.
    analysisPlan: {
      structuredDataPlan: {
        enabled: true,
        schema: { type: 'object', properties: { mood: { type: 'string', enum: ['fine', 'annoyed', 'angry'], description: 'How the caller seemed by the end of the call. fine unless they were clearly annoyed or angry.' } } },
      },
    },
    endCallFunctionEnabled: true,
    endCallMessage: `Thanks for calling ${shop.profile.name}, see you soon.`,
    serverMessages: ['tool-calls', 'end-of-call-report', 'status-update'],
    ...(serverUrl ? { server: { url: serverUrl } } : {}),
    metadata: { shop: shop.profile.name, builtAt: new Date().toISOString() },
  };
}

function withSpeed(voice, speed) {
  const v = { ...(voice || {}) };
  const sp = Number(speed);
  if (Number.isFinite(sp) && sp > 0 && Math.abs(sp - 1) > 0.001) v.speed = Math.round(sp * 100) / 100;
  return v;
}

/** The whole assistant for a caller on the block list: one polite line, then the call ends. */
export function blockedAssistant(shop, env = process.env) {
  const a = buildVapiAssistant(shop, env, {});
  return {
    ...a,
    firstMessage: "Sorry, we're not able to take this call.",
    model: { ...a.model, tools: [], messages: [{ role: 'system', content: 'The caller is on the block list. Say nothing beyond the first message. End the call.' }] },
    maxDurationSeconds: 12,
    endCallMessage: 'Goodbye.',
  };
}

// What Setup pushes to the static assistant the number runs (vapi-sync.mjs):
// everything that is the shop's to decide, and nothing that is the account's -
// no name, no server URL, no metadata. Tools carry no server of their own so
// they inherit the assistant's.
const PATCH_FIELDS = ['firstMessage', 'firstMessageMode', 'model', 'transcriber', 'voice', 'analysisPlan', 'backgroundSound', 'silenceTimeoutSeconds', 'maxDurationSeconds', 'endCallFunctionEnabled', 'endCallMessage', 'serverMessages'];
export function assistantPatch(shop, env = process.env) {
  const a = buildVapiAssistant(shop, env, {});
  const out = {};
  for (const k of PATCH_FIELDS) if (a[k] !== undefined) out[k] = a[k];
  return out;
}

/** Menu words the transcriber should bias toward (Deepgram keyword boosting). */
function keywordsFor(shop) {
  const names = new Set();
  shop.menu.forEach((m) => m.name.split(/[\s\/&,-]+/).forEach((w) => { if (w.length > 3 && !/^(with|and|the|pizza)$/i.test(w)) names.add(w); }));
  return [...names].slice(0, 80).map((w) => `${w}:1`);
}

export function toE164(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 10 ? `+1${d}` : d.startsWith('1') && d.length === 11 ? `+${d}` : `+${d}`;
}

/** Pull caller info out of a Vapi message envelope (shape differs slightly by event). */
export function callInfo(message) {
  const call = message?.call ?? {};
  return { id: call.id ?? null, from: call.customer?.number ?? message?.customer?.number ?? null, to: call.phoneNumber?.number ?? null };
}

/** Handle Vapi's `tool-calls` message → `{ results: [...] }`. */
export async function handleToolCalls(message, { shop, env, now }) {
  const call = callInfo(message);
  const handlers = createHandlers({ shop, env, call, now });
  const list = message.toolCallList ?? message.toolWithToolCallList?.map((x) => x.toolCall) ?? [];
  const results = [];
  for (const tc of list) {
    const name = tc.name ?? tc.function?.name;
    let args = tc.arguments ?? tc.function?.arguments ?? {};
    if (typeof args === 'string') args = parseJSON(args, {});
    const result = await runTool(handlers, name, args);
    results.push({ toolCallId: tc.id, result: typeof result === 'string' ? result : JSON.stringify(result) });
  }
  return { results };
}

/** Condense an end-of-call report into what the dashboard should keep. */
export function summarizeCallReport(message) {
  const call = callInfo(message);
  return {
    id: call.id ?? `call-${Date.now().toString(36)}`,
    at: message.startedAt ?? message.call?.createdAt ?? new Date().toISOString(),
    from: call.from,
    durationSec: Math.round(message.durationSeconds ?? message.durationMs / 1000 ?? 0) || null,
    endedReason: message.endedReason ?? null,
    summary: message.analysis?.summary ?? message.summary ?? '',
    successEvaluation: message.analysis?.successEvaluation ?? null,
    mood: message.analysis?.structuredData?.mood ?? null,
    transcript: (message.transcript ?? '').slice(0, 8000),
    recordingUrl: message.recordingUrl ?? message.artifact?.recordingUrl ?? null,
    cost: message.cost ?? null,
  };
}
