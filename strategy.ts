// strategy.ts — Pump.fun Sharpe Sprint REBUILD #2 (Bima, 26 Nov 2026).
// Satu mode aktif: J (judged runner). Leg D (dip-snipe) DIABLasi: kalah di semua
// konfigurasi sweep (net -0.77..-1.47 SOL); dipMinBuyers 999 menonaktifkannya.
// Desain J: judgement umur 45 + second look 60, ride ke 2x/4x, adds HANYA ke
// kekuatan nyata (jAddMinGain 0.10 — tiap wiggle +5% menambah 0.35 SOL adalah
// bug build-1: posisi 0.01 -> 0.71 dalam 48 detik lalu rug -80% = trip -0.58 SOL).
// Hour-lock: di 45 menit terakhir tiap jam, jual 100% posisi yang >= +1% —
// mengunci gain sebelum mark akhir jam (mark itulah yang dihitung Sharpe).
// Bukti sweep (sim lokal, dataset dev 2-3 Nov, 4 slice 6 jam):
//   net 24h +1.86 SOL, Sharpe 24h 0.455, DD 4.7%, 75 trip / 75 koin,
//   avgW +0.094 / avgL -0.014, maxW +0.73 / maxL -0.30,
//   slice Sharpe -0.42 / 0.89 / 0.09 / 0.16 (mean 0.183, min -0.417).
// Lock grid (12 konfigurasi): 2700 detik / mult 1.01 / frac 1.0 terbaik
// (mean 0.204 pada jAddMinGain 0.05; 0.183 pada 0.10 yang lebih robust).
// Lock 3600 detik menghancurkan (mean -0.66: semua terjual di +1%, tanpa upside).
// Target rebuild (mean slice >= 0.55, min >= 0.45) TIDAK tercapai — tes oracle
// (filter sempurna, hanya koin yang PASTI 2x) pun mean -0.23: langit-langit
// desain ini di bawah bar. Entry ini diajukan sebagai yang paling robust yang
// ditemukan (DD, maxL, net, Sharpe 24h semuanya lebih baik dari build 1),
// bukan sebagai yang memenuhi bar. Keputusan LAYAK/TIDAK di tangan reviewer.
import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

export const DEFAULT_PARAMS = {
  // --- judged leg (J) ---
  judgeAge: 45,
  secondLookAge: 60,
  judgedEntryMaxAge: 150,
  minReservesSol: 15,
  maxReservesSol: 80,
  minMult: 1.5,
  maxMult: 8,
  minBuyers: 18,
  minBuys: 10,
  minFlowSol: 3,
  // --- ownership gates (veto hanya bila >=5 holder terdata) ---
  vetoTop1Bps: 1500,
  vetoGiniBps: 7000,
  // --- dip leg (D): DINONAKTIFKAN — ablated, kalah di semua sweep ---
  dipMinAge: 45,
  dipPct: 0.2,
  bouncePct: 0.1,
  dipMinBuyers: 999,
  dipMaxAge: 300,
  dipBounceWindowSlots: 120, // bounce harus <=120 slot setelah dasar dip
  // --- sizing ---
  firstStakeSol: 0.01, // mode J
  dipStakeSol: 0.05, // mode D (tanpa add; fee relatif lebih kecil)
  jAddSol: 0.35,
  jMaxAdds: 2,
  jCapSol: 0.9,
  jAddMinGain: 0.1,
  // --- exits mode J ---
  jTp1Mult: 2.0,
  jTp1Frac: 0.7,
  jTp2Mult: 4.0,
  jTp2Frac: 0.5,
  jStopMult: 0.85,
  jTrailArm: 1.4,
  jTrailGiveback: 0.3,
  jCollapseFrac: 0.4,
  jStaleSlots: 600,
  jMaxHoldSlots: 1000,
  jHourLockMult: 1.01,
  jHourLockFrac: 1.0,
  // --- exits mode D ---
  dTp1Mult: 1.12,
  dTp1Frac: 0.8,
  dTp2Mult: 1.25,
  dTp2Frac: 1.0, // jual semua sisa di +25%
  dStopMult: 0.9,
  dMaxHoldSlots: 200,
  dStaleSlots: 200,
  dHourLockMult: 1.1,
  dHourLockFrac: 0.7,
  // --- umum ---
  minSellProceedsSol: 0.005,
  maxOpen: 5,
  maxNewPerBatch: 3,
  buySlippageBps: 500,
  sellSlippageBps: 500,
  reentryCooldownSlots: 600,
  hourLockLastSec: 2700,
};

