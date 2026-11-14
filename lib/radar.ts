// The radar's model: one snapshot in, one ranked board out.
//
// The number that ranks the board is an implied value at launch, built from three factors that each
// come out of the snapshot itself:
//
//   implied = tvl_usd x comp(multiple) x momentum x maturity
//
//   comp       what protocols that already trade are worth against their own TVL, in the same
//              category: the median of mcap_usd / tvl_usd over the snapshot's own token-bearing
//              protocols. A category with fewer than five readings borrows its family's median
//              (yield, trading, lending, bridge, staking), and one under that borrows the whole
//              snapshot's. The board carries the multiple, its sample size and where it came from,
//              so a reader can see how thin the evidence behind any single row is.
//   momentum   1 + 0.75 x clamp(change_7d, -40, 40)%: capital arriving is the one forward-looking
//              figure the snapshot carries, damped so a single week cannot outweigh a multi-year record.
//   maturity   0.70 + 0.30 x min(age, 1095) / 1095: a protocol that has run longer without a token
//              has more of a record to sell, and the curve stops at three years.
//
// No protocol's name is special-cased: one function prices every row. The board ranks every protocol
// that records no token and is not a wrapped, staked, bridged or restaked product of one that trades —
// the watchlist's own forty at the floor the house drew, and the ones below it, found by the same rule.
// Protocols whose token already trades are held apart as the evidence, never mixed into the model.

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    this.name = 'SnapshotError';
    this.message = message;
  }
}

const DAY_MS = 86_400_000;

/** The model's constants: stated on the page and used, unchanged, for every row. */
export const MODEL = {
  version: 'radar-comps-1',
  momentum_weight: 0.75,
  momentum_floor: -40,
  momentum_cap: 40,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  unknown_age_days: 365,
  comp_floor: 0.05,
  comp_cap: 2.5,
  comp_min_sample: 5,
  implied_cap: 100_000_000_000_000,
} as const;

/** One measured multiple: a category's or a family's median market cap per dollar of TVL. */
export interface Comp {
  key: string;
  multiple: number;
  sample: number;
}

/** Where a row's multiple came from. */
export type CompSource = 'category' | 'family' | 'snapshot';

/** A protocol's place on the board. */
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
  watchlisted: boolean;
  below_floor: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    comp_multiple: number;
    comp_sample: number;
    comp_source: CompSource;
    comp_key: string;
    momentum_multiplier: number;
    maturity_multiplier: number;
    growth_pct: number | null;
  };
  farm_steps: string[];
}

/** A token-bearing protocol, in the market's own numbers. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
}

/** Everything the page renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: typeof MODEL;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  live_recorded: number;
  global_multiple: number;
  global_sample: number;
  comps: Comp[];
  families: Comp[];
  rows: BoardRow[];
  live: LiveRow[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Whole days from the snapshot's date back to the day a protocol was first tracked; null if unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const now = Date.parse(`${asOf}T00:00:00Z`);
  const then = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(now) || !Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now - then) / DAY_MS));
}

/** Whether a protocol records no token at all: the snapshot's own definition of pre-token. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)/i;
const NOT_A_LAUNCH = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/**
 * Whether a protocol is waiting on a launch of its own: it records no token, and it is not a wrapped,
 * staked, bridged or restaked product of one that already trades, a versioned pool of another protocol,
 * or an exchange's own arm. The same visible rule the house's watchlist applies above the floor.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && NOT_A_LAUNCH.has(p.category)) return false;
  if (VERSIONED.test(p.name) || WRAPPED.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The broad family a category belongs to, so a thin category can borrow a measured multiple. */
export function familyOf(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c === '') return 'other';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('credit')) return 'lending';
  if (c.includes('dex') || c.includes('swap') || c.includes('perpetual') || c.includes('derivative') || c.includes('basis') || c.includes('perp')) return 'trading';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('staking') || c.includes('restak')) return 'staking';
  if (c.includes('rwa') || c.includes('real world')) return 'rwa';
  if (c.includes('yield') || c.includes('farm') || c.includes('vault') || c.includes('curator') || c.includes('allocator') || c.includes('strateg')) return 'yield';
  if (c.includes('stable')) return 'stablecoin';
  if (c.includes('insurance')) return 'insurance';
  return 'other';
}

