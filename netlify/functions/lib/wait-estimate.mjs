// wait-estimate.mjs — turn what just rang in into a suggested wait.
//
// DESIGN RULE, because this is the easy place to build something that looks
// authoritative and is wrong: this NEVER sets the wait by itself. It produces a
// suggestion plus every number that went into it, and a person taps to accept.
// The phone quotes what a human vouched for. See WaitControl on the Today tab.
//
// WHAT COUNTS AS WORK IN PROGRESS. Not "open tickets". On Point works paper
// slips: there is no bump bar, nobody ever closes a ticket, so every order
// stays "open" in Clover forever. Online orders are prepaid, so `paid` fires
// at ring-in, not at handoff. Neither Clover state means anything here. What
// does mean something is the clock: an order that arrived more than ~45
// minutes ago is out the door, whatever Clover calls it. So the input is every
// order created inside the last `wipMinutes` (isRecentArrival in
// clover-orders.mjs), and within those, only the lines that print to the
// kitchen (kitchenFilter there) — slices and knots are the front's problem
// and never touch the make line.
//
// The model is deliberately the simplest one that can be argued with:
//
//     load    = pizzas + otherItems × otherWeight
//     minutes = load ÷ pizzasPerHour × 60 + bakeMinutes
//
// then clamped and rounded. Every term is in `data.kitchen` so Chris can
// correct it after one rush instead of filing a bug. Showing the terms is the
// point — "14 pizzas at 20/hr" is a claim he can check; "about 55 minutes" is
// not. pizzasPerHour is an unvalidated guess; the honest next step once this
// runs is comparing suggestions against what he sets by hand, not more model.
//
// There used to be a rule here that never promised sooner than the oldest open
// ticket had already waited. Under the real assumption (tickets never close)
// the oldest open ticket is eventually hours old and that rule dragged every
// estimate to absurdity. Deleted, not softened.

export const DEFAULT_KITCHEN = {
  pizzasPerHour: 20,     // A GUESS until measured. The single number worth tuning first.
  otherWeight: 0.3,      // how much a non-pizza kitchen item counts toward oven/fryer load
  bakeMinutes: 8,        // floor: even an empty shop takes this long to hand it over
  minWait: 15,
  maxWait: 120,          // past this, stop quoting a number and get a person
  roundTo: 5,
  wipMinutes: 45,        // an order older than this is out the door, whatever Clover says
  kitchenTag: '',        // Clover printer tag that marks kitchen items; '' = don't use tags
  countCategories: null, // Clover categories that count as kitchen work; null = everything
};

export function kitchenConfig(data) {
  const c = { ...DEFAULT_KITCHEN, ...(data?.kitchen ?? {}) };
  const wip = Number(c.wipMinutes);
  c.wipMinutes = Number.isFinite(wip) && wip > 0 ? wip : DEFAULT_KITCHEN.wipMinutes;
  c.kitchenTag = String(c.kitchenTag || '').trim();
  c.countCategories = Array.isArray(c.countCategories) && c.countCategories.length ? c.countCategories.map(String) : null;
  return c;
}

const round = (n, to) => Math.max(to, Math.round(n / to) * to);

/**
 * @param tickets  the recent arrivals, already normalized (pizzas / otherItems
 *                 count kitchen lines only)
 * @returns {{minutes:number|null, basis:object, confidence:'low'|'ok', notes:string[]}}
 */
export function estimateWait(tickets, config = DEFAULT_KITCHEN) {
  const c = { ...DEFAULT_KITCHEN, ...config };
  const basis = { tickets: tickets.length, pizzas: 0, otherItems: 0, load: 0, pizzasPerHour: c.pizzasPerHour, bakeMinutes: c.bakeMinutes, wipMinutes: c.wipMinutes };

  // Nothing rang in inside the window: say so. A number here would be invented.
  if (!tickets.length) {
    return { minutes: null, basis, confidence: 'low', notes: [`Nothing rang in in the last ${c.wipMinutes} minutes.`] };
  }
  if (!Number.isFinite(c.pizzasPerHour) || c.pizzasPerHour <= 0) {
    return { minutes: null, basis, confidence: 'low', notes: ['pizzasPerHour is not set to a usable number.'] };
  }

  const pizzas = tickets.reduce((n, t) => n + (t.pizzas || 0), 0);
  const otherItems = tickets.reduce((n, t) => n + (t.otherItems || 0), 0);
  const load = pizzas + otherItems * c.otherWeight;
  const raw = (load / c.pizzasPerHour) * 60 + c.bakeMinutes;
  const minutes = round(Math.min(Math.max(raw, c.minWait), c.maxWait), c.roundTo);

  const notes = [];
  let confidence = 'ok';
  if (load === 0) notes.push(`Nothing for the kitchen in the last ${c.wipMinutes} minutes — that's the floor.`);
  if (raw >= c.maxWait) {
    notes.push(`Past the ${c.maxWait} min cap — worth a person deciding what to tell callers.`);
    confidence = 'low';
  }

  return {
    minutes,
    basis: { ...basis, pizzas, otherItems, load: Math.round(load * 10) / 10 },
    confidence,
    notes,
  };
}

/** One line a human can check at a glance: "6 tickets · 14 pizzas at 20/hr · last 45 min". */
export function basisLine(est) {
  if (!est || est.minutes === null) return 'not enough to go on';
  const b = est.basis;
  if (!b.tickets) return 'nothing in the queue';
  const bits = [`${b.tickets} ticket${b.tickets === 1 ? '' : 's'}`, `${b.pizzas} pizza${b.pizzas === 1 ? '' : 's'}`];
  if (b.otherItems) bits.push(`${b.otherItems} other`);
  return `${bits.join(' · ')} at ${b.pizzasPerHour}/hr · last ${b.wipMinutes} min`;
}
