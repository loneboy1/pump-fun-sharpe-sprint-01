// Clean-surge paper bot for "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins"
// (make.fun, pumpfun-replay/v2, agent-fun/replay/v2).
//
// Design, from measuring the dev window before writing any rule:
//  * Chasing a move already in progress loses to the 2-slot fill latency — the
//    crossing trade IS the spike, and a fill 2 slots later buys its top.
//  * A coin's fate is largely written by its first few trades: coins with no
//    distinct non-creator buyer in their first trades almost never run, while
//    coins with a real buyer surge (several distinct buyers + net buy flow +
//    a modest run-up) do. Dips do not bounce.
//  * Fees are the enemy of Sharpe: every round trip pays 125 bps of curve
//    fees plus 2 x 105000 lamports of tx fees, so a trade must be sized and
//    held long enough to earn its keep. Tight take-profits (+8/+15%) churn
//    the stake through fees and lose; wide take-profits with a long hold let
//    the few real runners pay for the many small losers, which is exactly
//    what a Sharpe ranking rewards: many small, similar losses and a few
//    large wins, i.e. low variance per unit of return.
//
// So this bot does one thing: it waits for the buyer surge to CONFIRM
// (at least 6 distinct buyers + net buy flow + a 10–50% run-up, all inside
// the coin's first 5 slots), buys once at a tight slippage so spike tops
// are refused for free, and rides it with a wide take-profit (+80%), a
// stop (−25%), a long maximum hold (500 slots), and an instant exit the
// moment the creator sells. No adds, no probes, no averaging down, and no
// trailing stop — the grid showed every trailing variant cuts the runners
// short and lowers both net and Sharpe. Every fill pays its own tx fee,
// so a fill must earn it.
//
// Pure function of the batches: no clock, no environment, no randomness,
// no network. Two executions agree byte for byte.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const BPS = 10_000n;
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30, the fallback the harness charges
const TX_FEE_LAMPORTS = 105_000n; // base 5000 + priority 100000 per order

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  if (q <= 0n) return 0n;
  const fee = (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
  return q > fee ? q - fee : 0n;
}

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin (each buy still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys: skip the coin when the creator put in more than this. */
  maxDevBuy: number;
  /** Distinct non-creator buyers seen before entry. */
  minBuyers: number;
  /** Net buy flow (bought minus sold by others, lamports) required before entry. */
  minFlowLamports: number;
  /** Price now over the create price, as bps: entry window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Slippage allowed on buys / sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Sell everything once the position is worth this much over its full cost. */
  tpBps: number;
  /** Sell everything once the position is worth this much under its full cost. */
  slBps: number;
  /** Sell everything this many slots after the buy fill, whatever the price. */
  maxHold: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 5,
  stakeLamports: 50_000_000, // 0.05 SOL
  minRealSol: 500_000_000, // 0.5 SOL
  maxRealSol: 30_000_000_000, // 30 SOL
  maxDevBuy: 2_000_000_000, // 2 SOL
  minBuyers: 6,
  minFlowLamports: 20_000_000, // 0.02 SOL
  minRunupBps: 11_000, // 1.10x
  maxRunupBps: 15_000, // 1.50x
  buySlippageBps: 500,
  sellSlippageBps: 1000,
  tpBps: 8000, // +80%
  slBps: 2500, // -25%
  maxHold: 500,
};

interface Book {
  creator: string;
  createdSlot: number;
  createPriceNum: bigint; // vq at create
  createPriceDen: bigint; // vt at create
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<string>;
  netFlow: bigint;
  trades: number;
}

