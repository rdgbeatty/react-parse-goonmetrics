# Market data backend scaffold

Node 18+ and native browser modules. No package installation is needed. The backend is a reusable local collector, catalog updater and snapshot publisher; the included browser is still a test harness. The original Deno/React app remains separate.

## Active hubs and the retired Siseide market

Live collection now defaults to **Jita and C-J6MT**. Tortuga/Siseide is disabled even when its old structure ID remains saved. The setup checkbox can explicitly enable that legacy entry, but a destroyed/inaccessible optional structure returning 403/404 is omitted with a diagnostic instead of blocking the required hubs. A C-J6MT or authentication failure retains the last valid snapshot.

The table and progress controls use the snapshot’s actual hub list. Add a future hub through the `additionalHubs` configuration described in [the deployment/dormancy briefing](../../docs/discovery/10-jita-cj-deployment-and-dormancy.md); its name/structure ID and optional expected system are enough for collection and routing. Existing three-hub snapshots and retained history remain readable.

The old Pages workflow is now **manual-only and still targets the legacy scraper frontend**. Replacement Actions and protected remote grant storage are planned in the briefing; a source push does not deploy this scaffold.

## Run locally

From the repository root:

```text
npm run backend:catalog
npm run backend
```

Open **http://localhost:4173**. Stop with **Ctrl+C**. Build the catalog once before collecting live data; rerun the catalog command whenever desired. Starting the server does not download the SDE or call EVE. The first start creates a labeled 60,000-row synthetic snapshot only when no snapshot exists.

Existing `poc`, `poc:collect`, `poc:export`, `poc:static` and `poc:test` commands remain aliases. The equivalent direct server command is `node apps/market-backend/start.mjs`.

## Catalog update pipeline

```text
Check CCP's latest SDE build
  → compare installed build
  → unchanged: verify local catalog and stop
  → changed: fetch only types.jsonl from the versioned ZIP
  → stream/decompress, check size and CRC32, normalize and validate
  → write catalog data addressed by SHA-256
  → atomically replace the small current.json manifest
```

```text
npm run backend:catalog
npm run backend:catalog:check
npm run backend:catalog -- --force
npm run backend:catalog -- --json
```

The default command updates if necessary; `--check` compares versions without downloading the archive member. `--force` rebuilds or repairs local catalog files. `--json` suppresses progress and prints machine-readable results. `--state-dir=/absolute/path` selects another state folder. A future daily or manually dispatched GitHub Action can call this same command; no Action is created yet.

Version checks use CCP's build identifier, rather than a presumed patch cadence. If a new build produces identical selected fields, the content hash is unchanged and the catalog data file is reused; only source-version metadata advances. Failures leave the active manifest pointing to the last valid catalog. Old content files remain available for recovery. Automatic retention/garbage collection of those files is deferred.

The importer uses Node's stream, zlib and crypto modules; no Python, unzip executable or npm package is required. It deliberately supports the current single-disk, stored/deflated ZIP format with HTTP byte ranges. Unsupported ZIP64, encrypted, oversized or inconsistent archives fail explicitly. It never extracts arbitrary archive paths. CCP's reserved type-zero record is excluded; unpublished internal positive IDs remain in the catalog, including legitimate group-zero records. Ordinary and packaged volumes remain distinct.

Validated real run: SDE build **3670638**, released **2026-11-04**, **53,305 types**, **7,609,392 catalog bytes**, **23,656,851 transferred archive bytes** versus a **99,305,880-byte archive**. The next update command returned `up_to_date` without downloading the member. This is a catalog test, not a fresh authorized market-collection benchmark.

## Connect and collect

1. Register `http://localhost:4173/auth/eve/callback` in the EVE developer application, or the exact callback printed for an alternate port. Enable `esi-markets.structure_markets.v1` and `esi-universe.read_structures.v1`.
2. Start the backend, open **Setup & diagnostics**, and expand **Local setup & collection** if needed. Save the client ID, structure IDs and application maintainer's ESI contact. Local login uses **PKCE/S256 and does not send an application secret**. The optional legacy secret field is retained for older grants.
3. Click **Connect EVE** and select the character that can access the enabled structures. Callback state is one-use and bound to a local HttpOnly cookie. Refresh grants stay in local private state.
4. Set **Live tracked types** to **0** for every type quoted at any enabled location, or 1–200 for a small sample. New configurations default to all types. Existing saved settings are retained, so change an old 50-type sample to 0 explicitly. History now covers every tracked region/type pair; the former 0–25 history sample setting is retired. History batches now allow up to 1,000 requests with a 300-second safety cap; the local UI continues automatically until the pass completes or is paused.
5. Click **Collect live markets**. Structure systems must resolve to Siseide and C-J6MT. All required order pages must succeed before fresh quotes publish, using any retained history summaries. A resumable history batch then runs and republishes the snapshot with updated demand. Names and volumes come only from the local catalog; a missing ID requests a catalog update instead of issuing per-type ESI calls.