/** Every measured market-cap-per-TVL ratio in the snapshot, by category and by family. */
function ratios(snapshot: Snapshot): { byCategory: Map<string, number[]>; byFamily: Map<string, number[]>; all: number[] } {
  const byCategory = new Map<string, number[]>();
  const byFamily = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    const mcap = p.mcap_usd;
    if (mcap === null || mcap <= 0 || p.tvl_usd <= 0) continue;
    const r = mcap / p.tvl_usd;
    all.push(r);
    const cat = p.category ?? 'uncategorised';
    const cbucket = byCategory.get(cat);
    if (cbucket === undefined) byCategory.set(cat, [r]);
    else cbucket.push(r);
    const fam = familyOf(p.category);
    const fbucket = byFamily.get(fam);
    if (fbucket === undefined) byFamily.set(fam, [r]);
    else fbucket.push(r);
  }
  return { byCategory, byFamily, all };
}

const asComp = (key: string, values: number[]): Comp => ({
  key,
  multiple: round4(clamp(median(values), MODEL.comp_floor, MODEL.comp_cap)),
  sample: values.length,
});

/** The categories and families the model prices against, each with its median and its sample size. */
export function comparables(snapshot: Snapshot): { comps: Comp[]; families: Comp[]; global: Comp } {
  const { byCategory, byFamily, all } = ratios(snapshot);
  const comps = [...byCategory.entries()].map(([key, values]) => asComp(key, values)).sort((a, b) => b.sample - a.sample || (a.key < b.key ? -1 : 1));
  const families = [...byFamily.entries()].map(([key, values]) => asComp(key, values)).sort((a, b) => b.sample - a.sample || (a.key < b.key ? -1 : 1));
  const global = all.length > 0 ? asComp('snapshot', all) : { key: 'snapshot', multiple: 1, sample: 0 };
  return { comps, families, global };
}

/** The multiple one protocol is priced at, and the evidence behind it. */
export function compFor(p: SnapshotProtocol, table: { comps: Comp[]; families: Comp[]; global: Comp }): Comp & { source: CompSource } {
  const category = p.category ?? 'uncategorised';
  const hit = table.comps.find((c) => c.key === category);
  if (hit !== undefined && hit.sample >= MODEL.comp_min_sample) return { ...hit, source: 'category' };
  const famKey = familyOf(p.category);
  const fam = table.families.find((c) => c.key === famKey);
  if (fam !== undefined && fam.sample >= MODEL.comp_min_sample) return { ...fam, key: famKey, source: 'family' };
  return { ...table.global, key: famKey, source: 'snapshot' };
}

/** 1 + 0.75 x the clamped seven-day change: capital arriving lifts a launch's implied value, damped. */
export function momentumMultiplier(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  const pct = clamp(change7d, MODEL.momentum_floor, MODEL.momentum_cap);
  return round4(1 + (pct / 100) * MODEL.momentum_weight);
}

/** 0.70 + 0.30 x min(age, 1095) / 1095: longer without a token is a longer record to sell. */
export function maturityMultiplier(age: number | null): number {
  const used = age ?? MODEL.unknown_age_days;
  return round4(MODEL.maturity_floor + (clamp(used, 0, MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range);
}

/** The implied value one protocol gets, with the factors that built it. */
export function impliedValue(p: SnapshotProtocol, comp: Comp, asOf: string): { implied: number; momentum: number; maturity: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const momentum = momentumMultiplier(p.change_7d);
  const maturity = maturityMultiplier(age);
  const raw = p.tvl_usd * comp.multiple * momentum * maturity;
  return { implied: Math.min(MODEL.implied_cap, Math.max(1, Math.round(raw))), momentum, maturity, age };
}

// ------------------------------------------------------------------ the farm plan

const CHAIN_GAS: Record<string, string> = {
  Ethereum: 'about $6 of gas for the two transactions',
  Solana: 'under $0.10 of fees',
  Base: 'about $0.20 of gas',
  Arbitrum: 'about $0.30 of gas',
  Binance: 'about $0.40 of gas',
  Bitcoin: 'the protocol\u2019s own BTC fee, about $2',
  Hyperliquid: 'about $0.05 of fees',
  Monad: 'about $0.10 of gas',
};

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

const chainOf = (p: SnapshotProtocol): string => (p.chains.length > 0 ? p.chains[0]! : 'its main chain');
const gasFor = (chain: string): string => CHAIN_GAS[chain] ?? 'the chain\u2019s own gas, about $1';

/** How much capital one position needs, scaled off the protocol's own TVL. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 250_000_000) return 100;
  if (p.tvl_usd >= 50_000_000) return 75;
  return 50;
}

/** How long a qualifying position stays open: a younger protocol needs a longer window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's own action, with the capital and the chain in it. */
export function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} of USDC into one ${n} vault on ${chain} and keep the vault shares.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${n} on ${chain} and borrow a small amount against it.`;
  if (c.includes('dex') || c.includes('swap')) return `Provide $${capital} of liquidity to ${n}\u2019s deepest pool on ${chain} and leave it in range.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis') || c.includes('perp')) return `Deposit $${capital} of USDC as margin on ${n} and open one hedged position.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${n} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of ${chain}\u2019s staking asset through ${n} and keep the receipt token.`;
  if (c.includes('rwa') || c.includes('real world')) return `Mint $${capital} of ${n}\u2019s yield asset on ${chain} and hold it in the same wallet.`;
  if (c.includes('yield') || c.includes('farm')) return `Deposit $${capital} of USDC into ${n}\u2019s main vault on ${chain} and keep it through the week.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain}.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy open.`;
  if (c.includes('payment')) return `Move $${capital} of USDC through ${n} on ${chain} and leave a balance in its account.`;
  if (c.includes('governance') || c.includes('incentive')) return `Lock $${capital} of the protocol\u2019s deposit asset in ${n} on ${chain} for one epoch.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open.`;
}

