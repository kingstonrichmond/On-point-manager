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
      provider: env.VAPI_MODEL_PROVIDER || 'anthropic',
      model: env.VAPI_MODEL || 'claude-haiku-4-5-20251001', // fast + cheap; swap in the dashboard if Vapi names it differently
      temperature: 0.3,
      maxTokens: 250,
      messages: [{ role: 'system', content: buildSystemPrompt(shop) }],
      tools: [...functionTools, ...transfer],
    },
    transcriber: parseJSON(env.VAPI_TRANSCRIBER_JSON, { provider: 'deepgram', model: 'nova-3', language: 'en', keywords: keywordsFor(shop) }),
    // Vapi retired Paige on 1 March 2026 and now REJECTS any assistant that asks
    // for a retired voice, which fails assistant-request outright — no call, no
    // fallback. version 2 is what Vapi's own voices need (see DEFAULT_VOICE in
    // shop-data.mjs). Pick a different one in the Vapi dashboard; any provider works.
    voice: parseJSON(env.VAPI_VOICE_JSON, { provider: 'vapi', voiceId: 'Savannah', version: 2 }),
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 900,
    backgroundSound: 'off',
    endCallFunctionEnabled: true,
    endCallMessage: `Thanks for calling ${shop.profile.name}, see you soon.`,
    serverMessages: ['tool-calls', 'end-of-call-report', 'status-update'],
    ...(serverUrl ? { server: { url: serverUrl } } : {}),
    metadata: { shop: shop.profile.name, builtAt: new Date().toISOString() },
  };
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
    transcript: (message.transcript ?? '').slice(0, 8000),
    recordingUrl: message.recordingUrl ?? message.artifact?.recordingUrl ?? null,
    cost: message.cost ?? null,
  };
}