The collector now overlaps all enabled books, with **three ESI HTTP operations maximum overall** and **two pages per hub maximum**. The limits share one request queue, including response parsing/cache writes. First-page discovery, retries, cache expiry, error budgets and rate-limit checks remain in force. Collection failures stop queued network work; workers drain before locks release. Deterministic output order is preserved despite responses completing out of order. This is bounded concurrency, not a guaranteed requests-per-second allowance.

Raw orders are used only in job memory for deduplication and reduction. The persistent book cache contains best prices, stock and 24-hour ask-activity aggregates, never individual order IDs, timestamps or price levels. Complete aggregate books are reused until their earliest ESI page expiry; their competition-window timestamp stays unchanged when reused. `npm run backend:cache:prune-orders` removes the earlier proof's raw order-page cache without touching history, aggregates, catalog or grants.

Each quote can expose `askOrders`, `recentAskOrders24h`, `recentAskUnits24h`, `recentAskOriginalUnits24h` and `unknownIssuedAskOrders`. Recency uses the literal ESI `issued` field. It is a competition proxy, not a distinct-seller count or verified imports; the exact last-reprice interpretation needs owner validation. Missing/future timestamps leave recent figures unknown. Derived `estimatedWeekProfit` uses destination ask after sale expenses, source ask, shipping and a labeled regional weekly-volume reference. The viewer defaults to sorting estimated net weekly profit, and includes the original table’s filler score and price-per-m³ calculations.

The two progress bars show completed hubs and aggregate pages, with individual hub page counts. They switch to local catalog lookup, retained-history coverage and publication afterward. Local status polling every two seconds makes no EVE calls and resumes after browser reload. A static export has no collection polling.

On **Browse data**, the table is primary. Route assumptions default to collapsed, Jita → C-J6MT, buying from sell orders and listing sell orders. The market-age panel is also collapsed, opening when quote data reaches eight hours old. Each hub shows its oldest page's market timestamp and a live age. Last-Modified is preferred; Date/Age and receipt time are fallbacks. Cached bodies and 304 responses keep their data age. File-generation time is separate. Existing quote-age colors are unchanged; future history-warning UX is deferred.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run backend` | Start local setup and viewer. |
| `npm run backend -- --port=4174` | Alternate port; EVE callback registration must match. |
| `npm run backend:catalog` | Update the local SDE catalog if needed. |
| `npm run backend:catalog:check` | Compare available and installed SDE versions. |
| `npm run backend:collect` | Collect once using saved configuration and grant. |
| `npm run backend:quotes` | Refresh quotes using saved history, without starting a history batch. |
| `npm run backend:history` | Refresh a resumable history batch using the current live snapshot, without SSO. |
| `npm run backend:history -- --seconds=300 --pairs=1000` | One batch with optional caps; zero disables that cap. |
| `npm run backend:history -- --all` | Automatically continue through bounded batches. |
| `npm run backend:history -- --resume` | Resume a saved paused/interrupted pass. |
| `npm run backend:history:verify` | Verify retained history and repair derived serving summaries locally, without ESI. |
| `npm run backend:benchmark:history` | Benchmark the actual history lifecycle with replayed ESI transport; defaults to 20,000 types × 3 regions, three repetitions. |
| `npm run backend:export` | Assemble only public viewer assets and market.json. |
| `npm run backend:static` | Export and preview without collector/auth endpoints. |
| `npm run backend:test` | Test catalog, collection, auth, concurrency and history-model helpers. |
| `npm run backend:benchmark:smoke` | Check equality across storage/processing candidates using a small workload. Requires the existing Linux benchmark tools. |
| `npm run backend:benchmark` | Run full storage pipeline benchmarks; see the benchmark guide for parameters. |
| `npm run backend:cache:prune-orders` | Remove legacy raw order caches; retain aggregate/current publication state. |

## State and publication

Fresh checkouts use ignored **`.market-backend/`**. When **`.market-poc/`** already exists, the scaffold continues using it so the connected character and snapshot remain usable. The CLI prints the state directory; credentials are not moved or copied.

| State path | Purpose |
| --- | --- |
| `private/config.json` | Local application configuration. |
| `private/grant.json` | Current refresh grant and verified character metadata. |
| `catalog/current.json` | Active SDE build, provenance, count and content-file reference. |
| `catalog/types-<sha256>.json` | Validated compact catalog, keyed by type ID. |
| `cache/` | Rebuildable universe metadata responses. Recognized legacy public history bodies migrate into retained history. |
| `history/regions/<region>/<shard>.json` | Checksummed compact daily records, up to 21 calendar days per type; 32 shards per region. |
| `history/checkpoints/<sequence>.json` | Atomic patches containing only changed records; replayed after an interrupted batch and folded into shards at completion. |
| `history/summaries/<region>.json` | Derived 7/14-day totals and per-type provenance; frequent quote jobs read these files only. |
| `metrics/runs/<run-id>.json` | Safe local progress and completed-run reports with wall/CPU/memory, requests and history reconciliation counts. |
| `cache/books/` | Latest aggregate book per hub/character/endpoint, with expiry/provenance and competition figures. |
| `public/data/market.json` | Current validated viewer snapshot. |
| `site/` | Explicit public-only export. |

