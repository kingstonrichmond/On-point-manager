// clover-catalog.mjs — read the register's menu, and say what shape it is.
//
// PHASE 1 OF 2. This fetches and describes. Nothing in here writes to
// data.menu, and nothing should until a human has read the report this
// produces — phase 2 (the ID-based mapping and the sync) depends on what the
// catalog actually looks like, and guessing the shape is how a wrong price
// ends up read to a caller.
//
// Why the shape is the whole question: per the owner, plain pizzas are a
// SEPARATE Clover item per size ("large cheese is its own size"), while
// specialty pizzas are ONE item with a required size modifier group that
// carries the price. So there is no single rule for where the price lives,
// and the app's menu (pizzaSizes × pizzaBasePrices, specialty × specialtyPrices,
// flat categories) is shaped differently again. Each *priced variant* on the
// app side will map to a Clover item, or a Clover item plus one modifier.
// This file exists to see whether that story holds before anything is built
// on it. Reuses cloverGet from clover-orders.mjs — same token, same User-Agent,
// same error handling; don't write a second one.
//
// Prices are CENTS end to end. Convert once, at the edge, in the app.

import { cloverGet } from './clover-orders.mjs';

const PAGE = 1000; // Clover's max; keep paging until a short page comes back

async function pageAll(env, path, params = {}) {
  const out = [];
  for (let offset = 0; offset < 20000; offset += PAGE) {
    const page = await cloverGet(env, path, { ...params, limit: PAGE, offset });
    const rows = page?.elements ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const names = (x) => (x?.elements ?? []).map((e) => e.name).filter(Boolean);

/**
 * The register's whole menu, normalized. Two passes over /items because
 * Clover caps `expand` at three fields, plus modifier groups (with their
 * modifiers and prices) and categories.
 */
export async function fetchCatalog(env = process.env) {
  const [rawItems, tagged, groups, cats] = await Promise.all([
    pageAll(env, '/items', { expand: 'categories,modifierGroups,itemStock' }),
    pageAll(env, '/items', { expand: 'tags,itemGroup' }),
    pageAll(env, '/modifier_groups', { expand: 'modifiers' }),
    pageAll(env, '/categories', {}),
  ]);

  const groupById = {};
  groups.forEach((g) => {
    groupById[g.id] = {
      id: g.id,
      name: g.name || '',
      minRequired: Number(g.minRequired) || 0,
      maxAllowed: g.maxAllowed == null ? null : Number(g.maxAllowed),
      required: (Number(g.minRequired) || 0) > 0,
      showByDefault: g.showByDefault !== false,
      modifiers: (g.modifiers?.elements ?? []).map((m) => ({ id: m.id, name: m.name || '', price: m.price == null ? null : Number(m.price), available: m.available !== false })),
    };
  });

  const extra = {};
  tagged.forEach((it) => { extra[it.id] = { tags: names(it.tags), itemGroup: it.itemGroup ? { id: it.itemGroup.id, name: it.itemGroup.name || '' } : null }; });

  const items = rawItems.filter((it) => !it.deleted).map((it) => ({
    id: it.id,
    name: it.name || '',
    alternateName: it.alternateName || '',
    price: it.price == null ? null : Number(it.price),
    priceType: it.priceType || 'FIXED',
    available: it.available !== false,
    hidden: !!it.hidden,
    stockCount: it.itemStock?.quantity ?? it.itemStock?.stockCount ?? it.stockCount ?? null,
    categories: names(it.categories),
    tags: extra[it.id]?.tags ?? [],
    itemGroup: extra[it.id]?.itemGroup ?? null,
    modifierGroups: (it.modifierGroups?.elements ?? []).map((g) => groupById[g.id] || { id: g.id, name: g.name || '', minRequired: 0, maxAllowed: null, required: false, showByDefault: true, modifiers: [] }),
  })).sort((a, b) => (a.categories[0] || '~').localeCompare(b.categories[0] || '~') || a.name.localeCompare(b.name));

  return {
    fetchedAt: new Date().toISOString(),
    items,
    categories: cats.map((c) => ({ id: c.id, name: c.name || '' })).sort((a, b) => a.name.localeCompare(b.name)),
    modifierGroups: Object.values(groupById).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------- the six questions, answered from the data ----------

const SIZE_WORD = /\b(xs|sm|small|md|med|medium|lg|large|xl|x-?large|extra large|personal|family|party|sheet|half|whole|\d{1,2}\s*(?:"|”|in|inch)?)\b/gi;
const PIZZA = /\b(pizza|pie|calzone|sicilian|detroit)\b/i;
const FRONT = /\b(slices?|knots?|soda|drinks?|water|coke|pepsi|sprite|can|bottle)\b/i;
const SHORTHAND_TOKEN = /^[A-Z]{2,4}$/; // "LG", "CHZ", "PEPP" — register shorthand

const money = (c) => (c == null ? '?' : '$' + (c / 100).toFixed(2));
const uniq = (a) => [...new Set(a)];
const take = (a, n) => a.slice(0, n);

/** Everything the report needs, as data the app can also render. */
export function catalogSummary(cat) {
  const items = cat.items || [];
  const byCategory = {};
  items.forEach((it) => { const k = it.categories[0] || '(no category)'; byCategory[k] = (byCategory[k] || 0) + 1; });

  // Q2a — where the price lives: on the item, or in a required modifier group?
  const priceInModifier = items.filter((it) => (!it.price || it.priceType === 'VARIABLE') && it.modifierGroups.some((g) => g.required && g.modifiers.some((m) => m.price > 0)));
  const sizeGroupItems = items.filter((it) => it.modifierGroups.some((g) => /size/i.test(g.name)));

  // Q2b — separate item per size: strip size words and see what collapses together
  const base = (n) => n.replace(SIZE_WORD, ' ').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  const families = {};
  items.forEach((it) => { if (SIZE_WORD.test(it.name)) { SIZE_WORD.lastIndex = 0; const b = base(it.name); if (b) (families[b] = families[b] || []).push(it); } SIZE_WORD.lastIndex = 0; });
  const sizeFamilies = Object.entries(families).filter(([, l]) => l.length >= 2).map(([b, l]) => ({ base: b, items: l.map((i) => `${i.name} ${money(i.price)}`) }));
  const inItemGroups = items.filter((it) => it.itemGroup);
  const itemGroupNames = uniq(inItemGroups.map((it) => it.itemGroup.name || it.itemGroup.id));

  // Q3 — descriptions. Clover's item record has no description field at all;
  // alternateName is the nearest thing it carries.
  const withAlt = items.filter((it) => it.alternateName);

  // Q4 — tags, and whether they split kitchen from front
  const tagCounts = {};
  items.forEach((it) => it.tags.forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const pizzaSample = take(items.filter((it) => PIZZA.test(it.name)), 6).map((it) => ({ name: it.name, tags: it.tags, categories: it.categories }));
  const frontSample = take(items.filter((it) => FRONT.test(it.name)), 6).map((it) => ({ name: it.name, tags: it.tags, categories: it.categories }));

  // Q5 — full words or register shorthand?
  const shorthand = items.filter((it) => it.name.split(/\s+/).some((w) => SHORTHAND_TOKEN.test(w)));

  // Q6 — are slices, knots and drinks in this same catalog?
  const frontItems = items.filter((it) => FRONT.test(it.name));

  return {
    fetchedAt: cat.fetchedAt,
    itemCount: items.length,
    hiddenCount: items.filter((it) => it.hidden).length,
    unavailableCount: items.filter((it) => !it.available).length,
    categoryCount: (cat.categories || []).length,
    byCategory,
    modifierGroupCount: (cat.modifierGroups || []).length,
    requiredGroups: (cat.modifierGroups || []).filter((g) => g.required).map((g) => ({ name: g.name, min: g.minRequired, max: g.maxAllowed, modifiers: g.modifiers.map((m) => `${m.name} ${money(m.price)}`) })),
    priceInModifier: { count: priceInModifier.length, examples: take(priceInModifier, 8).map((it) => ({ name: it.name, groups: it.modifierGroups.filter((g) => g.required).map((g) => `${g.name}: ${g.modifiers.map((m) => `${m.name} ${money(m.price)}`).join(' / ')}`) })) },
    sizeGroupItems: { count: sizeGroupItems.length, examples: take(sizeGroupItems.map((it) => it.name), 8) },
    sizeFamilies: { count: sizeFamilies.length, examples: take(sizeFamilies, 8) },
    itemGroups: { itemCount: inItemGroups.length, groupCount: itemGroupNames.length, examples: take(itemGroupNames, 8) },
    alternateNames: { count: withAlt.length, examples: take(withAlt.map((it) => `${it.name} → ${it.alternateName}`), 6) },
    tags: { names: Object.keys(tagCounts).sort(), counts: tagCounts, pizzaSample, frontSample },
    nameStyle: { shorthandCount: shorthand.length, share: items.length ? Math.round((shorthand.length / items.length) * 100) : 0, examples: take(shorthand.map((it) => it.name), 8), plainExamples: take(items.filter((it) => !shorthand.includes(it)).map((it) => it.name), 8) },
    frontItems: { count: frontItems.length, examples: take(frontItems.map((it) => `${it.name} (${it.categories[0] || 'no category'})`), 8) },
  };
}

/** The phase-1 report, as text a person can copy out of the app and paste back. */
export function reportText(sum) {
  const L = [];
  const list = (a) => (a.length ? a.join('; ') : 'none');
  L.push(`CLOVER CATALOG — read ${sum.fetchedAt}`);
  L.push('');
  L.push(`1. ${sum.itemCount} items (${sum.hiddenCount} hidden, ${sum.unavailableCount} marked unavailable) in ${sum.categoryCount} categories; ${sum.modifierGroupCount} modifier groups.`);
  L.push('   By category: ' + Object.entries(sum.byCategory).map(([k, v]) => `${k} ${v}`).join(', '));
  L.push('');
  L.push(`2. Where the price lives:`);
  L.push(`   Items whose price is in a REQUIRED modifier group (item price 0/variable): ${sum.priceInModifier.count}`);
  sum.priceInModifier.examples.forEach((e) => L.push(`     - ${e.name} — ${e.groups.join(' | ')}`));
  L.push(`   Items with a modifier group named like "size": ${sum.sizeGroupItems.count}${sum.sizeGroupItems.examples.length ? ' (' + sum.sizeGroupItems.examples.join(', ') + ')' : ''}`);
  L.push(`   Separate-item-per-size families (names that differ only by a size word): ${sum.sizeFamilies.count}`);
  sum.sizeFamilies.examples.forEach((f) => L.push(`     - ${f.base}: ${f.items.join(' / ')}`));
  L.push(`   Items in Clover item groups (variants): ${sum.itemGroups.itemCount} across ${sum.itemGroups.groupCount} groups${sum.itemGroups.examples.length ? ' (' + sum.itemGroups.examples.join(', ') + ')' : ''}`);
  L.push(`   Required groups on the register: ${list(sum.requiredGroups.map((g) => `${g.name} [${g.min}–${g.max == null ? '∞' : g.max}] ${g.modifiers.join(' / ')}`))}`);
  L.push('');
  L.push(`3. Descriptions: Clover's item record has no description field at all. The nearest thing, alternateName, is set on ${sum.alternateNames.count} of ${sum.itemCount} items${sum.alternateNames.examples.length ? ': ' + sum.alternateNames.examples.join('; ') : ''}.`);
  L.push('');
  L.push(`4. Tags: ${sum.tags.names.length ? sum.tags.names.map((t) => `${t} (${sum.tags.counts[t]})`).join(', ') : 'NONE came back on any item'}.`);
  L.push('   Pizzas carry: ' + list(sum.tags.pizzaSample.map((s) => `${s.name} → [${s.tags.join(', ') || 'no tags'}]`)));
  L.push('   Slices/knots/drinks carry: ' + list(sum.tags.frontSample.map((s) => `${s.name} → [${s.tags.join(', ') || 'no tags'}]`)));
  L.push('');
  L.push(`5. Names: ${sum.nameStyle.share}% look like register shorthand (${sum.nameStyle.shorthandCount} of ${sum.itemCount}).`);
  L.push('   Shorthand examples: ' + list(sum.nameStyle.examples));
  L.push('   Plain examples: ' + list(sum.nameStyle.plainExamples));
  L.push('');
  L.push(`6. Slices, knots and drinks in this same catalog: ${sum.frontItems.count}${sum.frontItems.examples.length ? ' — ' + sum.frontItems.examples.join('; ') : ''}.`);
  return L.join('\n');
}
