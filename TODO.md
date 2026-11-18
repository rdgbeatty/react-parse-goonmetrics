# Market backend and website TODOs

Both sites are now published. Manual collection credentials and first authenticated hosted ingestion remain to be verified; schedules stay off. See [the live release record](docs/discovery/13-first-publication.md).

## Combined release and GitHub implementation — 2026-11-18

- [x] Keep legacy root/hash URLs and live Deno API; add navigation to the independent modern `/market/` viewer and back.
- [x] Add npm single-command combined preview/build with isolated CSS, real Pages subpath and public export boundary.
- [x] Implement browser PKCE owner setup, LibSodium Secret encryption, scoped owner authorization and workflow dispatch.
- [x] Implement pending/idempotent adoption, environment Secret write-back, PAT/App writers and serialized manual workflows.
- [x] Implement checksummed allowlisted Release-state checkpoints, verified restore/upload and post-publication bounded retention.
- [x] Verify legacy library behavior, both live scrape sources/routes, modern routing/search/styles and synthetic browser authentication/encryption.
- [x] Measure real local state pack/restore; document architecture decisions and recovery.
- [x] Add a first-release seed command with non-network dry-run and refusal to overwrite existing hosted state.
- [x] Owner accepted the local release; source is pushed and both sites are published with the reviewed data seed. [Live verification](docs/discovery/13-first-publication.md).
- [ ] Register production EVE callback, configure collector environment/writer and verify a real hosted adoption/rotation/collection/deployment.
- [ ] Measure actual GitHub runner performance, validate queued-run rotation and exercise hosted recovery/rollback.
- [ ] Review/update existing Vite/esbuild, React Router and Zod audit findings; preserve legacy fallback behavior.
- [ ] Retire Deno and the old frontend after confidence in the live replacement; retain scraper concepts as an explicit alternative source.


## Working and verified

- [x] Local one-command backend start and static viewer/export.
- [x] EVE SSO PKCE bootstrap, JWT validation and durable local refresh-token replacement.
- [x] Real authorized access to Tortuga/Siseide and C-J6MT, with Jita as the reference market.
- [x] Official SDE catalog import, integrity checks, content-addressed activation, version skip and repair.
- [x] Resolve item names and packaged volumes locally without per-type ESI calls.
- [x] Bounded parallel collection: three HTTP operations overall, two page workers per hub.
- [x] Hub/page/enrichment progress and quote-data freshness in the test viewer.
- [x] Twenty-one-day history reducers, daily price/order-count fields, seven-day default and fourteen-day totals.
- [x] Aggregate current ask competition from `issued`, with a timestamped 24-hour window.
- [x] Persist aggregate book summaries instead of raw order pages; reject raw fields at the summary/publication boundaries.
- [x] Preserve ask-to-ask economics, shipping/tax costs and an estimated regional weekly opportunity value.

## Current storage/performance spike

- [x] Finish and record repeated 20,000-type pipeline benchmarks: initial import, price refresh and daily history reconciliation.
- [x] Compare compact/object JSON, V8 binary, a C binary worker, SQLite relational/JSON/JSONB, and an indexed JSON document store.
- [x] Record CPU, wall time, memory, state size, compression/restore footprint, semantic equality and local-runner limitations.
- [x] Recommend split compact JSON tables and precomputed serving summaries; retain SQLite as a keyed-history option. See [measurements](docs/discovery/07-storage-performance.md).
- [x] Remove the earlier proof's raw order-page cache after the local benchmark replay has finished.
- [ ] If a native/binary design is adopted later, specify schema/version checks, integrity checks, migrations and compiler/artifact handling first.
- [x] Benchmark the implemented 21-day lifecycle with 60,000 region/type pairs, full 402-record response replay, durable incremental checkpoints and three repetitions per job. See [lifecycle measurements](docs/discovery/08-history-lifecycle.md).
- [ ] Verify the chosen pipeline on an actual GitHub runner before claiming Actions timings or cost savings.

