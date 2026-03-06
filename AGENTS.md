# Repository Guide

## Overview

This repo is a small monorepo for scraping and viewing import-market data.

- `apps/api` is a Deno 2 API using Hono.
- `apps/web` is a Vite + React + TypeScript frontend.
- `packages/shared` contains shared TypeScript types used by both apps.

The current main user flow is the table page in the web app, which fetches parsed rows from the API and computes additional display-only metrics in the browser.

## Workspace Layout

- `apps/api/src/server.ts`: API entrypoint, route registration, dependency wiring.
- `apps/api/src/routes`: HTTP route handlers.
- `apps/api/src/services`: scraping logic and cache behavior.
- `apps/api/src/repositories`: in-memory repository abstractions for scraped rows.
- `apps/api/prisma`: placeholder only; there is no active database integration yet.
- `apps/web/src/main.tsx`: React bootstrapping and router setup.
- `apps/web/src/pages`: page-level UI.
- `apps/web/src/components`: reusable UI controls.
- `packages/shared/src/importRow.ts`: shared `ImportRow` and `OrderType` definitions.

## Run Commands

Use these from the repo root unless noted otherwise.

- Install frontend and workspace deps: `pnpm install`
- Start the API: `deno task dev --cwd apps/api`
- Start the web app: `pnpm --filter @gm/web dev`
- Build the web app: `pnpm --filter @gm/web build`
- Preview the built web app: `pnpm --filter @gm/web preview`
- Type-check API sources: `deno task check --cwd apps/api`
- Lint API sources: `deno task lint --cwd apps/api`

The API defaults to `http://localhost:4000`.
The web app defaults to `http://localhost:5173`.
The frontend can override the API origin with `VITE_API_BASE_URL`.

## Architecture Notes

- The API is currently stateless except for in-memory scraper caches.
- `Top500ScraperService` and `MarketGroupScraperService` both inherit from `BaseScraperService`.
- Scraped data is cached per order type in memory only; restarting the API clears everything.
- `Top500ScraperService` uses a 5-minute cache TTL.
- `MarketGroupScraperService` uses a 1-hour cache TTL.
- `MarketGroupScraperService` ignores the upstream "Wk Total" column and sets `weekMarkupISK` to `0`.
- The frontend computes derived profitability and filler-score values locally in `apps/web/src/pages/TableData.tsx`.

## External Site Format

The API scrapes HTML from `https://goonmetrics.apps.goonswarm.org`. The scraper code does not use a stable JSON API; it depends on specific page shapes and URL conventions.

### Top 500 pages

- Sell URL: `https://goonmetrics.apps.goonswarm.org/importing/1049588174021/topmarkup/`
- Buy URL: `https://goonmetrics.apps.goonswarm.org/importing/1049588174021/topmarkup/?from=buy`
- The scraper reads the first `<table>` on the page.
- It skips the first `<tr>` as a header row.
- For each remaining row, it reads `<td>` cells by position.

Expected column order:

- `0`: item name
- `1`: weekly volume
- `2`: Jita price
- `3`: import price
- `4`: C-J6MT price
- `5`: markup percent
- `6`: weekly markup ISK

Parsing assumptions:

- Numeric cells may include commas and `%`; the scraper strips both before calling `Number(...)`.
- Missing or unparsable numeric values become `0`.
- Row IDs are generated locally and are not derived from the upstream HTML.

### Market group index page

- Index URL: `https://goonmetrics.apps.goonswarm.org/importing/1049588174021/marketgroup`
- The scraper scans all `<a>` tags on the page.
- It keeps only links whose `href` matches `/importing/1049588174021/marketgroup/<digits>/` with an optional trailing slash.
- Those matching links are treated as subpages to scrape.

If the index page stops linking to category pages with that pattern, `MarketGroupScraperService` will discover fewer pages or none at all.

### Market group subpages

- Sell URLs are built from the discovered subpage paths.
- Buy URLs append `?from=buy`.
- Each subpage is parsed by reading the first `<table>`, skipping the first `<tr>`, and mapping `<td>` cells by position.

Expected column order:

- `0`: item name
- `1`: weekly volume
- `2`: CJ stock count, ignored
- `3`: CJ stock percent, ignored
- `4`: Jita price
- `5`: import price
- `6`: C-J6MT price
- `7`: markup percent
- `8`: weekly total, intentionally ignored

Parsing assumptions:

- Duplicate item names across market-group pages are deduplicated in memory; the first seen row wins.
- `weekMarkupISK` is set to `0` for this source because the upstream weekly total column is not used.
- As with Top 500, numeric parsing strips commas and percent signs and falls back to `0`.

### What to check if the scraper breaks

- Whether the relevant data is still in the first table on the page.
- Whether the header row count changed.
- Whether column order changed.
- Whether market-group links still match the numeric-path pattern.
- Whether the buy view still uses `?from=buy`.
- Whether numeric formatting now includes new non-numeric characters the parser does not strip.

## Conventions

- Prefer editing shared contracts in `packages/shared` first when API and web need to agree on data shape.
- Keep route handlers thin; put scraping and parsing behavior in services.
- Preserve the current TypeScript import style, including explicit `.ts` extensions where already used.
- The API code mixes aliases: `@sharedTypes/` is defined in `apps/api/deno.json`, while some files also import from `@gm/shared`. Check existing imports in the file you touch and keep them consistent unless you are intentionally standardizing them.
- The web app uses hash routing via `createHashRouter`.
- Styling is plain CSS colocated with components/pages rather than CSS-in-JS.

## Current State And Caveats

- `apps/api/src/routes/items.ts` and `apps/api/src/routes/ingest.ts` are stubs.
- `apps/api/prisma` is not wired into runtime behavior.
- The repo may contain in-progress scraper changes; do not assume the API worktree is clean.
- `TableData.tsx` contains substantial calculation and sorting logic in one file. Small targeted edits are safer than broad refactors unless explicitly requested.
- External scraper behavior depends on third-party HTML pages at `goonmetrics.apps.goonswarm.org`; upstream markup changes can break parsing.

## When Making Changes

- If a change affects scraped row fields, update both the API parser output and the shared types.
- If a change affects table behavior, verify both data sources: `top500` and `marketgroup`.
- Prefer adding logic to the scraper services or shared types instead of duplicating transformation logic across routes.
- Keep new setup instructions accurate for Windows-friendly local development, since this repo appears to be used that way today.
