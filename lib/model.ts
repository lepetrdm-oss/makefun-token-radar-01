// Token Radar's model, version radar-3: a fitted launch-value model with token odds,
// honest ranges, netted farm verdicts and a full-universe ledger.
//
// What changed from radar-2, and why: radar-2 multiplied TVL by hand-set constants and
// printed the product to the dollar. radar-3 fits every term on the snapshot's own traded
// tokens and proves the fit on tokens the fit never saw, three ways, before it prices a
// single pre-token protocol:
//
//   value    log(market cap) is regressed on log(TVL) and log-scaled 7-day growth over
//            the traded tokens priced at $1M or more (dust prints under $1M are dead
//            markets, not launch comps), fitted with Huber reweighting so wild prints
//            cannot bend the curve; each category then takes a shrunk residual offset,
//            and an age slope fitted on the traded tokens that carry a listing date
//            prices how long a protocol has run. value(p) is that fitted price: what
//            p's token would be worth if it traded like the tokens that already do.
//   odds     a protocol's chance of ever recording a token, calibrated from its peers'
//            record in this same snapshot: the share that record a token, split by age
//            band, by sector group and by growth sign, combined as likelihood ratios
//            against the base rate and shrunk by cell size. No protocol is hand-scored.
//   expected the board ranks by expected launch value = value x odds: a $1B prize at
//            10% odds ranks below a $300M prize at 60% odds, which is the order a farmer
//            spending real fees should read them in.
//   range    each row's P10-P90 band is read off the model's own blind misses
//            (leave-one-out residuals), split young / seasoned, so the band is as wide
//            as the model has actually been wrong on tokens like it.
//   farm     every plan is netted: expected slice of a stated reward pool, odds-weighted,
//            minus the plan's fees and the yield the deposit gives up, ending in a
//            FARM / THIN / SKIP verdict with a break-even ticket and a $/hour rate.
//
// Every figure on the page is computed here from the sealed snapshot; the dashboard
// re-derives every row from the shipped parameters and reports any mismatch.

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

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';

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

/** The q-quantile of a sorted array, linearly interpolated. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all (the snapshot's own test: no gecko id, no symbol). */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol records a token, priced or not: a gecko id or a symbol is on its record. */
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
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

/** Why a pre-token protocol is set aside instead of ranked, or null when it is rankable. The
 *  order is the ledger's: the first reason that applies is the one the ledger states. */
export function asideReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return null;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return 'wrapped-product';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (EXCHANGE_PREFIX.test(p.name)) return 'exchange';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped-word';
  return null;
}

/** Whether a protocol is one the board may rank: pre-token and not set aside. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && asideReason(p) === null;
}

/* ------------------------------------------------------------------ *
 * The fitted value model.
 * ------------------------------------------------------------------ */

/** The value model's fitted parameters, as shipped to the dashboard (which re-derives
 *  every row from them). Coefficients are rounded to 6dp before any row is priced, so
 *  the page's arithmetic and this file's agree to the dollar. */
export interface ValueFit {
  /** Traded tokens the curve was fitted on (mcap > 0 and TVL > 0). */
  n: number;
  /** Intercept of log(mcap) on [1, log(TVL), growth]. */
  b0: number;
  /** Slope on log(TVL): the size elasticity of a launch price. */
  bTvl: number;
  /** Slope on the log-scaled 7-day growth feature (see growthFeature). */
  bGrowth: number;
  /** Slope on centred log age, fitted on the traded tokens that carry a listing date. */
  bAge: number;
  /** The centring point of the age term: the median log(age + 30) of the aged fit set. */
  ageCenter: number;
  /** Traded tokens carrying a listing date (the age slope's fit set). */
  nAge: number;
  /** Shrunk per-category residual offsets in log space, with their fit counts. */
  offsets: Record<string, { off: number; n: number }>;
}

/** One traded token prepared for the fit: its features and its actual log market cap. */
interface FitPoint {
  p: SnapshotProtocol;
  x: [number, number, number];
  y: number;
  age: number | null;
}

/** The growth feature: change_7d in per cent, clipped to [-50, +100], then log-scaled
 *  (sign x log1p(|pct| / 25)) so a one-week spike off a tiny base cannot dominate the
 *  fit the way a raw percentage does. Unreported growth is 0. */
export function growthFeature(change7d: number | null): number {
  const pct = clamp(finite(change7d, 0), -50, 100);
  return Math.sign(pct) * Math.log1p(Math.abs(pct) / 25);
}

/** The traded tokens a value fit may use: a real price and a real TVL. Tokens under
 *  $1M of market cap are excluded — 18 of the snapshot's 128 priced tokens sit there,
 *  and a dust price is a dead market's last print, not a launch comp. So are the rows
 *  whose market cap prices something other than the row's own TVL: exchange tokens
 *  (CEX category — the cap prices the exchange), canonical bridges (the cap prices
 *  the parent chain) and versioned pools (the cap prices every version at once).
 *  The fit set and both exclusions are stated on the page. */
const FIT_MIN_MCAP = 1_000_000;

/** Whether a priced token's cap prices something other than its own row's TVL. */
export function capPricesAnother(p: SnapshotProtocol): boolean {
  return p.category === 'CEX' || p.category === 'Canonical Bridge' || VERSIONED.test(p.name);
}