export type Params = typeof DEFAULT_PARAMS;

export const STATS = {
  dipCandidate: 0,
  dipBuyersFail: 0,
  dipPass: 0,
  judgedEval: 0,
  judgedPass: 0,
  judgedResFail: 0,
  judgedMultFail: 0,
  judgedBuyersFail: 0,
  judgedBuysFail: 0,
  judgedFlowFail: 0,
  judgedGateFail: 0,
  jEntries: 0,
  dEntries: 0,
  jPnlSol: 0,
  dPnlSol: 0,
  jTripsClosed: 0,
  dTripsClosed: 0,
  loopIters: 0,
};

interface CoinTrack {
  mint: string;
  createdSlot: number;
  createPrice: number;
  peakPrice: number;
  dipLow: number;
  dipLowSlot: number;
  buyers: Set<string>;
  buys: number;
  flowLamports: bigint;
  judged: boolean;
  judgedPass: boolean;
  secondLookDone: boolean;
  lastTop1Bps: number | null;
  lastGiniBps: number | null;
  lastShCount: number;
  peakReserves: bigint;
  lastTradeSlot: number;
  complete: boolean;
  cooldownUntil: number;
}

interface PosMeta {
  mode: 'J' | 'D';
  entrySlot: number;
  peakMult: number;
  tp1Done: boolean;
  tp2Done: boolean;
  adds: number;
  lastBuyPrice: number;
  peakReserves: bigint;
  lastTradeSlot: number;
  exiting: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function giniBps(shares: number[]): number {
  const n = shares.length;
  if (n <= 1) return 0;
  const sorted = [...shares].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let cum = 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    cum += sorted[i];
    area += cum;
  }
  const g = (2 * area) / (n * total) - (n + 1) / n;
  return Math.round(Math.max(0, Math.min(1, g)) * 10000);
}