interface Held {
  buySlot: number;
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const p = params;
  const books = new Map<Pubkey, Book>();
  const entered = new Set<Pubkey>(); // a buy was decided for this mint (one shot)
  const held = new Map<Pubkey, Held>();
  const creatorSoldAfterBuy = new Set<Pubkey>();

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // ---- fold this batch's fills first: record buy fills, drop exited coins.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') {
        held.set(f.mint, { buySlot: f.slot });
      }
      if (f.side === 'sell' && f.status === 'filled') {
        held.delete(f.mint);
        creatorSoldAfterBuy.delete(f.mint);
      }
    }
    // Positions the harness closed for us (complete / flatten / writeoff).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) {
        held.delete(mint);
        creatorSoldAfterBuy.delete(mint);
      }
    }

    // ---- fold this batch's events into the launch books.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!books.has(e.mint)) {
          books.set(e.mint, {
            creator: e.creator,
            createdSlot: e.slot,
            createPriceNum: BigInt(e.virtual_quote_reserves),
            createPriceDen: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            devSold: false,
            buyers: new Set(),
            netFlow: 0n,
            trades: 0,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const b = books.get(e.mint);
        if (b === undefined) continue;
        b.trades += 1;
        const amt = BigInt(e.sol_amount);
        if (e.user === b.creator) {
          if (e.is_buy) b.devBuy += amt;
          else b.devSold = true;
        } else {
          if (e.is_buy) {
            b.buyers.add(e.user);
            b.netFlow += amt;
          } else {
            b.netFlow -= amt;
          }
        }
        if (!e.is_buy && e.user === b.creator && held.has(e.mint)) {
          creatorSoldAfterBuy.add(e.mint);
        }
      }
    }

    // ---- exits first: a slot spent exiting is never spent entering.
    const pendingSell = new Set<Pubkey>();
    for (const po of state.pending.values()) {
      if (po.order.side === 'sell') pendingSell.add(po.order.mint);
    }
    const heldMints = [...state.positions.keys()].sort();
    for (const mint of heldMints) {
      if (pendingSell.has(mint)) continue;
      const pos = state.positions.get(mint)!;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const h = held.get(mint);
      const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      // Full round-trip cost: curve-paid cost plus both tx fees.
      const fullCost = pos.cost_lamports + 2n * TX_FEE_LAMPORTS;
      let exit = false;
      if (value >= (fullCost * (BPS + BigInt(p.tpBps))) / BPS) exit = true;
      else if (value <= (fullCost * (BPS - BigInt(p.slBps))) / BPS) exit = true;
      else if (creatorSoldAfterBuy.has(mint)) exit = true;
      else if (h !== undefined && batch.slot - h.buySlot >= p.maxHold) exit = true;
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
      }
    }

    // ---- entries: only mints that traded in this batch, youngest first.
    if (state.committedPositionCount() < 5) {
      const candidates: Pubkey[] = [];
      for (const e of batch.events) {
        if (e.event === 'TradeEvent' && !candidates.includes(e.mint)) candidates.push(e.mint);
      }
      let entriesSent = 0;
      for (const mint of candidates) {
        if (entriesSent >= 5) break;
        if (state.committedPositionCount() + entriesSent >= 5) break;
        if (entered.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        const b = books.get(mint);
        const curve = state.curves.get(mint);
        if (b === undefined || curve === undefined || curve.complete) continue;
        const age = batch.slot - b.createdSlot;
        if (age < p.minAge || age > p.maxAge) continue;
        if (b.devSold) continue;
        if (b.devBuy > BigInt(p.maxDevBuy)) continue;
        if (b.buyers.size < p.minBuyers) continue;
        if (b.netFlow < BigInt(p.minFlowLamports)) continue;
        if (curve.real_quote_reserves < BigInt(p.minRealSol) || curve.real_quote_reserves > BigInt(p.maxRealSol)) continue;
        // Run-up window: price now over create price.
        if (b.createPriceDen === 0n || curve.virtual_token_reserves === 0n) continue;
        const runupBps =
          (curve.virtual_quote_reserves * b.createPriceDen * BPS) /
          (curve.virtual_token_reserves * b.createPriceNum);
        if (runupBps < BigInt(p.minRunupBps) || runupBps > BigInt(p.maxRunupBps)) continue;
        // Size: aim for the stake, capped at 1% of real reserves, never under 0.01 SOL.
        const cap = state.maxBuyLamports(mint);
        let stake = BigInt(p.stakeLamports);
        if (stake > cap) stake = cap;
        if (stake < 10_000_000n) continue; // 0.01 SOL: the guardrail's round-trip bar
        if (state.freeCashLamports() < stake + TX_FEE_LAMPORTS) continue;
        entered.add(mint);
        entriesSent += 1;
        orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: p.buySlippageBps });
      }
    }

    // ---- prune books for coins long past entry age to bound memory.
    if (books.size > 4000) {
      for (const [mint, b] of books) {
        if (batch.slot - b.createdSlot > p.maxAge + p.maxHold && !state.positions.has(mint)) books.delete(mint);
      }
    }

    return orders;
  }

  return onBatch;
}
