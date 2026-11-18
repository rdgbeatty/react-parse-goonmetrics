# Persistent history lifecycle and table-first backend lab

The storage decision is implemented with dependency-free JavaScript and JSON. The local collector, CLI and browser controls share the same persistent history refresh code. GitHub Actions and publication remain deferred.

Subsequent live testing exposed an item-specific 404 retry trap. The [live diagnosis and batching update](09-history-pull-diagnosis.md) records the fix: automatic 1,000-request batches, pause/resume and visible 24-hour deferrals. Its behavior supersedes the earlier manual five-minute continuation described below.

## What runs

```text
Collect live markets
  → refresh character grant and collect all three order books
  → reduce to best prices, stock and issued-ask activity; discard raw orders
  → join names/packaged volumes from the local SDE
  → attach previous dated history summaries and publish fresh quotes
  → run a bounded public regional-history batch
  → checkpoint retained daily records
  → derive summaries and atomically publish the updated public snapshot
```

**Refresh prices only** / `npm run backend:quotes` stops after publishing quotes with saved history. The history-only button and CLI start at the history step. They read the current live snapshot to determine tracked region/type pairs, without refreshing SSO. Pairs are deduplicated when hubs share a region. New pairs are prioritized, rotating regions; expired pairs then run in oldest-check order. Fresh entries are skipped under their individual source expiry. Failed entries retain old data and receive a retry timestamp.

Default collection budget is **300 seconds**, with three requests in flight. A request cannot outlive the remaining budget or its 25-second timeout. Completed work checkpoints after 500 attempts or about ten seconds, and at batch end. Checkpoint/summary/publication work can extend total wall time beyond five minutes. The UI displays pending work; click again to resume. Ctrl+C cancels/drains history requests and saves completed work. An abrupt process kill can lose the most recent uncheckpointed group.

Source errors are isolated from fresh quote publication. A rate-limit signal stops the batch; repeated source failures also pause it. Successful pairs survive other pair failures. The last successful history stays dated rather than being relabeled as new. Read-only static exports contain no local collection endpoints.

## Retained representation

| Layer | Path in ignored local state | Contents |
| --- | --- | --- |
| Retained source facts | `history/regions/<region>/<00..31>.json` | Per-type metadata and up to 21 compact daily rows. |
| Durable incremental checkpoints | `history/checkpoints/<sequence>.json` | Checksummed patches of changed records, replayed on recovery and compacted into shards at batch end. |
| Derived serving cache | `history/summaries/<region>.json` | Seven-/fourteen-day totals, missing-day counts and provenance. |
| Current viewer generation | `public/data/market.json` | Catalog fields, current quote/stock/competition aggregates and history summaries; no daily arrays. |
| Run evidence | `metrics/runs/<id>.json` | Safe progress and completed wall/CPU/memory/request/reconciliation metrics. |

Each region has 32 deterministic shards (`typeId % 32`). Envelopes identify schema version, region, shard, 21-day retention, ordered columns and SHA-256 of the records. Daily rows are JSON arrays with explicitly declared columns:

```text
[UTC epoch day, volume, order count, average price, highest price, lowest price]
```

Each type separately records `checkedAt`, `sourceUpdatedAt`, `asOfDate`, expiry, ETag, last attempt, retry time and safe failure category. `lastRecordDate` is derived from retained rows. This is compact JSON with ordinary numeric values; no binary format, native extension or database is needed. Files are written via a synced temporary file and atomic rename, under the shared local operation lock.

The source state and serving summaries are separate. Quote jobs need only the smaller summaries. Incremental changed-record patches checkpoint before the shards are compacted once at batch end; new summaries publish after compaction. Ordered checkpoint replay recovers interrupted batches or compaction, and oldest-first removal of applied patches prevents an interruption from rolling values backwards. A crash can leave newer retained facts behind an older serving file; **Verify stored history** checks checksums and reconstructs the derived summaries. It does not invent repairs for corrupt source shards: restore the affected shard from backup or remove that specific rebuildable shard and backfill it. Keep the last public snapshot while repairing.

Recognized public history response files from the earlier local proof are imported once. Their original expiry is respected and the old full body is removed only after retained records checkpoint. Invalid legacy cache files do not block a clean fetch. New history requests never persist the full available response.

## Daily reconciliation and coverage