export function createStrategy(p: Params): Bot {
  const coins = new Map<string, CoinTrack>();
  const metas = new Map<string, PosMeta>();
  let firstBt: number | null = null;

  function gatesPass(c: CoinTrack): boolean {
    if (c.lastShCount < 5) return true;
    if (c.lastTop1Bps !== null && c.lastTop1Bps > p.vetoTop1Bps) return false;
    if (c.lastGiniBps !== null && c.lastGiniBps > p.vetoGiniBps) return false;
    return true;
  }

  function judgedPassNow(state: BotState, c: CoinTrack): boolean {
    const curve = state.curves.get(c.mint);
    if (!curve) return false;
    const resSol = Number(curve.real_quote_reserves) / 1e9;
    if (resSol < p.minReservesSol || resSol > p.maxReservesSol) {
      STATS.judgedResFail += 1;
      return false;
    }
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (c.createPrice <= 0) return false;
    const mult = price / c.createPrice;
    if (mult < p.minMult || mult > p.maxMult) {
      STATS.judgedMultFail += 1;
      return false;
    }
    if (c.buyers.size < p.minBuyers) {
      STATS.judgedBuyersFail += 1;
      return false;
    }
    if (c.buys < p.minBuys) {
      STATS.judgedBuysFail += 1;
      return false;
    }
    if (Number(c.flowLamports) / 1e9 < p.minFlowSol) {
      STATS.judgedFlowFail += 1;
      return false;
    }
    if (!gatesPass(c)) {
      STATS.judgedGateFail += 1;
      return false;
    }
    return true;
  }

  function newCoin(mint: string, slot: number, vq: bigint, vt: bigint): CoinTrack {
    const price = priceOf(vq, vt);
    const c: CoinTrack = {
      mint,
      createdSlot: slot,
      createPrice: price,
      peakPrice: price,
      dipLow: price,
      dipLowSlot: slot,
      buyers: new Set(),
      buys: 0,
      flowLamports: 0n,
      judged: false,
      judgedPass: false,
      secondLookDone: false,
      lastTop1Bps: null,
      lastGiniBps: null,
      lastShCount: 0,
      peakReserves: 0n,
      lastTradeSlot: slot,
      complete: false,
      cooldownUntil: 0,
    };
    coins.set(mint, c);
    return c;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;
    const txFee = state.txFeeLamports();

    // --- 1. lipat event batch ke tracking koin ---
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined && firstBt === null) {
        firstBt = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          newCoin(e.mint, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        }
      } else if (e.event === 'TradeEvent') {
        let c = coins.get(e.mint);
        if (!c) c = newCoin(e.mint, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (price > c.peakPrice) c.peakPrice = price;
        if (price < c.dipLow) {
          c.dipLow = price;
          c.dipLowSlot = e.slot;
        }
        if (e.is_buy) {
          c.buyers.add(e.user);
          c.buys += 1;
          c.flowLamports += BigInt(e.sol_amount);
        } else {
          c.flowLamports -= BigInt(e.sol_amount);
        }
        const sh = (e as { shareholders?: { address: string; share_bps: number }[] }).shareholders;
        if (sh && sh.length > 0) {
          const shares = sh.map((s) => s.share_bps);
          c.lastTop1Bps = Math.max(...shares);
          c.lastGiniBps = giniBps(shares);
          c.lastShCount = sh.length;
        }
        const rq = BigInt(e.real_quote_reserves);
        if (rq > c.peakReserves) c.peakReserves = rq;
        c.lastTradeSlot = e.slot;
      } else {
        const c = coins.get(e.mint);
        if (c) c.complete = true;
      }
    }

    // --- 2. fills batch ini: realized PnL per mode + sell ditolak -> batalkan exiting ---
    for (const f of batch.fills) {
      const m = metas.get(f.mint);
      if (m && f.status === 'filled') {
        const q = Number(f.quote_lamports) / 1e9;
        const tx = Number(f.tx_fee_lamports) / 1e9;
        const delta = f.side === 'sell' ? q - tx : -q - tx;
        if (m.mode === 'J') STATS.jPnlSol += delta;
        else STATS.dPnlSol += delta;
        if (f.side === 'sell' && !state.positions.has(f.mint)) {
          if (m.mode === 'J') STATS.jTripsClosed += 1;
          else STATS.dTripsClosed += 1;
        }
      }
      if (f.status === 'rejected' || f.status === 'failed') {
        if (f.side === 'sell') {
          const m = metas.get(f.mint);
          if (m) m.exiting = false;
        } else {
          const c = coins.get(f.mint);
          if (c) c.cooldownUntil = slot + 50;
        }
      }
    }

    // --- 3. dekat akhir jam? (mark akhir jam = batas Sharpe) ---
    let nearHourEnd = false;
    if (firstBt !== null) {
      let lastBt: number | null = null;
      for (let i = batch.events.length - 1; i >= 0; i--) {
        const bt = batch.events[i].block_time;
        if (bt !== null && bt !== undefined) {
          lastBt = bt;
          break;
        }
      }
      if (lastBt !== null) {
        const intoHour = (lastBt - firstBt) % 3600;
        nearHourEnd = intoHour >= 3600 - p.hourLockLastSec;
      }
    }

    // --- 4. pending sell/buy per mint ---
    const pendingBuy = new Set<string>();
    const pendingSellTokens = new Map<string, bigint>();
    for (const po of state.pending.values()) {
      if (po.order.side === 'buy') pendingBuy.add(po.order.mint);
      else {
        pendingSellTokens.set(
          po.order.mint,
          (pendingSellTokens.get(po.order.mint) ?? 0n) + BigInt(po.order.token_amount),
        );
      }
    }

    // --- 5. kelola posisi terbuka ---
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (!curve) continue;
      const meta = metas.get(mint);
      if (!meta) continue;
      const tokens = pos.token_amount;
      const cost = pos.cost_lamports;
      if (tokens === 0n || cost === 0n) continue;
      const coinTrack = coins.get(mint);
      if (coinTrack) meta.lastTradeSlot = coinTrack.lastTradeSlot;
      if (meta.exiting) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const value = (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
      const mult = Number(value) / Number(cost);
      if (mult > meta.peakMult) meta.peakMult = mult;
      if (curve.real_quote_reserves > meta.peakReserves) meta.peakReserves = curve.real_quote_reserves;
      const pendingSell = pendingSellTokens.get(mint) ?? 0n;
      const freeTokens = tokens - pendingSell;
      if (freeTokens <= 0n) continue;

      const isJ = meta.mode === 'J';
      const stopMult = isJ ? p.jStopMult : p.dStopMult;
      const maxHold = isJ ? p.jMaxHoldSlots : p.dMaxHoldSlots;
      const stale = isJ ? p.jStaleSlots : p.dStaleSlots;
      const tp1Mult = isJ ? p.jTp1Mult : p.dTp1Mult;
      const tp1Frac = isJ ? p.jTp1Frac : p.dTp1Frac;
      const tp2Mult = isJ ? p.jTp2Mult : p.dTp2Mult;
      const tp2Frac = isJ ? p.jTp2Frac : p.dTp2Frac;
      const hourLockMult = isJ ? p.jHourLockMult : p.dHourLockMult;
      const hourLockFrac = isJ ? p.jHourLockFrac : p.dHourLockFrac;

      const sellAll = (): void => {
        orders.push({ side: 'sell', mint, token_amount: freeTokens, max_slippage_bps: p.sellSlippageBps });
        pendingSellTokens.set(mint, (pendingSellTokens.get(mint) ?? 0n) + freeTokens);
        meta.exiting = true;
      };
      const sellFrac = (fracBps: number): void => {
        const amt = (freeTokens * BigInt(fracBps)) / 10000n;
        if (amt <= 0n) return;
        const proceeds = (value * BigInt(fracBps)) / 10000n;
        if (proceeds < BigInt(Math.round(p.minSellProceedsSol * 1e9))) return;
        orders.push({ side: 'sell', mint, token_amount: amt, max_slippage_bps: p.sellSlippageBps });
        pendingSellTokens.set(mint, (pendingSellTokens.get(mint) ?? 0n) + amt);
        if (fracBps >= 10000) meta.exiting = true;
      };

      let soldThisBatch = false;
      if (mult <= stopMult) {
        sellAll();
        soldThisBatch = true;
      } else if (
        meta.peakReserves > 0n &&
        curve.real_quote_reserves < (meta.peakReserves * BigInt(Math.round((isJ ? p.jCollapseFrac : 0.4) * 10000))) / 10000n
      ) {
        sellAll();
        soldThisBatch = true;
      } else if (slot - meta.entrySlot >= maxHold || slot - meta.lastTradeSlot >= stale) {
        sellAll();
        soldThisBatch = true;
      } else if (isJ && meta.peakMult >= p.jTrailArm && mult <= meta.peakMult * (1 - p.jTrailGiveback)) {
        sellAll();
        soldThisBatch = true;
      }
      if (soldThisBatch) continue;
      if (!meta.tp1Done && mult >= tp1Mult) {
        sellFrac(Math.round(tp1Frac * 10000));
        meta.tp1Done = true;
        soldThisBatch = true;
      } else if (!meta.tp2Done && mult >= tp2Mult) {
        sellFrac(Math.round(tp2Frac * 10000));
        meta.tp2Done = true;
        soldThisBatch = true;
      }
      if (!soldThisBatch && nearHourEnd && mult >= hourLockMult) {
        sellFrac(Math.round(hourLockFrac * 10000));
        soldThisBatch = true;
      }
      // adds mode J saja, hanya ke kekuatan, tanpa sell di batch yang sama
      if (!soldThisBatch && isJ && meta.adds < p.jMaxAdds && price > meta.lastBuyPrice * (1 + p.jAddMinGain)) {
        let addLamports = BigInt(Math.round(p.jAddSol * 1e9));
        const maxBuy = state.maxBuyLamports(mint);
        if (maxBuy > 0n && addLamports > (maxBuy * 95n) / 100n) addLamports = (maxBuy * 95n) / 100n;
        const totalCost = cost + addLamports;
        const capCost = BigInt(Math.round(p.jCapSol * 1e9));
        if (totalCost <= capCost && state.freeCashLamports() >= addLamports + txFee && !pendingBuy.has(mint)) {
          orders.push({ side: 'buy', mint, quote_lamports: addLamports, max_slippage_bps: p.buySlippageBps });
          pendingBuy.add(mint);
          meta.adds += 1;
          meta.lastBuyPrice = price;
        }
      }
    }

    // --- 6. bersihkan meta posisi yang sudah tertutup ---
    for (const mint of [...metas.keys()]) {
      if (!state.positions.has(mint) && !pendingBuy.has(mint) && !pendingSellTokens.has(mint)) {
        metas.delete(mint);
        const c = coins.get(mint);
        if (c) c.cooldownUntil = slot + p.reentryCooldownSlots;
      }
    }

    // --- 7. entry baru: judgement dulu (umur 45/60), lalu dip ---
    let newEntries = 0;
    let openCount = state.committedPositionCount();
    let cashLeft = state.freeCashLamports();
    for (const c of coins.values()) {
      STATS.loopIters += 1;
      if (newEntries >= p.maxNewPerBatch) break;
      if (c.complete) continue;
      if (state.positions.has(c.mint) || pendingBuy.has(c.mint)) continue;
      if (slot < c.cooldownUntil) continue;
      if (openCount >= p.maxOpen) break;
      const age = slot - c.createdSlot;
      if (age < 5) continue;
      const curve = state.curves.get(c.mint);
      if (!curve) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0 || c.createPrice <= 0) continue;

      // (a) judgement one-shot: evaluasi saat umur mencapai judgeAge, second look
      //     di secondLookAge. Setelah itu judgedPass menetap (entry J s.d. umur 150).
      if (age >= p.judgeAge && !c.judged) {
        c.judged = true;
        STATS.judgedEval += 1;
        c.judgedPass = judgedPassNow(state, c);
        if (c.judgedPass) STATS.judgedPass += 1;
      }
      if (age >= p.secondLookAge && c.judged && !c.judgedPass && !c.secondLookDone) {
        c.secondLookDone = true;
        c.judgedPass = judgedPassNow(state, c);
        if (c.judgedPass) STATS.judgedPass += 1;
      }

      let mode: 'J' | 'D' | null = null;
      let stakeSol = p.firstStakeSol;
      // mode J: lolos judgement, umur <= 600, gates lolos
      if (c.judgedPass && age <= p.judgedEntryMaxAge && gatesPass(c)) {
        mode = 'J';
        stakeSol = p.firstStakeSol;
      }
      // mode D: dip >=20% lalu bounce >=10% dalam 120 slot, umur >=45, buyer >=10
      // (dinonaktifkan: dipMinBuyers 999 — ablated, kalah di semua sweep)
      if (
        mode === null &&
        age >= p.dipMinAge &&
        age <= p.dipMaxAge &&
        c.peakPrice > 0 &&
        c.dipLow <= c.peakPrice * (1 - p.dipPct) &&
        price >= c.dipLow * (1 + p.bouncePct) &&
        slot - c.dipLowSlot <= p.dipBounceWindowSlots &&
        gatesPass(c)
      ) {
        STATS.dipCandidate += 1;
        if (c.buyers.size < p.dipMinBuyers) {
          STATS.dipBuyersFail += 1;
        } else {
          STATS.dipPass += 1;
          mode = 'D';
          stakeSol = p.dipStakeSol;
        }
      }
      if (mode === null) continue;

      const stake = BigInt(Math.round(stakeSol * 1e9));
      if (cashLeft < stake + txFee) break;
      const maxBuy = state.maxBuyLamports(c.mint);
      let sized = stake;
      if (maxBuy > 0n && sized > (maxBuy * 95n) / 100n) sized = (maxBuy * 95n) / 100n;
      if (sized < BigInt(Math.round(0.002 * 1e9))) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: sized, max_slippage_bps: p.buySlippageBps });
      pendingBuy.add(c.mint);
      openCount += 1;
      cashLeft -= sized + txFee;
      if (mode === 'J') STATS.jEntries += 1;
      else STATS.dEntries += 1;
      metas.set(c.mint, {
        mode,
        entrySlot: slot,
        peakMult: 1,
        tp1Done: false,
        tp2Done: false,
        adds: 0,
        lastBuyPrice: price,
        peakReserves: curve.real_quote_reserves,
        lastTradeSlot: slot,
        exiting: false,
      });
      newEntries += 1;
    }

    return orders;
  }

  return { onBatch };
}
