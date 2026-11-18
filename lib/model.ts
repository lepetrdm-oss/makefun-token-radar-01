// Token Radar's model, version radar-2: a comps-calibrated implied value.
//
// A protocol's implied launch value is what its token would be worth if it traded like the
// tokens that already trade in its own category, at the size it has today:
//
//   comps multiple  = the category's median (market cap / TVL) over the snapshot's live-token
//                     protocols, shrunk toward the global median when the category has few
//                     live comps, clamped to [0.05, 1.50]
//   base            = tvl_usd x comps multiple
//   growth          = clamp(change_7d, -50, +100) per cent
//   growth mult     = 1 + growth / 100 x 0.6
//   maturity mult   = 0.70 + min(age_days, 1095) / 1095 x 0.30   (unknown age: 365 days)
//   early boost     = 1.15 when age < 365 days and growth > 10% (young and compounding)
//   breadth mult    = 1 + 0.03 x min(chains - 1, 5)
//   implied         = max(1, round(base x growth x maturity x early x breadth))
//
// Every input is a figure the sealed snapshot carries. No protocol name is ever special-cased:
// the same function scores every row, and the dashboard shows the comps table it used, so a
// reader can check any row's number by hand. Live-token protocols are never ranked: the board
// is the pre-token universe only, and the live set is shown beside it at market value.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  shrink_k: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  early_age_days: number;
  early_growth_pct: number;
  early_boost: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
}

export const MODEL: ModelConstants = {
  shrink_k: 4,
  multiple_floor: 0.05,
  multiple_cap: 1.5,
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  unknown_age_days: 365,
  early_age_days: 365,
  early_growth_pct: 10,
  early_boost: 1.15,
  breadth_per_chain: 0.03,
  breadth_max_chains: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token rows the board carries at most (the watchlist is always all in). */
export const BOARD_ROWS = 300;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    comp_multiple: number;
    comp_n: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    early_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row's compact form for data.js, farm plan included so page and board agree. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  comp_multiple: number;
  comp_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  early_multiplier: number;
  breadth_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One row of the comps table the dashboard shows. */
export interface CompRow {
  category: string;
  n: number;
  median: number;
  multiple: number;
}

/** Everything the dashboard needs: the board, the live set, the comps and the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  watchlist_slugs: string[];
  comps: CompRow[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array of numbers. */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories whose token, if any, is a wrapped, staked or bridged product of one that trades. */
const WRAPPED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names a protocol may not begin with: it would be that exchange's own product. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned
 *  pool, and not a wrapped, staked or bridged product of a token that already trades. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    (p.category === null || !WRAPPED_CATEGORIES.has(p.category)) &&
    !VERSIONED.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name) &&
    !WRAPPED_WORD.test(p.name)
  );
}

/** The comps table: one median market-cap-per-TVL multiple per category, shrunk to the global
 *  median where the category has few live comps, and the global median itself. */
export function buildComps(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; byCategory: Map<string, { n: number; median: number; multiple: number }> } {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const all = live.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const global = median(all);
  const byCat = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = byCat.get(key);
    if (list) list.push(p.mcap_usd! / p.tvl_usd);
    else byCat.set(key, [p.mcap_usd! / p.tvl_usd]);
  }
  const byCategory = new Map<string, { n: number; median: number; multiple: number }>();
  for (const [cat, ratios] of byCat) {
    ratios.sort((a, b) => a - b);
    const med = median(ratios);
    const n = ratios.length;
    const shrunk = (n * med + model.shrink_k * global) / (n + model.shrink_k);
    const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, shrunk));
    byCategory.set(cat, { n, median: med, multiple });
  }
  return { global, byCategory };
}

/** The comps multiple one protocol gets: its category's, or the global median. */
export function compMultiple(p: SnapshotProtocol, comps: ReturnType<typeof buildComps>, model: ModelConstants = MODEL): { multiple: number; n: number } {
  const entry = comps.byCategory.get(p.category ?? 'Other');
  if (entry) return { multiple: entry.multiple, n: entry.n };
  return { multiple: Math.min(model.multiple_cap, Math.max(model.multiple_floor, comps.global)), n: 0 };
}

export interface Scored {
  implied: number;
  compMultiple: number;
  compN: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  earlyMult: number;
  breadthMult: number;
  age: number | null;
}

/** The five multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: ReturnType<typeof buildComps>,
  model: ModelConstants = MODEL,
): Scored {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, n } = compMultiple(protocol, comps, model);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const earlyMult = age !== null && age < model.early_age_days && growthPct > model.early_growth_pct ? model.early_boost : 1;
  const breadthMult = 1 + model.breadth_per_chain * Math.min(Math.max(protocol.chains.length - 1, 0), model.breadth_max_chains);
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * earlyMult * breadthMult));
  return { implied, compMultiple: multiple, compN: n, growthPct, growthMult, maturityMult, earlyMult, breadthMult, age };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain, in the words a farmer budgets by. */
function gasFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $8 of gas';
  if (c === 'solana') return 'about $0.05 of gas';
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'polygon' || c === 'bnb chain') return 'about $0.50 of gas';
  return 'about $2 of gas';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's primary action, in the words a farmer can follow. */
function primaryAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield') || c.includes('aggregator')) return `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and keep the shares.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('asset management')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('payment') || c.includes('card')) return `Move $${capital} through ${name} on ${chain} and keep the account active.`;
  if (c.includes('governance')) return `Lock $${capital} of the governance asset in ${name} on ${chain} and vote once.`;
  if (c.includes('launchpad') || c.includes('farm')) return `Deposit $${capital} into ${name}'s active pool on ${chain} and keep the position open.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second leg: a different action on the same protocol, so the plan is a position,
 *  not one click. */
function secondAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const small = Math.max(10, Math.round(capital / 5));
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $${small} against the supply on ${name} and repay it the same week, so the account shows both sides.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Swap $${small} through ${name}'s main pool on ${chain} once a week, in either direction.`;
  if (c.includes('yield') || c.includes('aggregator')) return `Harvest the vault's yield on ${name} once a week and restake what it pays.`;
  if (c.includes('bridge')) return `Bridge $${small} back the other way through ${name} so the account shows round-trip volume.`;
  if (c.includes('staking') || c.includes('restak')) return `Claim the staking rewards on ${name} once a week and restake them.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Close the hedge on ${name} and open a fresh one the next week, keeping the margin posted.`;
  if (c.includes('prediction')) return `Settle one market on ${name} and place a fresh position the next week.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('asset management')) return `Check the vault's allocation report on ${name} each week and top the position up by $${small} when it rebalances.`;
  if (c.includes('stable')) return `Swap $${small} of the stable asset through ${name} once a week to keep the account active.`;
  if (c.includes('rwa')) return `Check the asset's yield accrual on ${name} each week and add $${small} when a new tranche opens.`;
  if (c.includes('insurance')) return `Review the cover's terms on ${name} each month and renew before it lapses.`;
  if (c.includes('payment') || c.includes('card')) return `Spend $${small} through ${name} once a week so the account shows real use.`;
  if (c.includes('governance')) return `Vote on the next ${name} proposal when one opens, from the locked position.`;
  if (c.includes('launchpad') || c.includes('farm')) return `Claim the pool's rewards on ${name} once a week and restake them.`;
  return `Use ${name} a second way once a week, such as a swap, a vote or a claim, so the account shows more than one action.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names, and the gas figures follow the chain the action runs on.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const steps: Array<[string, string, string]> = [
    [
      `Use a fresh wallet that holds only the funds you plan to farm with ${p.name}, and keep its seed phrase offline.`,
      'under $3 of gas for the first transaction',
      '5 minutes',
    ],
    [
      primaryAction(p, capital, chain),
      `$${capital} of capital and ${gas}`,
      '15 minutes to set up',
    ],
    [
      secondAction(p, capital, chain),
      `about $${Math.max(10, Math.round(capital / 5))} of volume and ${gas}`,
      '10 minutes a week',
    ],
    [
      `Make one qualifying action each week on ${p.name}, such as a deposit, a borrow, a swap or a vote, and keep the position open between them.`,
      `${gas} a week`,
      '10 minutes a week',
    ],
    [
      `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot of the protocol.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ],
    [
      `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes.`,
      'no fee to check, and never pay to claim',
      '10 minutes',
    ],
    [
      `Write the wallet, the dates and every transaction hash in a farm log so you can repeat the position or unwind it.`,
      'nothing but the log',
      '5 minutes',
    ],
  ];
  return steps.map(([text, cost, time]) => stepText(text, cost, time));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The protocols the board ranks: every rankable pre-token protocol by implied value, the
 *  watchlist always whole, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const comps = buildComps(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const rankable = snapshot.protocols.filter(isRankable);
  const scored = rankable.map((p) => ({ p, s: impliedValue(p, snapshot.as_of, comps, model) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const top = scored.slice(0, BOARD_ROWS);
  const topSlugs = new Set(top.map((t) => t.p.slug));
  // The watchlist is the floor: any of its slugs outside the top rows joins the board whole.
  for (const slug of snapshot.watchlist) {
    if (!topSlugs.has(slug)) {
      const p = index.get(slug);
      if (p !== undefined) top.push({ p, s: impliedValue(p, snapshot.as_of, comps, model) });
    }
  }
  top.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return top.map((t, i) => ({
    rank: i + 1,
    slug: t.p.slug,
    name: t.p.name,
    category: t.p.category,
    chains: t.p.chains,
    tvl_usd: t.p.tvl_usd,
    change_7d: t.p.change_7d,
    mcap_usd: t.p.mcap_usd,
    listed_at: t.p.listed_at,
    gecko_id: t.p.gecko_id,
    symbol: t.p.symbol,
    token_status: 'pre-token' as const,
    age_days: t.s.age,
    implied_value_usd: t.s.implied,
    model: {
      comp_multiple: round4(t.s.compMultiple),
      comp_n: t.s.compN,
      growth_pct: t.s.growthPct,
      growth_multiplier: round4(t.s.growthMult),
      maturity_multiplier: round4(t.s.maturityMult),
      early_multiplier: t.s.earlyMult,
      breadth_multiplier: round4(t.s.breadthMult),
      age_days: t.s.age,
    },
    farm_steps: farmSteps(t.p, t.s.age),
  }));
}

/** A board row's compact form for data.js, with the farm plan included so page and board agree. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    comp_multiple: row.model.comp_multiple,
    comp_n: row.model.comp_n,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    early_multiplier: row.model.early_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const comps = buildComps(snapshot, model);
  const compRows: CompRow[] = [...comps.byCategory.entries()]
    .map(([category, v]) => ({ category, n: v.n, median: round4(v.median), multiple: round4(v.multiple) }))
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: round4(comps.global),
    watchlist_slugs: [...snapshot.watchlist].sort(),
    comps: compRows,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