The current history endpoint accepts a region and type, without a start/end-day filter. The refresher reads the full response, verifies daily values/dates/uniqueness, upserts retained overlapping dates, catches up intervening days and prunes beyond the latest 21 completed reporting dates. Responses which move coverage backwards cannot replace successful data. A conditional 304 verifies the existing retained rows without needing the discarded response body. See the [official ESI schema](https://esi.evetech.net/meta/openapi.json).

A real public response inspected during development was received on **2026-11-08 at 04:21 UTC**, with `Last-Modified` **2026-11-07 at 11:03 UTC**, expiry **2026-11-08 at 11:05 UTC**, and latest record **2026-11-06**. It contained 402 records. Thus UTC midnight alone cannot define the newest available reporting date. Coverage takes the latest completed returned date and the source update date minus one day, capped at yesterday UTC. The source timestamp is an inference about reporting coverage, recorded alongside the actual last record and its basis; it does not manufacture missing records.

The distinction matters:

- **Checked at:** when this application last successfully verified the response.
- **Source updated at:** ESI’s Last-Modified, when provided.
- **Coverage through:** the reporting window’s end date.
- **Last actual record:** the most recent supplied daily row.

Missing dates remain unknown until ESI’s no-trade-day semantics are established. An explicit zero-volume row is valid. Seven-day volume requires all seven daily rows; fourteen-day volume requires all fourteen. The viewer defaults to seven days; fourteen-day mode uses `volume14d / 2` so profit and hauling-volume estimates remain weekly. The retained data supports either window plus margin. No history-age warning policy is introduced.

## Logging and owner validation

The collection buttons save reports across server restarts and emit throttled console progress. The diagnostics page lists the latest 20 reports and lets the owner inspect or download them. Full individual files are retained; automatic report pruning is deferred.

Reports include wall time, user/system CPU, process-lifetime peak RSS, quote-network timings, decoded response bytes, retries/status counts, history target/fresh/refreshed/failed/pending pairs, source rows processed, retained bytes read/written, checkpoint and compacted-shard counts, and daily inserted/corrected/unchanged/verified/pruned counts. Error samples contain only region/type IDs, status and a safe category. Request timings sum operations and can overlap; they are not total wall time. Server CPU/RSS include other local work during a run and are not isolated subprocess measurements. Grants, secrets and raw source responses are excluded.

To validate with real data:

1. Restart with `npm run backend` and open **Setup & diagnostics**. Existing configuration, character grant and public snapshot remain in their existing ignored state directory.
2. Confirm tracked types is `0` for full coverage and batch time is `300` seconds.
3. Click **Collect live markets**. Fresh prices publish before the history batch finishes. Continue with **Update / verify history** until pending work falls to zero or the chosen stopping point.
4. Download reports. A same-day repeat should mostly skip unexpired pairs, while continuing any backfill.
5. Repeat after the next daily ESI update. Previously fetched pairs should show new inserted days, verified overlap, occasional corrections and trimming. During an unfinished full backfill, new pairs take priority, so some daily rechecks may need additional batches.
6. Click **Verify stored history** to check source integrity and serving equality without any ESI request.

A full real backfill was deliberately not launched during automated QA. Existing owner data is compatible and retained; browser and lifecycle tests use temporary state and replayed responses. Actual source/network timing will be captured by the owner’s collection reports today and tomorrow.

## Decisions for review

| Question | Decision | Alternative considered |
| --- | --- | --- |
| Whole store vs many files | 32 JSON shards per region, plus smaller serving summaries. | One large rewrite every checkpoint, or tens of thousands of tiny per-type files. |
| Frequent durable checkpoints | Save changed records as small JSON patches; compact source shards once per batch. The first full benchmark exposed write amplification from repeatedly rewriting whole shards. | Rewrite entire affected shards at every checkpoint, which made daily refresh CPU and I/O much larger. |
| Refresh granularity | Every tracked region/type; resumable five-minute batches, three requests at a time. | Retaining the old 25-type cap, or an unbounded UI request. |
| Daily source overlap | Verify all supplied dates in the retained window; keep full daily prices/order count. | Only append yesterday, which misses corrections; archive every available year. |
| Fresh quotes during slow history | Save quotes first with previous summaries, then republish after history. | Block new prices until every region/type refresh succeeds. |
| Missing source dates | Preserve unknown; never silently synthesize zero volume. | Assume every omitted date means no trades. |
| Midnight boundary | Use source/returned completed coverage and track its basis. | Advance the window at browser/local midnight. |
| Fourteen-day option | Default seven days; optional fourteen days divided by two. | Show fourteen-day totals under weekly column headings. |
| Original Goonmetrics weekly profit | Replace with explicitly computed **Gross wk profit**: `(destination price − acquisition price) × weekly flow`, before haul/tax. | Fabricate a Goonmetrics figure without its original source, or discard the useful gross column. |
| Strategy wording | “Buy from sell orders → list sell orders” and “Buy from sell orders → sell to buy orders.” | Describe an immediate purchase as buying from buy orders. |
| Table and operational UI | Browse page focuses on the wider/taller table; setup/stats/logs have a separate hash page. Route and age controls collapse; old quotes open the age panel. | Keep the long setup dashboard above the table. |
| Filler score and competition | Preserve the original filler formula, leave unknown inputs blank, show issued-ask activity separately. Default sort is net weekly opportunity. | Introduce a new competition penalty or claim counts represent distinct sellers/imported quantity. |

## Validation and lifecycle measurements

**Validation passed:** all 55 Node tests and the installed-Chrome workflow, including the prices-only button and saved-quote progress labels. No package installation was needed.

The Node suite covers retention, corrected overlap, empty/missing dates, pre-update midnight, expiry/304, repeated/resumed batches, budgets/cancellation, source failures, cache migration, source checksums, summary repair, early quote publication, safe persistent reports and legacy trade mathematics. Installed Chrome checks the 60,000-row viewer, bounded 100-row DOM, search/sorting/navigation, defaults/collapse, mobile table containment, page/hub progress, two history batches, cache skips, local verification, reports, failure preservation and stale-panel expansion.

`npm run backend:benchmark:history` measures the actual refresher/store/publisher in fresh Node processes for 20,000 types × three regions. Each replayed ESI response has 402 daily records; only 21 persist. The cold, same-day warm, next-day correction and local-verification cases run three times. HTTP transport is synthetic, without internet latency; JSON response decoding/parsing, validation, upserts, atomic disk checkpoints, summary generation and snapshot publication are real. State footprint and gzip inspection happen outside the timed pipeline. This is a local WSL `/tmp` filesystem measurement, not a GitHub Actions measurement. Repeated input values compress unusually well, so gzip size is illustrative rather than a real-market forecast.

Measured medians across three repetitions (Node 18.19.1):

| Case | Wall | CPU | Peak RSS | History bytes read / written |
| --- | ---: | ---: | ---: | ---: |
| Cold backfill + publication | 39.86 s | 46.85 s | 384.3 MiB | 0.00 / 110.44 MB |
| Same-day fresh cache + publication | 3.17 s | 4.72 s | 383.3 MiB | 47.84 / 13.98 MB |
| Next-day upserts/corrections + publication | 49.32 s | 55.86 s | 419.2 MiB | 47.84 / 110.98 MB |
| Local retained-state verification | 2.51 s | 4.02 s | 309.4 MiB | 48.08 / 0.00 MB |

Cold ingestion inserted **1,260,000 daily rows**. The next-day case inserted **60,000**, corrected **60,000**, verified **1,200,000** overlapping rows and pruned **60,000** old days. Every output summary was checked against its expected total. Each cold/daily case decoded **2.17 GB** of replayed source JSON (24.12 million daily source records) without retaining those full bodies. The fresh-cache case skipped all **60,000** pairs and made **zero HTTP calls**.

Completed state comprised **100 files**: 96 source shards, three summaries and one public snapshot. It occupied **85.16 MB** after backfill and **85.52 MB** after the following day; the synthetic state compressed to about **2.13 MB** with per-file gzip. Repeated source values make that compression unusually favorable. The public snapshot is included in this footprint, while the table’s read/write counters count the history adapter only; snapshot reads/writes are included in pipeline time. Timing excludes child process startup, module import and final compression/footprint inspection.

The initial whole-shard checkpoint trial, before the patch-based improvement, took **127.42 s cold / 205.86 s next-day wall time** and **184.10 / 329.37 s CPU** in one complete repetition. This is a diagnostic observation, not a repeated statistical baseline. The final patch-based pipeline above was then measured three times. It writes about **111 MB of history state per full daily pass**, including incremental checkpoints, source compaction and summaries, rather than repeatedly rewriting the full region shards at every checkpoint.

[Full machine-readable measurements](benchmarks/history-lifecycle-20000.json). Network latency, live ESI throttling/cache behavior, Windows filesystem costs, Actions restoration/upload and scheduling are not included. The saved live reports are the source of real collection timings.

Reproduce a quick check without installing anything:

```text
npm run backend:benchmark:history -- --types=100 --repeats=1
npm run backend:test
npm run backend:history -- --seconds=300
npm run backend:history:verify
```

The remaining Actions persistence/grant handling, first real two-day observations, no-trade semantics, history-warning UX and production frontend decisions remain on [the project checklist](../../TODO.md).