## Current closeout: Siseide retired

- [x] Default live collection to Jita/C-J6MT; retain the legacy Tortuga setting disabled.
- [x] Isolate optional structure 403/404 failures and list omitted hubs without poisoning the request queue.
- [x] Support variable active hubs in snapshots, route selectors and progress; allow future structure configuration.
- [x] Make the old scraper Pages workflow manual-only; ignore local editor recovery files.
- [x] Document GitHub Actions, credential persistence, source visibility and dormancy choices in [the briefing](docs/discovery/10-jita-cj-deployment-and-dormancy.md).
- [x] Select manual-only dormant operation and automatic replacement-grant persistence.
- [x] Confirm public code/collector and private credentials.
- [ ] Owner-review the implemented PAT/App Secret writer, Release-state cold start and manual workflows before publishing.
- [x] Prove static-browser API access to EVE discovery/JWKS/token rejection and authenticated-header GitHub REST; add local browser PKCE harness and tests. See [GitHub-only feasibility](docs/discovery/11-github-only-auth-feasibility.md).
- [ ] Owner-test successful live browser PKCE sign-in using `npm run backend:github-check` and the registered local callback.
- [ ] Review owner GitHub authorization (temporary scoped token versus additional button-only login work) and automatic writer (App versus retained token).
- [x] Owner approved/installed libsodium-wrappers@0.8.4; implement encrypted browser Secret writes.
- [ ] Prove pending-grant adoption and replacement write-back with environment Secrets, job-start loading, shared concurrency and queued-run/reconnection tests.
- [x] Select and implement bounded versioned Release assets with credentials excluded; actual hosted restore remains to be proven.
- [x] Implement the exact static Pages callback and repository subpath.
- [ ] Prove one full real hosted sign-in → Secret → collection → publication cycle.
- [x] Commit and push the reviewed scaffold, documentation and shared contracts.

## Backend data lifecycle

- [x] Diagnose the live three-region 404 trap; defer item-specific 404s for 24 hours, preserve deferral ages/counters, and display them locally.
- [x] Automatic bounded 1,000-request batches, hard retry-inclusive request caps, numbered reports, and persistent pause/resume.
- [ ] Observe a complete live pass with the fixed collector and verify daily correction/upsert metrics after the next source update.


Implemented behavior and decisions: [history lifecycle](docs/discovery/08-history-lifecycle.md). Live observations remain separate from replay benchmarks.

- [x] Implement the persistent daily regional-history refresher using the chosen storage adapter.
- [x] Retain 21 completed UTC calendar days; upsert corrections, catch up missed days and trim outside the window.
- [x] Separate history refresh from frequent quote jobs; fresh quotes can publish using the last successful dated history.
- [x] Respect ESI expiry/conditional headers and maintain independent per-region/type refresh/provenance records.
- [x] Make a full daily refresh resumable within a request/time budget; share duplicate region/type work.
- [ ] Record real collection/upsert metrics on consecutive days using the new UI reports; measure full backfill pace under live ESI limits.
- [ ] Verify how ESI represents no-trade days; preserve unknown data until zero-trade semantics are established.
- [x] Add weekly-equivalent flow to the shared 7/14-day summary model (`volume14d / 2` for fourteen days).
- [x] Integrate those summaries with the persistent daily-history refresher and publication adapter.
- [x] Track history check time, coverage date and last actual record separately. Leave warning UX for the frontend phase.
- [ ] Integrate and time a complete live quote dataset with the catalog and aggregate cache, after the storage decision.
- [ ] Check `Last-Modified` consistency across paginated books and reject mixed generations where the provider exposes enough information.
- [x] Add operational summaries for requests, cache hits, elapsed time, missing catalog IDs and per-source failure/retry status.

## Competition and opportunity semantics

