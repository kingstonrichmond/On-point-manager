// wait-estimate.mjs — turn a pile of open tickets into a suggested wait.
//
// DESIGN RULE, because this is the easy place to build something that looks
// authoritative and is wrong: this NEVER sets the wait by itself. It produces a
// suggestion plus every number that went into it, and a person taps to accept.
// The phone quotes what a human vouched for. See WaitControl on the Today tab.
//
// The model is deliberately the simplest one that can be argued with:
//
//     load    = pizzas + otherItems × otherWeight
//     minutes = load ÷ pizzasPerHour × 60 + bakeMinutes
//
// then clamped, rounded, and sanity-checked against the oldest open ticket.
// Every term is in `data.kitchen` so Chris can correct it after one rush
// instead of filing a bug. Showing the terms is the point — "14 pizzas at
// 20/hr" is a claim he can check; "about 55 minutes" is not.

export const DEFAULT_KITCHEN = {
  pizzasPerHour: 20,   // A GUESS until measured. The single number worth tuning first.
  otherWeight: 0.3,    // how much a non-pizza item counts toward oven/fryer load
  bakeMinutes: 8,      // floor: even an empty shop takes this long to hand it over
  minWait: 15,
  maxWait: 120,        // past this, stop quoting a number and get a person
  roundTo: 5,
};

export function kitchenConfig(data) {
  return { ...DEFAULT_KITCHEN, ...(data?.kitchen ?? {}) };
}

const round = (n, to) => Math.max(to, Math.round(n / to) * to);

/**
 * @returns {{minutes:number|null, basis:object, confidence:'low'|'ok', notes:string[]}}
 */
export function estimateWait(tickets, config = DEFAULT_KITCHEN) {
  const c = { ...DEFAULT_KITCHEN, ...config };
  const pizzas = tickets.reduce((n, t) => n + (t.pizzas || 0), 0);
  const otherItems = tickets.reduce((n, t) => n + (t.otherItems || 0), 0);
  const load = pizzas + otherItems * c.otherWeight;
  const oldestAgeMin = tickets.reduce((n, t) => Math.max(n, t.ageMin ?? 0), 0);

  const notes = [];
  let confidence = 'ok';

  if (!tickets.length) {
    return {
      minutes: round(c.bakeMinutes, c.roundTo) < c.minWait ? c.minWait : round(c.bakeMinutes, c.roundTo),
      basis: { tickets: 0, pizzas: 0, otherItems: 0, load: 0, pizzasPerHour: c.pizzasPerHour, bakeMinutes: c.bakeMinutes, oldestAgeMin: 0 },
      confidence: 'ok',
      notes: ['Nothing in the queue.'],
    };
  }

  const raw = (load / c.pizzasPerHour) * 60 + c.bakeMinutes;
  let minutes = round(Math.min(Math.max(raw, c.minWait), c.maxWait), c.roundTo);

  // Sanity check against reality: if the oldest ticket has already been sitting
  // longer than we're about to promise, the throughput number is wrong for
  // tonight. Say so rather than quietly quoting an impossible time.
  if (oldestAgeMin > minutes + c.roundTo) {
    notes.push(`Oldest ticket is already ${oldestAgeMin} min old — the ${c.pizzasPerHour}/hr rate looks optimistic tonight.`);
    confidence = 'low';
    minutes = round(Math.min(Math.max(oldestAgeMin, minutes), c.maxWait), c.roundTo);
  }
  if (raw >= c.maxWait) {
    notes.push(`Past the ${c.maxWait} min cap — worth a person deciding what to tell callers.`);
    confidence = 'low';
  }
  if (!Number.isFinite(c.pizzasPerHour) || c.pizzasPerHour <= 0) {
    return { minutes: null, basis: { pizzas, otherItems, load, oldestAgeMin }, confidence: 'low', notes: ['pizzasPerHour is not set to a usable number.'] };
  }

  return {
    minutes,
    basis: {
      tickets: tickets.length,
      pizzas,
      otherItems,
      load: Math.round(load * 10) / 10,
      pizzasPerHour: c.pizzasPerHour,
      bakeMinutes: c.bakeMinutes,
      oldestAgeMin,
    },
    confidence,
    notes,
  };
}

/** One line a human can check at a glance: "6 tickets · 14 pizzas at 20/hr". */
export function basisLine(est) {
  if (!est || est.minutes === null) return 'not enough to go on';
  const b = est.basis;
  if (!b.tickets) return 'nothing in the queue';
  const bits = [`${b.tickets} ticket${b.tickets === 1 ? '' : 's'}`, `${b.pizzas} pizza${b.pizzas === 1 ? '' : 's'}`];
  if (b.otherItems) bits.push(`${b.otherItems} other`);
  return `${bits.join(' · ')} at ${b.pizzasPerHour}/hr`;
}
