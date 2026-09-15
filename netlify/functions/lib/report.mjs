// report.mjs — "Report this call", the loop back to support. The client sends
// { callId, reason, note, urgent } and nothing else; everything below is
// assembled here so a transcript is never re-uploaded from a phone. The
// email is for today; the central store is for the day there's a support view.
import { greeting } from './agent-core.mjs';

export const REPORT_REASONS = [
  'Got the order wrong',
  'Said something wrong',
  'Should have handed it to a person',
  'Customer was frustrated',
  'Something else',
];

const fmtWhen = (iso, tz) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch { return String(iso || ''); }
};
const fmtPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return p || '';
};
const dur = (s) => (s == null ? '' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/** What the phone was told at the time — the settings snapshot, minus anything secret. */
export function agentSnapshot(shop) {
  const a = shop.agent || {};
  const t = shop.tempHours?.active;
  return {
    greetingInPlay: greeting(shop),
    off: !!a.off,
    paused: !!(a.pause && a.pause.on),
    pauseUntil: a.pause?.until || null,
    quotedWaitMin: shop.wait?.pickupMin ?? null,
    todaysHours: t ? `${t.name || 'temporary hours'}${t.closed ? ' (closed)' : ''}` : 'usual',
    voice: a.voice ? `${a.voice.provider}/${a.voice.voiceId}` : '',
    model: `${a.modelProvider}/${a.model}`,
    languages: a.languages || ['en'],
    delivery: a.delivery,
    quotePrices: a.quotePrices,
    transferNumberSet: !!a.transferNumber,
    faqCount: Array.isArray(a.faq) ? a.faq.length : 0,
  };
}

export function reportSubject(shop, report, call) {
  const tz = shop.profile?.timezone;
  return `[allday]${report.urgent ? ' URGENT —' : ''} ${shop.profile?.name || 'A shop'} — ${report.reason} — ${fmtWhen(call?.at, tz)}`;
}

export function reportText({ shop, call, order, report, by }) {
  const tz = shop.profile?.timezone;
  const snap = agentSnapshot(shop);
  const L = [];
  L.push(`${shop.profile?.name || 'A shop'}${shop.profile?.location ? ' · ' + shop.profile.location : ''}`);
  L.push(`Reported by ${by || 'the shop'} at ${fmtWhen(report.at, tz)}${report.urgent ? ' — STILL HAPPENING (marked urgent)' : ''}`);
  L.push(`Reply to: ${shop.profile?.email || '(no shop email on file)'}`);
  L.push('');
  L.push(`REASON: ${report.reason}`);
  if (report.note) L.push(`NOTE: ${report.note}`);
  L.push('');
  L.push('THE CALL');
  L.push(`  id: ${call?.id || '?'}`);
  L.push(`  when: ${fmtWhen(call?.at, tz)} (${call?.at || '?'})`);
  L.push(`  from: ${fmtPhone(call?.from) || 'unknown'}`);
  L.push(`  length: ${dur(call?.durationSec) || '?'}`);
  if (call?.mood) L.push(`  mood: ${call.mood}`);
  if (call?.endedReason) L.push(`  ended: ${call.endedReason}`);
  L.push(`  summary: ${call?.summary || '(none)'}`);
  L.push(`  recording: ${call?.recordingUrl || '(none)'}`);
  L.push('');
  if (order) {
    L.push('THE ORDER');
    (order.items || []).forEach((it) => L.push(`  ${it.qty || 1} ${it.size ? it.size + ' ' : ''}${it.name}${it.mods && it.mods.length ? ' (' + it.mods.join(', ') + ')' : ''}${it.notes ? ' — ' + it.notes : ''}`));
    L.push(`  subtotal: $${Number(order.subtotal || 0).toFixed(2)} · ${order.type || 'pickup'} · quoted ${order.quotedWaitMin == null ? '?' : order.quotedWaitMin + ' min'}`);
    L.push(`  in the POS: ${order.posResult && order.posResult.ok ? 'yes (' + (order.posResult.sink || 'POS') + ')' : order.keyedIntoPos ? 'keyed in by staff' : 'not yet'}`);
  } else L.push('THE ORDER\n  (no order on this call)');
  L.push('');
  L.push('WHAT THE PHONE WAS TOLD AT THE TIME');
  Object.entries(snap).forEach(([k, v]) => L.push(`  ${k}: ${Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v)}`));
  L.push('');
  L.push('TRANSCRIPT');
  L.push(call?.transcript ? call.transcript : '  (no transcript)');
  return L.join('\n');
}
