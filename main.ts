// main.ts — Pump.fun Sharpe Sprint REBUILD #2: entrypoint. Menjalankan strategi
// judged-momentum + hour-lock (strategy.ts) lewat shim kit vendor/makefun-bot.ts.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
