# Exilence CE issue #7 fix

This branch carries a PR-ready patch for `exilence-ce/exilence-ce` issue [#7](https://github.com/exilence-ce/exilence-ce/issues/7) (`Global ratelimiting instance`).

## Why this bug

The current startup flow fetches Poe Ninja prices for every discovered price league during session initialization. Accounts with many stale/private leagues can fan out into repeated price requests and get trapped in startup `429` failures.

## What the patch changes

- stop bulk-fetching prices for every league at startup
- fetch prices only for the active price league during session init
- fetch prices lazily when the user opens or switches the price-table league
- keep the price-table selection synced to `activePriceLeague` rather than `activeLeague`

## Files changed in the target repo

- `src/store/accountStore.ts`
- `src/store/priceStore.ts`
- `src/store/domains/profile.ts`
- `src/components/price-table/price-table-league-dropdown/PriceTableLeagueDropdownContainer.tsx`

## Review artifact

See [`startup-price-fetch.patch`](./startup-price-fetch.patch) for the unified diff.