Private state is not encrypted at rest. POSIX mode 0600 is requested for files; Windows ACLs and mount behavior determine effective protection. The server binds to loopback, serves an explicit asset allowlist and requires same-origin/CSRF checks for mutations. Refresh replacements are persisted before subsequent validation or collection can fail. Disconnect removes the local grant; upstream revocation remains an EVE account operation.

Export includes only `index.html`, `app.mjs`, `snapshot.mjs`, `styles.css` and `data/market.json`. It excludes configuration, grants, raw ESI caches and the entire SDE catalog. No upload, workflow modification, commit or push is performed.

## Daily history workflow

**Collect live markets** saves current prices first and then runs a history batch. **Refresh prices only** (`npm run backend:quotes`) publishes quotes with saved summaries and stops. **Update / verify history** runs only the history step: no character login or private-market query is needed, because regional history is public. **Verify stored history** checks local shards, dates and checksums and rebuilds damaged/missing derived summaries; it does not call ESI or alter source records to conceal corruption.

The first backfill may require many batches. Item-specific 404s defer history for 24 hours and do not abort other items; the deferred-items table shows first-failure age, latest attempt, retry time and failure count. Each batch processes up to 1,000 region/item pairs and 1,000 outbound requests (retries count), with a five-minute safety cap and at most three requests in flight. Never-fetched pairs come first, then expired entries with the oldest successful checks; tied work rotates regions. Fresh ESI-expiry records are skipped and expired records use conditional headers. It checkpoints changed records every 500 attempts or about ten seconds, then folds those patches into the source shards once at completion. Ctrl+C drains/cancels in-flight history and checkpoints completed records; an abrupt kill can lose work since the last checkpoint. Budgeting covers collection; final checkpoints and publication can take additional time.

Run again the same day to continue unfinished backfill without re-fetching fresh pairs. Run after the next daily ESI update to add new days, verify overlapping days and replace corrections. ESI returns its available history in one response, without a date-range selector; only 21 completed calendar days are retained. Volume, order count, average, highest and lowest price survive locally. No raw order book or full multi-year history body is stored.

Coverage uses the source update date and returned completed dates. A UTC midnight before CCP’s next daily update does not falsely advance the reporting window. Missing daily records remain unknown rather than assumed zero. Seven-day totals require seven actual records; fourteen-day mode requires fourteen and divides the total by two for weekly comparisons. History check time, source update, coverage-through date and last actual record are tracked separately. History warnings remain a later UX decision.

On **Setup & diagnostics**, run reports show inserted/corrected/unchanged/pruned days, checked/fresh/failed/pending pairs, response bytes, retry/status counts, wall time, process CPU and peak RSS. Click a report for its full metrics or download the latest 20. Full individual reports remain in ignored local state, across restarts; automatic pruning is deferred. Reports contain no grants, application secrets or raw ESI bodies. Status polling itself makes no EVE requests. Keep the reports from today and tomorrow to compare actual ingestion and upserts.

The library entrypoint is `lib/history-refresh.mjs`; `history.mjs`, the local buttons and `start.mjs --collect` share the same job/store code. A future GitHub Action can call these commands after restoring durable state. No Actions, commit, push or deployment is added here.

See [the live pull diagnosis and deferral fix](../../docs/discovery/09-history-pull-diagnosis.md), [the lifecycle measurements and decisions](../../docs/discovery/08-history-lifecycle.md), [the data model review](../../docs/discovery/06-backend-data-model.md), [the earlier storage comparison](../../docs/discovery/07-storage-performance.md), and [the project checklist](../../TODO.md).

## GitHub-only sign-in feasibility test

Run `npm run backend:github-check` and open http://localhost:4173. Stop the normal backend first if it uses that port. This separate static-only page tests browser access to EVE/GitHub and can optionally perform browser PKCE sign-in using your public EVE client ID and existing registered local callback. No packages, application secret or GitHub token are needed for these tests. The successful test grant is held in browser memory only, never displayed or saved to the working backend.

Use `npm run backend:github-check -- --port=4177` for credential-free checks on another port; real sign-in needs an exactly registered callback. Ctrl+C stops the spike. Restart the ordinary collector with `npm run backend`. The [feasibility report](../../docs/discovery/11-github-only-auth-feasibility.md) distinguishes the verified browser access, optional live sign-in, and proposed Secret/workflow integration. Nothing in this command writes GitHub Secrets or publishes files.

## Combined release and hosted collector

The release now uses the approved `libsodium-wrappers@0.8.4` dependency plus existing frontend workspace packages. Run `npm ci` before combined builds or the expanded backend tests. The standalone local collector itself still runs without frontend dependencies. `npm start` builds/previews both sites, while `npm run backend` runs the local collector.

The original React app stays at the root with its live Deno scraper. The new viewer and encrypted owner setup live under `market/`; their CSS remains isolated. Manual GitHub workflows call `hosted.mjs` for adoption, durable replacement-grant writes, bounded history work and Release-state checkpoints. See the [operations guide](../../docs/deployment.md) and [release decisions](../../docs/discovery/12-combined-release.md). Actual hosted integration remains to be run after owner local acceptance and credential setup.