function fitPoints(snapshot: Snapshot): FitPoint[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd >= FIT_MIN_MCAP && p.tvl_usd > 0 && !capPricesAnother(p))
    .map((p) => ({
      p,
      x: [1, Math.log(p.tvl_usd), growthFeature(p.change_7d)] as [number, number, number],
      y: Math.log(p.mcap_usd!),
      age: ageDays(snapshot.as_of, p.listed_at),
    }))
    .sort((a, b) => (a.p.slug < b.p.slug ? -1 : 1));
}

/** Solve a small dense linear system by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    const tmp = m[col]!;
    m[col] = m[piv]!;
    m[piv] = tmp;
    const d = m[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / d;
      for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** The curve fit: least squares, then Huber reweighting (12 passes, tuning constant
 *  1.345 log units) so a handful of wild prints — a token priced at 100x or 0.01x its
 *  TVL — cannot bend the curve the whole board is priced from. Deterministic: fixed
 *  pass count, no tolerance-based stopping. */
function ols(points: FitPoint[]): [number, number, number] {
  const k = 3;
  let beta: [number, number, number] = [0, 0, 0];
  for (let pass = 0; pass < 12; pass++) {
    const ata = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const atb = new Array<number>(k).fill(0);
    for (const pt of points) {
      let w = 1;
      if (pass > 0) {
        const r = Math.abs(pt.y - (beta[0] + beta[1] * pt.x[1] + beta[2] * pt.x[2]));
        w = r <= 1.345 ? 1 : 1.345 / r;
      }
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) ata[i]![j] += w * pt.x[i] * pt.x[j];
        atb[i] += w * pt.x[i] * pt.y;
      }
    }
    const next = solve(ata, atb);
    beta = [next[0]!, next[1]!, next[2]!];
  }
  return beta;
}

/** Fit the whole value model on `points`: curve, shrunk category offsets, then the age
 *  slope on the residuals of the points that carry a listing date. */