- [ ] Owner-controlled EVE check: compare `issued` before/after repricing to verify the precise “updated” interpretation. Until then label the metric as recent issued ask activity.
- [ ] Keep recent order count, current remaining units and original listed units distinct; none establishes unique sellers or newly imported quantity.
- [ ] Verify the 24-hour boundary, future/missing timestamps, partial data and cached-window timestamps against a real collection.
- [ ] Decide whether competition is informational or affects ranking; do not invent a penalty weight silently.
- [ ] Finalize opportunity ranking around Jita ask → destination ask, hauling, sale expenses and weekly-equivalent demand.
- [x] Keep regional volume clearly labeled as a demand reference, not verified sales at the individual structure.
- [ ] Decide how to surface a destination with no ask price; a stockout is useful information but does not supply a measurable sale margin.
- [ ] Retain no price-level archive, order-ID history or quantity-execution engine unless the strategy changes.

## Publication and recovery

- [x] Checksum retained JSON shards/checkpoints, replay interrupted batches, and locally verify/rebuild derived serving summaries.
- [ ] Add automatic run-report retention (full reports currently persist; UI lists the latest 20).

- [ ] Finalize the public snapshot contract, schema version, provenance and forward/backward compatibility policy.
- [x] Publish compact current facts and 7/14-day summaries; keep the retained daily series out of the viewer payload unless charts require them.
- [ ] Activate a validated generation atomically; never mix catalog/quote/summary generations accidentally.
- [ ] Test corrupt/missing state, partial history failures, interrupted writes, expired/revoked grants and rollback to the last good publication.
- [ ] Make backup/retention rules explicit for catalog content files and derived state; keep only the latest order summaries.

## GitHub Actions and hosting — later

- [x] Implement environment Secret storage, immediate replacement write-back and shared workflow concurrency; real queued-run verification remains.
- [x] Restore/persist reusable catalog, daily history and summaries through checked Release assets with cold-start recovery; credentials use Secrets.
- [x] Add manual SDE check/update operation calling the existing updater. Periodic schedules stay disabled while dormant.
- [x] Add manual bounded history and quote operations using shared entrypoints; schedules remain off.
- [x] Add shared workflow concurrency, scoped permissions and redacted failure logs.
- [x] Build both sites as one Pages artifact from an explicit public allowlist, excluding grants, raw caches and backend daily series.
- [x] Verify deployed Pages subpath URLs and seeded data publication.
- [ ] Measure production compression/cache behavior and first refreshed-data publication.
- [x] Owner reviewed the combined local deployment before authorizing push/publication.

## Frontend/UX — iterative phase

- [x] Table-first backend viewer; separate setup/statistics/metrics page, collapsible route assumptions, collapsed quote ages that open on stale data.
- [x] Restore original profitability/filler/price-density columns; replace unavailable Goonmetrics weekly profit with a labeled computed gross estimate.

- [ ] Agree on a production layout and integrate the snapshot model with the React frontend or the chosen replacement.
- [x] Preserve search/sorting/large-table performance with the full dataset.
- [x] Default to Jita purchase ask and Tortuga/C-J6MT listing ask; expose cost assumptions clearly.
- [x] Add estimated weekly opportunity ranking and transparent regional-volume interpretation.
- [x] Add competition indicators with labels matching the verified timestamp semantics.
- [x] Review seven-/fourteen-day controls and normalize the displayed flow period appropriately.
- [ ] Decide when/how to notify users of history staleness, including the owner's 2–3-day tolerance.
- [ ] Cover missing quotes/history, stockouts, stale/partial data, loading and collection failures.
- [ ] Verify responsive layout, keyboard access, formatting and owner acceptance with real market snapshots.

## Release readiness

- [ ] Run end-to-end collection → history merge → publication → static-browser checks from a clean checkout.
- [ ] Document first setup, catalog updates, grant reconnection, local start/test, scheduled operation and recovery.
- [ ] Review the remaining legacy scraper/API deployment workflow and remove or replace it deliberately.
- [x] Owner accepted and authorized the initial GitHub deployment; publication and public browser checks passed.