/** A protocol's plan: five steps, each with its cost and its time, all derived from its own record. */
export function farmPlan(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  return [
    {
      text: `Open a wallet for this position only, on ${chain}, and write its seed phrase down offline.`,
      cost: 'nothing to open, and never pay for a wallet',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital plus ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action a week on ${p.name}: a deposit, a borrow, a swap or a vote, whichever its interface counts.`,
      cost: `${gas} a week`,
      time: '10 minutes a week',
    },
    {
      text: `Keep the position open for at least ${hold} days so the activity lands in more than one snapshot of ${p.name}\u2019s record.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Check ${p.name}\u2019s own site for a points or rewards page, claim only from a link it publishes, and log every transaction.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
  ];
}

// ------------------------------------------------------------------ the board

/**
 * The whole board: the watchlist's forty at the floor the house drew, plus every protocol below it that
 * passes the same visible rule, strongest implied value first, ranks 1..n.
 */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; table: { comps: Comp[]; families: Comp[]; global: Comp } } {
  const table = comparables(snapshot);
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) if (watch.has(p.slug)) chosen.set(p.slug, p);
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug)) continue;
    if (p.tvl_usd >= snapshot.floor_usd) continue;
    if (!isLaunchCandidate(p)) continue;
    chosen.set(p.slug, p);
  }

  const missing = snapshot.watchlist.filter((slug) => !chosen.has(slug));
  if (missing.length > 0) throw new SnapshotError(`the snapshot carries no record for ${missing.length} watchlist slug(s): ${missing.slice(0, 5).join(', ')}`);

  const ranked: BoardRow[] = [];
  for (const p of chosen.values()) {
    const comp = compFor(p, table);
    const { implied, momentum, maturity, age } = impliedValue(p, comp, snapshot.as_of);
    ranked.push({
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      watchlisted: watch.has(p.slug),
      below_floor: p.tvl_usd < snapshot.floor_usd,
      age_days: age,
      implied_value_usd: implied,
      model: {
        comp_multiple: comp.multiple,
        comp_sample: comp.sample,
        comp_source: comp.source,
        comp_key: comp.key,
        momentum_multiplier: momentum,
        maturity_multiplier: maturity,
        growth_pct: p.change_7d === null ? null : round4(p.change_7d),
      },
      farm_steps: farmPlan(p, age).map(stepText),
    });
  }
  // A total order — implied value, then TVL, then slug — so two runs never disagree.
  ranked.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (let i = 0; i < ranked.length; i++) ranked[i]!.rank = i + 1;
  return { board: ranked, table };
}

/** A step as one string, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  return s.length < 20 ? `${s} Log it.` : s;
}

/** The token-bearing protocols, in the market's own numbers: they are the evidence, never rows of the board. */
export function liveRows(snapshot: Snapshot): { live: LiveRow[]; recorded: number } {
  const out: LiveRow[] = [];
  let recorded = 0;
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    recorded++;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    out.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      ratio: round4(p.mcap_usd / p.tvl_usd),
      change_7d: p.change_7d,
    });
  }
  out.sort((a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { live: out, recorded };
}

/** Everything the page needs, assembled once. */
export function buildRadar(snapshot: Snapshot): RadarData {
  const { board, table } = buildBoard(snapshot);
  const { live, recorded } = liveRows(snapshot);
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => r.below_floor).length,
    live_size: live.length,
    live_recorded: recorded,
    global_multiple: table.global.multiple,
    global_sample: table.global.sample,
    comps: table.comps,
    families: table.families,
    rows: board,
    live,
  };
}

/** The page's whole dataset, as one script: no fetch, no network, one file. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/** Why a board is not one the gate takes, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug(s): ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  for (let i = 0; i < board.length; i++) if (board[i]!.rank !== i + 1) return `rank ${i + 1} is ${board[i]!.rank}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist');
  const protocols: SnapshotProtocol[] = (o.protocols as unknown[]).map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? (p.chains as unknown[]).filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}