function fitValue(points: FitPoint[]): ValueFit {
  const [b0, bTvl, bGrowth] = ols(points);
  const resid = points.map((pt) => pt.y - (b0 + bTvl * pt.x[1] + bGrowth * pt.x[2]));
  const byCat = new Map<string, number[]>();
  points.forEach((pt, i) => {
    const key = pt.p.category ?? 'Other';
    const list = byCat.get(key);
    if (list) list.push(resid[i]!);
    else byCat.set(key, [resid[i]!]);
  });
  const offsets: Record<string, { off: number; n: number }> = {};
  for (const [cat, list] of byCat) {
    const mean = list.reduce((s, v) => s + v, 0) / list.length;
    offsets[cat] = { off: clamp((list.length / (list.length + 8)) * mean, -1.25, 1.25), n: list.length };
  }
  const aged = points.filter((pt) => pt.age !== null);
  const center = median(aged.map((pt) => Math.log(pt.age! + 30)).sort((a, b) => a - b));
  let bAge = 0;
  if (aged.length >= 10) {
    let sxy = 0;
    let sxx = 0;
    points.forEach((pt, i) => {
      if (pt.age === null) return;
      const off = offsets[pt.p.category ?? 'Other']?.off ?? 0;
      const r = resid[i]! - off;
      const dx = Math.log(pt.age + 30) - center;
      sxy += dx * r;
      sxx += dx * dx;
    });
    bAge = sxx > 0 ? sxy / sxx : 0;
  }
  return {
    n: points.length,
    b0: round6(b0),
    bTvl: round6(bTvl),
    bGrowth: round6(bGrowth),
    bAge: round6(bAge),
    ageCenter: round6(center),
    nAge: aged.length,
    offsets: Object.fromEntries(
      Object.entries(offsets)
        .map(([cat, v]) => [cat, { off: round6(v.off), n: v.n }])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };
}

/** The fitted log price of one protocol under `fit`, split into its terms so the page can
 *  show the working: curve (size + growth), category offset, age term. */
export function fittedLogValue(
  fit: ValueFit,
  tvl: number,
  change7d: number | null,
  category: string | null,
  age: number | null,
): { log: number; curve: number; offset: number; ageTerm: number } {
  const curve = fit.b0 + fit.bTvl * Math.log(Math.max(1, tvl)) + fit.bGrowth * growthFeature(change7d);
  const offset = fit.offsets[category ?? 'Other']?.off ?? 0;
  const ageTerm = age === null ? 0 : fit.bAge * (Math.log(age + 30) - fit.ageCenter);
  return { log: curve + offset + ageTerm, curve, offset, ageTerm };
}

/** The fitted launch value of one protocol, in whole dollars. */
export function fittedValue(fit: ValueFit, p: SnapshotProtocol, asOf: string): number {
  const { log } = fittedLogValue(fit, p.tvl_usd, p.change_7d, p.category, ageDays(asOf, p.listed_at));
  return Math.max(1, Math.round(Math.exp(log)));
}

/* ------------------------------------------------------------------ *
 * Validation: the fit is tested on tokens it never saw, three ways.
 * ------------------------------------------------------------------ */

/** One validation run's score: how wrong the blind prices were, and how often the
 *  P10-P90 band (read off the training residuals) held the actual price. */
export interface ValidationScore {
  n: number;
  /** Median absolute log error of the blind prices (0.69 is a factor of two). */
  medAbsLogErr: number;
  /** Mean absolute log error. */
  meanAbsLogErr: number;
  /** Share of blind actuals inside the band the training residuals calibrated. */
  coverage: number;
}

/** The three validations, as the dashboard's KPI strip and model panel state them. */
export interface Validation {
  loo: ValidationScore;
  olderToNewer: ValidationScore;
  walkForward: ValidationScore;
  /** Blind residuals pooled across all three validations, split for the ranges. */
  rangeYoung: { q10: number; q90: number; n: number };
  rangeSeasoned: { q10: number; q90: number; n: number };
  rangePooled: { q10: number; q90: number; n: number };
  /** The range the board actually uses per group, and the coverage it achieved blind. */
  rangeCoverage: number;
}

const YOUNG_DAYS = 540;

/** One blind miss: the signed log residual of a token priced by a fit that never saw it,
 *  tagged with the token's age group so the ranges can be read off per group. */
interface BlindMiss {
  err: number;
  young: boolean;
}

/** Summarise one validation's blind misses against the shipped bands. */
function scoreMisses(misses: BlindMiss[], bands: { young: Band; seasoned: Band }): ValidationScore {
  const errs = misses.map((m) => Math.abs(m.err)).sort((a, b) => a - b);
  let inside = 0;
  for (const m of misses) {
    const band = m.young ? bands.young : bands.seasoned;
    if (m.err >= band.q10 && m.err <= band.q90) inside++;
  }
  return {
    n: misses.length,
    medAbsLogErr: round4(median(errs)),
    meanAbsLogErr: round4(errs.reduce((s, v) => s + v, 0) / Math.max(1, errs.length)),
    coverage: round4(misses.length === 0 ? 0 : inside / misses.length),
  };
}

interface Band {
  q10: number;
  q90: number;
  n: number;
}

/** The P10-P90 band of a list of blind residuals. */
function bandOf(list: number[]): Band {
  const s = [...list].sort((a, b) => a - b);
  return { q10: round6(quantile(s, 0.1)), q90: round6(quantile(s, 0.9)), n: list.length };
}

/**
 * Run the three validations over the snapshot's fit set and calibrate the board's
 * ranges from their pooled blind misses. Deterministic throughout.
 *
 * - Leave-one-out: every aged traded token is priced by the full pipeline refitted
 *   without it (curve on the traded remainder, offsets and age slope refit too).
 * - Older -> newer: the pipeline is fitted on the oldest 60% by listing date and
 *   prices the newest 40%.
 * - Walk-forward: four chronological folds; each later fold is priced by a fit on
 *   every earlier fold alone.
 *
 * The ranges the board ships are the 10th-90th percentiles of ALL of those blind
 * residuals, split young (< 540 days) / seasoned — so a row's band is exactly as wide
 * as the model has been wrong, blind, on tokens of its age. Each validation's coverage
 * is then scored against those shipped bands, not against bands fitted to itself.
 */
export function validateModel(snapshot: Snapshot): { fit: ValueFit; validation: Validation } {
  const points = fitPoints(snapshot);
  const fit = fitValue(points);
  const aged = points.filter((pt) => pt.age !== null);
  const miss = (f: ValueFit, pt: FitPoint): BlindMiss => {
    const { log } = fittedLogValue(f, pt.p.tvl_usd, pt.p.change_7d, pt.p.category, pt.age);
    return { err: pt.y - log, young: pt.age !== null && pt.age < YOUNG_DAYS };
  };

  const looMisses: BlindMiss[] = [];
  for (const pt of aged) {
    const f = fitValue(points.filter((q) => q.p.slug !== pt.p.slug));
    looMisses.push(miss(f, pt));
  }

  const byAge = [...aged].sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1) || (a.p.slug < b.p.slug ? -1 : 1));
  const cut = Math.floor(byAge.length * 0.6);
  const trainFit = fitValue(byAge.slice(0, cut));
  const o2nMisses = byAge.slice(cut).map((pt) => miss(trainFit, pt));

  const folds: FitPoint[][] = [[], [], [], []];
  byAge.forEach((pt, i) => folds[Math.min(3, Math.floor((i / byAge.length) * 4))]!.push(pt));
  const wfMisses: BlindMiss[] = [];
  for (let f = 1; f < 4; f++) {
    const fFit = fitValue(folds.slice(0, f).flat());
    for (const pt of folds[f]!) wfMisses.push(miss(fFit, pt));
  }

  const all = [...looMisses, ...o2nMisses, ...wfMisses];
  const pooledBand = bandOf(all.map((m) => m.err));
  // Each age group's band is shrunk toward the pooled band by its blind-miss count
  // (k = 25), so a thin group's band is not hostage to its two wildest misses.
  const shrink = (raw: Band): Band => ({
    q10: round6((raw.n * raw.q10 + 25 * pooledBand.q10) / (raw.n + 25)),
    q90: round6((raw.n * raw.q90 + 25 * pooledBand.q90) / (raw.n + 25)),
    n: raw.n,
  });
  const bands = {
    young: shrink(bandOf(all.filter((m) => m.young).map((m) => m.err))),
    seasoned: shrink(bandOf(all.filter((m) => !m.young).map((m) => m.err))),
    pooled: pooledBand,
  };
  const loo = scoreMisses(looMisses, bands);
  const olderToNewer = scoreMisses(o2nMisses, bands);
  const walkForward = scoreMisses(wfMisses, bands);
  const pooledScore = scoreMisses(all, bands);

  return {
    fit,
    validation: {
      loo,
      olderToNewer,
      walkForward,
      rangeYoung: bands.young,
      rangeSeasoned: bands.seasoned,
      rangePooled: bands.pooled,
      rangeCoverage: pooledScore.coverage,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Token odds: calibrated from the peers' record in the snapshot.
 * ------------------------------------------------------------------ */

/** The age bands the odds model reads a protocol's no-token age against. */
export const AGE_BANDS: Array<{ key: string; label: string; lo: number; hi: number }> = [
  { key: 'b0', label: 'under 6 months', lo: 0, hi: 180 },
  { key: 'b1', label: '6-18 months', lo: 181, hi: 540 },
  { key: 'b2', label: '18 months-3 years', lo: 541, hi: 1095 },
  { key: 'b3', label: 'over 3 years', lo: 1096, hi: Number.MAX_SAFE_INTEGER },
  { key: 'bx', label: 'no listing date', lo: -1, hi: -1 },
];

/** The age band key of a protocol of `age` days (null age is its own band). */
export function ageBandKey(age: number | null): string {
  if (age === null) return 'bx';
  for (const b of AGE_BANDS) if (b.key !== 'bx' && age >= b.lo && age <= b.hi) return b.key;
  return 'b3';
}

/** Broad sector groups for the odds model: DefiLlama categories that behave alike when
 *  it comes to issuing a token, so each group's peer record has enough members to read. */
export const SECTOR_GROUPS: Record<string, string[]> = {
  Lending: ['Lending', 'Uncollateralized Lending', 'CDP', 'CDP Manager', 'Collateral Markets', 'Collateral Management'],
  Trading: ['Dexs', 'Derivatives', 'Options', 'Options Vault', 'Interest Rate Derivatives', 'Prediction Market', 'OTC Marketplace', 'Basis Trading'],
  Yield: ['Yield', 'Yield Aggregator', 'Farm', 'Leveraged Farming', 'Liquidity Manager'],
  Staking: ['Liquid Staking', 'Staking Pool', 'Restaking', 'Liquid Restaking', 'Restaked BTC', 'Anchor BTC', 'Decentralized BTC'],
  Bridge: ['Bridge', 'Canonical Bridge', 'Cross Chain Bridge'],
  Curators: ['Risk Curators', 'Onchain Capital Allocator'],
  RWA: ['RWA'],
  Chain: ['Chain'],
  CEX: ['CEX'],
};

/** A protocol's sector group. */
export function sectorGroup(category: string | null): string {
  if (category !== null) {
    for (const [group, cats] of Object.entries(SECTOR_GROUPS)) if (cats.includes(category)) return group;
  }
  return 'Other';
}

/** The growth cell of a protocol: growing, flat-or-shrinking, or unreported. */
export function growthCell(p: SnapshotProtocol): string {
  if (p.change_7d === null) return 'unreported';
  return p.change_7d > 0 ? 'growing' : 'shrinking';
}

/** One odds table cell: how many peers, how many record a token, the share, and the
 *  likelihood ratio against the base rate the model multiplies by. */
export interface OddsCell {
  n: number;
  tokens: number;
  share: number;
  lr: number;
}

/** The fitted odds model: a base rate and one likelihood-ratio table per factor. */
export interface OddsModel {
  base: number;
  baseN: number;
  byAgeBand: Record<string, OddsCell>;
  bySector: Record<string, OddsCell>;
  byGrowth: Record<string, OddsCell>;
  /** Held-out calibration: fit on one slug-sorted half, scored on the other, both ways. */
  calibration: { meanPredicted: number; actualShare: number; brier: number; n: number };
}

/** A cell's likelihood ratio, shrunk toward 1 by cell size so thin cells move odds little. */
function cellOf(list: SnapshotProtocol[], base: number): OddsCell {
  const n = list.length;
  const tokens = list.filter(recordsToken).length;
  const share = n === 0 ? base : tokens / n;
  const rawLr = share <= 0 || share >= 1 || base <= 0 || base >= 1 ? 1 : share / (1 - share) / (base / (1 - base));
  const lr = 1 + (rawLr - 1) * (n / (n + 20));
  return { n, tokens, share: round4(share), lr: round6(clamp(lr, 0.25, 4)) };
}

/** Fit the odds tables on a set of protocols (the whole snapshot, or one half of it). The
 *  growth table is stratified by age band before pooling, so it is not just age restated. */
function fitOddsOn(list: SnapshotProtocol[], asOf: string): Omit<OddsModel, 'calibration'> {
  const base = list.filter(recordsToken).length / Math.max(1, list.length);
  const byAgeBand: Record<string, OddsCell> = {};
  for (const b of AGE_BANDS) {
    byAgeBand[b.key] = cellOf(list.filter((p) => ageBandKey(ageDays(asOf, p.listed_at)) === b.key), base);
  }
  const bySector: Record<string, OddsCell> = {};
  for (const g of [...Object.keys(SECTOR_GROUPS), 'Other']) {
    bySector[g] = cellOf(list.filter((p) => sectorGroup(p.category) === g), base);
  }
  const pooled: Record<string, SnapshotProtocol[]> = { growing: [], shrinking: [], unreported: [] };
  for (const b of AGE_BANDS) {
    const inBand = list.filter((p) => ageBandKey(ageDays(asOf, p.listed_at)) === b.key);
    for (const cell of Object.keys(pooled)) pooled[cell]!.push(...inBand.filter((p) => growthCell(p) === cell));
  }
  const byGrowth: Record<string, OddsCell> = {};
  for (const cell of Object.keys(pooled)) byGrowth[cell] = cellOf(pooled[cell]!, base);
  return { base: round6(base), baseN: list.length, byAgeBand, bySector, byGrowth };
}

/** One protocol's token odds under a fitted odds model, with the three factors shown. */
export function tokenOdds(
  model: Omit<OddsModel, 'calibration'>,
  p: SnapshotProtocol,
  asOf: string,
): { odds: number; ageBand: string; sector: string; growth: string; lrAge: number; lrSector: number; lrGrowth: number } {
  const ageBand = ageBandKey(ageDays(asOf, p.listed_at));
  const sector = sectorGroup(p.category);
  const growth = growthCell(p);
  const lrAge = model.byAgeBand[ageBand]?.lr ?? 1;
  const lrSector = model.bySector[sector]?.lr ?? 1;
  const lrGrowth = model.byGrowth[growth]?.lr ?? 1;
  const baseOdds = model.base / (1 - model.base);
  const o = baseOdds * lrAge * lrSector * lrGrowth;
  return { odds: round4(clamp(o / (1 + o), 0.03, 0.97)), ageBand, sector, growth, lrAge, lrSector, lrGrowth };
}

/** Fit the odds model on the whole snapshot and calibrate it honestly: each slug-sorted
 *  half is scored by tables fitted on the other half alone. */
export function fitOdds(snapshot: Snapshot): OddsModel {
  const full = fitOddsOn(snapshot.protocols, snapshot.as_of);
  const sorted = [...snapshot.protocols].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const halves: [SnapshotProtocol[], SnapshotProtocol[]] = [
    sorted.filter((_, i) => i % 2 === 0),
    sorted.filter((_, i) => i % 2 === 1),
  ];
  let predSum = 0;
  let actualSum = 0;
  let brierSum = 0;
  let n = 0;
  for (const [train, test] of [
    [halves[0], halves[1]],
    [halves[1], halves[0]],
  ] as const) {
    const m = fitOddsOn(train, snapshot.as_of);
    for (const p of test) {
      const { odds } = tokenOdds(m, p, snapshot.as_of);
      const actual = recordsToken(p) ? 1 : 0;
      predSum += odds;
      actualSum += actual;
      brierSum += (odds - actual) * (odds - actual);
      n++;
    }
  }
  return {
    ...full,
    calibration: {
      meanPredicted: round4(predSum / Math.max(1, n)),
      actualShare: round4(actualSum / Math.max(1, n)),
      brier: round4(brierSum / Math.max(1, n)),
      n,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Farm economics: every plan is netted to a verdict.
 * ------------------------------------------------------------------ */

/** The farm model's stated assumptions. They are the model's own claims, printed on the
 *  page beside the verdicts they produce, and every verdict is arithmetic on them. */
export const FARM = {
  /** Share of the fitted launch value assumed to reach early users as a reward pool. */
  poolPct: 0.05,
  /** Share of a protocol's TVL assumed to be farmer capital competing for that pool. */
  capitalShare: 0.25,
  /** The most of the pool one wallet is assumed to take. */
  sliceCapPct: 0.02,
  /** The yield a deposit gives up while it farms (a T-bill rate), per year. */
  forgoneApy: 0.045,
  /** Swap fee on the plan's weekly volume action. */
  swapFee: 0.003,
  /** Deposit sizes the sizing ladder tries, in dollars. */
  deposits: [50, 100, 250, 500, 1000, 2500, 5000],
  /** A FARM verdict needs at least this net and this $/hour — a real day's pay for
   *  the plan's work, not a rounding error; a positive net below either bar is THIN;
   *  a non-positive net at every size is SKIP. */
  farmMinNet: 250,
  farmMinPerHour: 50,
};

/** What one transaction costs on a chain, in dollars a farmer budgets by. */
export function gasUsd(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 8;
  if (c === 'solana') return 0.05;
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'polygon' || c === 'bnb chain') return 0.5;
  return 2;
}

/** The gas figure in words, for step text. */
function gasWords(chain: string): string {
  const g = gasUsd(chain);
  return g >= 1 ? `about $${g} of gas` : `about $${g.toFixed(2)} of gas`;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A compact money figure for step text: $950, $12.4k, $1.23M. */
export function fmtMoney(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (a >= 10_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (a >= 1_000) return `$${(n / 1_000).toFixed(2)}k`;
  return `$${Math.round(n)}`;
}

/** One protocol's netted farm economics at the ladder's best deposit size. */
export interface FarmEconomics {
  verdict: 'FARM' | 'THIN' | 'SKIP';
  /** The deposit the verdict is stated at: the ladder size with the highest net. */
  deposit: number;
  /** Gross slice of the reward pool at that deposit, before odds. */
  sliceGross: number;
  /** The slice after token odds: it only pays if a token ever comes. */
  sliceExpected: number;
  /** Gas plus swap fees over the whole plan. */
  fees: number;
  /** Yield the deposit gives up over the hold. */
  forgone: number;
  /** sliceExpected - fees - forgone, whole dollars. */
  net: number;
  /** Net per active hour of the plan's work. */
  perHour: number;
  /** The smallest ladder deposit whose net is positive, or null when none is. */
  breakEven: number | null;
  holdDays: number;
  hours: number;
}

/** Net one protocol's farm plan at every ladder size and keep the best. */
export function farmEconomics(p: SnapshotProtocol, value: number, odds: number, age: number | null): FarmEconomics {
  const chain = p.chains.length > 0 ? p.chains[0]! : '';
  const gas = gasUsd(chain);
  const holdDays = holdDaysFor(age);
  const weeks = Math.ceil(holdDays / 7);
  const hours = (20 + 10 * weeks + 10) / 60;
  const pool = FARM.poolPct * value;
  const competing = Math.max(1, FARM.capitalShare * p.tvl_usd);
  const at = (deposit: number) => {
    const sliceGross = Math.min(pool * (deposit / competing), FARM.sliceCapPct * pool);
    const sliceExpected = sliceGross * odds;
    const fees = gas * (weeks + 2) + FARM.swapFee * Math.max(10, deposit / 5) * weeks;
    const forgone = deposit * FARM.forgoneApy * (holdDays / 365);
    return { sliceGross, sliceExpected, fees, forgone, net: sliceExpected - fees - forgone };
  };
  let best = { deposit: FARM.deposits[0]!, ...at(FARM.deposits[0]!) };
  let breakEven: number | null = null;
  for (const d of FARM.deposits) {
    const r = at(d);
    if (breakEven === null && r.net > 0) breakEven = d;
    if (r.net > best.net) best = { deposit: d, ...r };
  }
  const perHour = best.net / hours;
  const verdict: FarmEconomics['verdict'] =
    best.net <= 0 ? 'SKIP' : best.net >= FARM.farmMinNet && perHour >= FARM.farmMinPerHour ? 'FARM' : 'THIN';
  return {
    verdict,
    deposit: best.deposit,
    sliceGross: Math.round(best.sliceGross),
    sliceExpected: Math.round(best.sliceExpected),
    fees: Math.round(best.fees),
    forgone: Math.round(best.forgone),
    net: Math.round(best.net),
    perHour: round4(perHour),
    breakEven,
    holdDays,
    hours: round4(hours),
  };
}

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

/** The category's second leg: a different action on the same protocol. */
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
 * A protocol's farm plan: seven steps, each an action with a cost and a time, sized by
 * the netted economics and ending in the verdict those economics produce. The plan is
 * derived from the protocol's own record, never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, econ: FarmEconomics, odds: number): string[] {
  const chain = chainOf(p);
  const capital = econ.deposit;
  const gas = gasWords(chain);
  const verdictText =
    econ.verdict === 'SKIP'
      ? `Verdict SKIP: at every deposit size up to $5,000 the plan's fees and forgone yield beat the expected slice of ${fmtMoney(econ.sliceExpected)} (already weighted by the ${(odds * 100).toFixed(0)}% token odds), so the model's call is to leave ${p.name} alone and farm a higher row.`
      : `Verdict ${econ.verdict}: at the sized deposit of ${fmtMoney(capital)} the expected slice is ${fmtMoney(econ.sliceExpected)} after the ${(odds * 100).toFixed(0)}% token odds, against ${fmtMoney(econ.fees)} of fees and ${fmtMoney(econ.forgone)} of forgone yield: net ${fmtMoney(econ.net)} over about ${econ.hours.toFixed(1)} hours of work (${fmtMoney(econ.perHour)} an hour). The break-even ticket is ${econ.breakEven === null ? 'above the ladder' : fmtMoney(econ.breakEven)}.`;
  const steps: Array<[string, string, string]> = [
    [
      `Use a fresh wallet that holds only the funds you plan to farm with ${p.name}, and keep its seed phrase offline.`,
      'under $3 of gas for the first transaction',
      '5 minutes',
    ],
    [
      primaryAction(p, capital, chain),
      `${fmtMoney(capital)} of capital and ${gas}`,
      '15 minutes to set up',
    ],
    [
      secondAction(p, capital, chain),
      `about ${fmtMoney(Math.max(10, Math.round(capital / 5)))} of volume and ${gas}`,
      '10 minutes a week',
    ],
    [
      `Make one qualifying action each week on ${p.name}, such as a deposit, a borrow, a swap or a vote, and keep the position open between them.`,
      `${gas} a week`,
      '10 minutes a week',
    ],
    [
      `Hold the position for at least ${econ.holdDays} days so the activity is counted in more than one snapshot of the protocol.`,
      `the ${fmtMoney(capital)} stays in the position`,
      `${econ.holdDays} days`,
    ],
    [
      `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes.`,
      'no fee to check, and never pay to claim',
      '10 minutes',
    ],
    [verdictText, 'nothing — this line is the decision, not a step', '2 minutes to read'],
  ];
  return steps.map(([text, cost, time]) => stepText(text, cost, time));
}

/* ------------------------------------------------------------------ *
 * The full-universe ledger: every protocol accounted for, with a reason.
 * ------------------------------------------------------------------ */

/** One ledger group: every protocol in the snapshot lands in exactly one. */
export interface LedgerGroup {
  key: string;
  label: string;
  reason: string;
  count: number;
  slugs: string[];
  names: string[];
}

const LEDGER_META: Array<{ key: string; label: string; reason: string }> = [
  {
    key: 'ranked',
    label: 'Ranked on the board',
    reason: 'Records no token and passes the watchlist’s own exclusions, so the fitted model prices it and the board ranks it by expected launch value.',
  },
  {
    key: 'trades',
    label: 'Token already trades',
    reason: 'Records a token with a market cap above zero. The radar exists for the ones still to come, so these are shown as pricing anchors, never ranked.',
  },
  {
    key: 'unpriced',
    label: 'Token recorded, no market',
    reason: 'DefiLlama carries a gecko id or a symbol but no market cap above zero: a token exists on the record and does not trade at a price the model can anchor to, so it is neither ranked nor used as a comp.',
  },
  {
    key: 'wrapped-product',
    label: 'Wrapped, staked or bridged product',
    reason: 'Its category (Bridge, Canonical Bridge, Cross Chain Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX) makes it a product of a token that already trades — the watchlist rule sets it aside, and so does the board.',
  },
  {
    key: 'versioned',
    label: 'Versioned pool',
    reason: 'Its name ends in a version marker (a space, then V2, v2, 2.0 or the like): a later pool of an existing protocol, not a fresh launch candidate.',
  },
  {
    key: 'exchange',
    label: 'An exchange’s own product',
    reason: 'Its name begins with an exchange’s name (Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex or Gemini): the exchange’s own product, not an independent launch.',
  },
  {
    key: 'wrapped-word',
    label: 'Name says wrapped or staked',
    reason: 'Its name carries the whole word wrapped, staked or staking: by its own name it is a claim on a token that already trades.',
  },
];

/** Classify every protocol in the snapshot into exactly one ledger group. */
export function buildLedger(snapshot: Snapshot, boardSlugs: Set<string>): LedgerGroup[] {
  const groups = new Map<string, SnapshotProtocol[]>(LEDGER_META.map((m) => [m.key, []]));
  for (const p of snapshot.protocols) {
    let key: string;
    if (boardSlugs.has(p.slug)) key = 'ranked';
    else if (p.mcap_usd !== null && p.mcap_usd > 0) key = 'trades';
    else if (recordsToken(p)) key = 'unpriced';
    else key = asideReason(p) ?? 'ranked';
    groups.get(key)!.push(p);
  }
  return LEDGER_META.map((m) => {
    const members = groups.get(m.key)!.sort((a, b) => (a.slug < b.slug ? -1 : 1));
    return { ...m, count: members.length, slugs: members.map((p) => p.slug), names: members.map((p) => p.name) };
  });
}

/* ------------------------------------------------------------------ *
 * The board and the dashboard's dataset.
 * ------------------------------------------------------------------ */

/** One row of board.json: the ranked board's row. implied_value_usd is the headline the
 *  gate sorts by — the expected launch value, value x odds — and the fitted value, the
 *  range and the odds ride beside it so nothing about the rank is hidden. */
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
  value_usd: number;
  p10_usd: number;
  p90_usd: number;
  odds: number;
  model: {
    curve_log: number;
    category_offset: number;
    age_term_log: number;
    comp_n: number;
    lr_age: number;
    lr_sector: number;
    lr_growth: number;
  };
  farm: {
    verdict: 'FARM' | 'THIN' | 'SKIP';
    deposit_usd: number;
    expected_slice_usd: number;
    fees_usd: number;
    forgone_yield_usd: number;
    net_usd: number;
    per_hour_usd: number;
    break_even_usd: number | null;
  };
  farm_steps: string[];
}

/** A board row's form for data.js: the same numbers, farm plan included. */
export interface RadarRow extends Omit<BoardRow, 'mcap_usd' | 'gecko_id' | 'symbol' | 'token_status'> {
  sector: string;
}

/** A traded token as a pricing anchor: what the market says, what the model says. */
export interface AnchorRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  fitted_usd: number;
  err_pct: number;
  age_days: number | null;
}

/** How many traded anchors the dashboard shows, by market cap. */
export const ANCHOR_ROWS = 24;

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  universe_size: number;
  watchlist_slugs: string[];
  /** The fitted parameters the page re-derives every row from (integrity strip). */
  params: {
    b0: number;
    bTvl: number;
    bGrowth: number;
    bAge: number;
    ageCenter: number;
    fitN: number;
    fitNAge: number;
    /** Every protocol in the snapshot carrying a price above zero, before the fit
     *  set's exclusions (dust, exchange tokens, canonical bridges, versioned pools). */
    fitPriced: number;
    offsets: Record<string, { off: number; n: number }>;
    oddsBase: number;
    oddsByAgeBand: Record<string, OddsCell>;
    oddsBySector: Record<string, OddsCell>;
    oddsByGrowth: Record<string, OddsCell>;
    rangeYoung: { q10: number; q90: number };
    rangeSeasoned: { q10: number; q90: number };
    rangePooled: { q10: number; q90: number };
    farm: typeof FARM;
    ageBands: typeof AGE_BANDS;
  };
  validation: Validation;
  calibration: OddsModel['calibration'];
  rows: RadarRow[];
  anchors: AnchorRow[];
  ledger: LedgerGroup[];
}

/** Score one pre-token protocol into a board row (rank assigned after the sort). */
function scoreRow(
  p: SnapshotProtocol,
  snapshot: Snapshot,
  fit: ValueFit,
  validation: Validation,
  oddsModel: OddsModel,
): Omit<BoardRow, 'rank'> & { sector: string } {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const parts = fittedLogValue(fit, p.tvl_usd, p.change_7d, p.category, age);
  const value = Math.max(1, Math.round(Math.exp(parts.log)));
  const band = age === null ? validation.rangePooled : age < YOUNG_DAYS ? validation.rangeYoung : validation.rangeSeasoned;
  const p10 = Math.max(1, Math.round(value * Math.exp(band.q10)));
  const p90 = Math.max(p10 + 1, Math.round(value * Math.exp(band.q90)));
  const o = tokenOdds(oddsModel, p, snapshot.as_of);
  const expected = Math.max(1, Math.round(value * o.odds));
  const econ = farmEconomics(p, value, o.odds, age);
  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    sector: sectorGroup(p.category),
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: null,
    listed_at: p.listed_at,
    gecko_id: null,
    symbol: null,
    token_status: 'pre-token',
    age_days: age,
    implied_value_usd: expected,
    value_usd: value,
    p10_usd: p10,
    p90_usd: p90,
    odds: o.odds,
    model: {
      curve_log: round4(parts.curve),
      category_offset: round4(parts.offset),
      age_term_log: round4(parts.ageTerm),
      comp_n: fit.offsets[p.category ?? 'Other']?.n ?? 0,
      lr_age: round4(o.lrAge),
      lr_sector: round4(o.lrSector),
      lr_growth: round4(o.lrGrowth),
    },
    farm: {
      verdict: econ.verdict,
      deposit_usd: econ.deposit,
      expected_slice_usd: econ.sliceExpected,
      fees_usd: econ.fees,
      forgone_yield_usd: econ.forgone,
      net_usd: econ.net,
      per_hour_usd: econ.perHour,
      break_even_usd: econ.breakEven,
    },
    farm_steps: farmSteps(p, age, econ, o.odds),
  };
}

/** Everything the dashboard renders, from the snapshot: fit, validate, score, account. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { fit, validation } = validateModel(snapshot);
  const oddsModel = fitOdds(snapshot);
  const rankable = snapshot.protocols.filter(isRankable);
  const scored = rankable.map((p) => scoreRow(p, snapshot, fit, validation, oddsModel));
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  const board: BoardRow[] = scored.map((r, i) => {
    const { sector: _sector, ...row } = r;
    return { rank: i + 1, ...row };
  });
  const rows: RadarRow[] = scored.map((r, i) => {
    const { mcap_usd: _m, gecko_id: _g, symbol: _s, token_status: _t, ...rest } = r;
    return { rank: i + 1, ...rest };
  });
  const boardSlugs = new Set(board.map((r) => r.slug));
  const ledger = buildLedger(snapshot, boardSlugs);
  // Anchors: the fit set itself, sampled evenly across the size range (largest first,
  //  then every k-th by market cap), so the table shows the model's pricing on small
  //  and large tokens alike — not only the giants every model underprices.
  const fitSet = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd >= FIT_MIN_MCAP && p.tvl_usd > 0 && !capPricesAnother(p))
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1));
  const stride = Math.max(1, Math.floor(fitSet.length / ANCHOR_ROWS));
  const anchors: AnchorRow[] = fitSet
    .filter((_, i) => i % stride === 0)
    .slice(0, ANCHOR_ROWS)
    .map((p) => {
      const fitted = fittedValue(fit, p, snapshot.as_of);
      return {
        slug: p.slug,
        name: p.name,
        category: p.category,
        tvl_usd: p.tvl_usd,
        mcap_usd: p.mcap_usd!,
        fitted_usd: fitted,
        err_pct: round4(((fitted - p.mcap_usd!) / p.mcap_usd!) * 100),
        age_days: ageDays(snapshot.as_of, p.listed_at),
      };
    });
  const watch = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    live_size: anchors.length,
    universe_size: snapshot.protocols.length,
    watchlist_slugs: [...snapshot.watchlist].sort(),
    params: {
      b0: fit.b0,
      bTvl: fit.bTvl,
      bGrowth: fit.bGrowth,
      bAge: fit.bAge,
      ageCenter: fit.ageCenter,
      fitN: fit.n,
      fitNAge: fit.nAge,
      fitPriced: snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length,
      offsets: fit.offsets,
      oddsBase: oddsModel.base,
      oddsByAgeBand: oddsModel.byAgeBand,
      oddsBySector: oddsModel.bySector,
      oddsByGrowth: oddsModel.byGrowth,
      rangeYoung: { q10: validation.rangeYoung.q10, q90: validation.rangeYoung.q90 },
      rangeSeasoned: { q10: validation.rangeSeasoned.q10, q90: validation.rangeSeasoned.q90 },
      rangePooled: { q10: validation.rangePooled.q10, q90: validation.rangePooled.q90 },
      farm: FARM,
      ageBands: AGE_BANDS,
    },
    validation,
    calibration: oddsModel.calibration,
    rows,
    anchors,
    ledger,
  };
  return { board, radar };
}

/** The board alone, for callers that only need board.json's rows. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  return buildRadar(snapshot).board;
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

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared
 *  implied value, farm steps, and the ledger accounting for the whole snapshot. */
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
    if (!(r.odds > 0 && r.odds < 1)) return `${r.slug} has token odds ${r.odds}`;
    if (!(r.p10_usd <= r.value_usd && r.value_usd <= r.p90_usd)) return `${r.slug} has its value outside its own range`;
  }
  const ledger = buildLedger(snapshot, slugs);
  const accounted = ledger.reduce((s, g) => s + g.count, 0);
  if (accounted !== snapshot.protocols.length) return `the ledger accounts for ${accounted} of ${snapshot.protocols.length} protocols`;
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
