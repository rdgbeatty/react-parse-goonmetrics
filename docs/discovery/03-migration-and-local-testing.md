# Migration and local testing plan

Research date: **2026-11-06**. [Discovery index](README.md).

**Scope update:** [document 4](04-github-only-vs-cloudflare.md) evaluates the owner's simpler public-snapshot proposal and is now the first prototype recommendation. For that path, use a local Node OAuth bootstrap/collector, fixture JSON + Vite, durable GitHub credential handling and one Pages publishing workflow. The permanent API/database/viewer-authentication phases below are the broader alternative, not prerequisites for the static version. Keep the data-contract, completeness, calculation, caching and local-operation checks that apply to either design.

## Intended outcome

An owner can connect one or more EVE characters, configure Tortuga and C-J6MT by structure ID, collect their books alongside Jita, and view import/export opportunities with explicit quote strategy and freshness. A local fixture mode works without EVE or cloud accounts. A live local mode tests real SSO/structure access. Starting locally and deploying each require one command after initial setup.

This document specifies work to implement after discovery. **Proposed files, routes, scripts, schemas, and commands below do not exist yet unless explicitly described as current.** This change adds documentation only.

## Phase 0: establish the baseline and answer the data questions

1. Preserve the current branch and record representative outputs for `top500` and `marketgroup`, both buy/sell views, and both import/export pages. Use sanitized fixed fixtures for repeatable tests; live pages are a separate compatibility check.
2. Obtain Tortuga's numeric structure ID when it is available. Resolve its system using an authorized character. Verify the C-J6MT candidate `1049588174021` independently; keep both hubs in configuration from the outset.
3. Register a development EVE SSO application with the two scopes in [the API guide](01-eve-api-and-authentication.md). Authorize one collector character, verify which hubs it can reach, then test another grant if access differs.
4. Record actual book pages, type counts, payload bytes, ETags/cache timing, and collection duration. Use a small type allowlist for the first public Jita comparison. No 18,000-type history fan-out during discovery.
5. Decide the viewer policy: proposed initial default is an owner-controlled allowlist. Decide whether additional visitors bring their own credentials or see an explicitly shared collection profile.
6. Agree on acquisition/sale strategies, hauling rules, and how unknown weekly demand appears. Launch price comparison separately from unvalidated weekly rankings.

**Exit evidence:** verified hub/character/access matrix; one complete read-only book fetch for each accessible hub; observed upstream limits; agreed labels for legacy versus ESI-derived metrics. If Tortuga is not yet deployed, its real-access check remains open while fixtures and C-J6MT establish the implementation path.

### Existing commands and baseline limitations

With the repository's required Deno/pnpm tools installed, run from the root:

```text
pnpm install --frozen-lockfile
pnpm --filter @gm/web test
pnpm --filter @gm/web build
pnpm --filter @gm/web exec tsc --noEmit
```

Existing API tasks can be run unambiguously from `apps/api` with `deno task check`, `deno task lint`, and `deno task dev`. Validate/fix the check task and alias resolution before treating its result as a migration gate: its current command is `deno check --unstable src`, and repository imports use two alias schemes. Keep any baseline repairs separate from the ESI behavior change. Current web `build` only bundles with Vite; the explicit type-check is an additional check that may reveal pre-existing issues.

The current setup needs a separate API terminal and web terminal, and it has no deploy-all script. The discovery environment has no Deno/pnpm/dependencies installed, so these are instructions for the implementation baseline, not tests already completed here.

## Phase 1: prove two locally runnable options before selecting technology

Time-box the experiments to one minimal authenticated route, one fixture market, persistence across restart, and a scripted start/deploy path. Do not build complete applications twice.

| Experiment | Local proof | Hosted proof / decision |
| --- | --- | --- |
| **A: Workers serving API + D1 + snapshots + Node collector** | Wrangler local runtime with local D1 and R2 (or chosen D1 snapshot adapter); fixture ESI/SSO services; same collector runs as a local Node process. | Check cold/warm SSO callback, session/data response CPU, streamed snapshot latency, job leases, storage usage and scheduled collector duration on the Free plan. Promote only if it meets the agreed budget. |
| **B: Node/Hono + PostgreSQL** | One Docker Compose command starts a Node app, worker, PostgreSQL, migrations and fixtures; web served by app or local proxy. | Demonstrate deploy to a staging container host from one script after bootstrap. Record realistic app + DB + scheduler cost, not just the advertised minimum. |
| C: Neon backend candidate | Reuse the Node handler/collector prototype and local PostgreSQL. Investigate official local tool support rather than substituting a production DB. | Prove EVE callbacks, scheduled execution or external schedule integration, resource budgets, and automated provisioning/deploy. Reject as the first target if local parity or deployment is unclear. |

Wrangler runs Workers locally, and D1 has a documented local database workflow. It does not prove production CPU limits, actual SSO, ACL behavior or provider scheduling, so the small hosted proof is still necessary. [Workers local development](https://developers.cloudflare.com/workers/local-development/), [D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/).

Record the result in a short architecture decision: chosen target, measured CPU/bytes/runtime/retention, acceptable collection delay, rejected alternative, and triggers for revisiting the decision. The default recommendation is A for $0, but do not select it before the measurements. Do not adopt a fresh Deno dependency for either option.

**Exit evidence:** a clean checkout starts locally with one command; a restart retains data; one staging deployment succeeds from a script; a measured budget and limitations are documented. If no hosted design fits $0, record a reduced-cadence option and its observed limits before proposing a paid plan.

## Phase 2: introduce contracts and preserve the legacy adapter

Edit shared contracts first. Keep the current `ScrapedRow` only for the legacy provider while the frontend transitions. Suggested shape, deliberately incomplete rather than a final schema:

```ts
type Hub = {
  id: string; // application identity, e.g. "siseide-tortuga"
  name: string;
  systemId: string;
  regionId: string;
  locationId: string;
  locationKind: "station" | "structure";
  collectionProfileId: string | null;
};

type DemandMetric = {
  units: number | null;
  scope: "structure" | "region" | "legacy-unknown";
  method: "unavailable" | "regional-history" | "estimated-depletion" | "goonmetrics";
  windowStart: string | null;
  windowEnd: string | null;
};

type MarketQuote = {
  typeId: string;
  itemName: string;
  hubId: string;
  bestBuy: string | null; // decimal ISK at the API boundary
  bestSell: string | null;
  availableBuyUnits: number;
  availableSellUnits: number;
  packagedVolumeM3: number | null;
  observedAt: string;
  generationId: string;
  demand: DemandMetric;
};
```

Normalize external IDs to decimal strings; validate lossless parsing of ESI's integer IDs rather than assuming all future int64 values fit a JavaScript number. For stored money, choose scaled integer or decimal representations, with explicit rounding at the calculation boundary. Keep missing quotes/volume distinct from zero. Add envelope fields for provider, schema/strategy versions, collection window, freshness, completeness and `nextEligibleAt`.

Generalize profitability inputs to source/destination quotes and a route policy. Preserve existing C-J6MT formulas through an adapter and golden fixtures, then add strategy and demand changes explicitly. The filler score ranks relative to the candidate set: changing a hub, filter, or demand model can change scores even when an item's unit economics are unchanged. Document and test the chosen comparison population.

Add provider interfaces with injected fetch, clock and storage. Reuse shared calculation logic from browser and collector only where semantics match. Avoid importing a Deno service or Cloudflare binding into shared/domain code.

**Exit evidence:** existing legacy cases pass; Tortuga fits the new schema without `tortugaPrice` fields; missing demand keeps unit profit available without manufacturing weekly profit/filler values.

## Phase 3: persist credentials and complete market generations

For the free/snapshot design, propose these operational records:

| Record | Essential identity / invariant |
| --- | --- |
| `hubs` | Stable app key, location/system/region IDs, kind, enabled state. Names may change without changing identity. |
| `oauth_grants` | Owner/character, scopes, encrypted refresh token, encryption-key version, expiry/status, refresh lease/version. Never a plaintext token column. |
| `hub_grants` / profiles | Which credential collects which hub, plus the application's viewer policy. Successful login alone does not imply this mapping. |
| `sessions` | Hashed opaque session identity, viewer, expiry/revocation. Keep sessions out of public caching. |
| `collection_jobs` | Profile/hub key, status, attempt count, durable lease expiry/fencing token, next eligible time, idempotency key. |
| `snapshot_generations` | Provider/profile/hub, version, storage key/chunk manifest, byte count, page counts, collection window, completion status and error summary. |
| `active_generations` | One complete-generation pointer per profile/hub/dataset. Update atomically after validation. |

Use versioned SQL migrations and idempotent seeds. D1's schema and PostgreSQL's schema are separate adapters; do not promise that a SQL script using one engine's features runs unchanged on the other.

Publish immutable snapshot objects first, then conditionally switch the active pointer only if the collecting job still owns its lease. Object upload and database commit are not one transaction; failed uploads leave the old pointer, while unreferenced objects are cleaned later. Readers always use a generation manifest, and missing/corrupt chunks do not produce partial data. For a cross-hub comparison, return each book's time window and flag excessive age/skew.

The trusted Node collector accesses only its environment's credential/storage resources. For Cloudflare, implement local and hosted storage adapters so local runs use emulated bindings/internal local operations while hosted runs use authenticated storage APIs. Do not make fixture mode require a cloud token. Persist replacement refresh tokens immediately under the grant lease. A revoked/expired grant stops its jobs without discarding another hub's valid data.

For a PostgreSQL design, use transactions for operational state and publish/replace book data atomically; keep bounded histories and indexes appropriate to measured queries. Start with direct SQL or a small query layer. Adopt Prisma only if it improves migrations/types for the chosen runtime.

**Exit evidence:** restart persistence, atomic publication, orphan cleanup, idempotency and concurrent token-refresh tests pass. A backup can be restored to an isolated local/staging environment with the appropriate encryption key. Losing the key requires reconnection, not silently losing track of that dependency.

## Phase 4: implement ESI collection and refresh controls

Start with one public Jita type and one structure page; progress to the complete configured universe only after pagination and error tests pass. Enrich type metadata once and cache it. History collection is a separate low-frequency job for explicitly tracked types, not part of every order-book refresh.

Proposed API surface:

| Route | Behavior |
| --- | --- |
| `GET /api/hubs` | Configured hubs and viewer-specific access/connection status. |
| `GET /api/opportunities?sourceHubId=...&destinationHubId=...&strategy=...` | Quotes/derived rows from completed generations; include provenance, freshness, unknown demand and available depth. Never collect synchronously here. |
| `POST /api/refresh` | Authenticated, CSRF-protected request; validate hub/profile permissions; coalesce and return `202` with job ID and next eligible time. |
| `GET /api/jobs/{id}` | Owner-authorized queued/running/succeeded/failed status and data generation. |
| `GET /auth/eve/start`, `GET /auth/eve/callback` | Connect character and establish/update the application session. |
| `POST /auth/eve/disconnect` | Revoke app connection state and stop associated collection. |
| `GET /health`, `GET /ready` | Process health separately from storage/schema readiness. Report collection age through a dedicated status response. |

Timer, local command, GitHub manual dispatch, and eventual immediate in-app trigger all call the same collector service. For the initial $0 Actions scheduler, label the web control **Request refresh** and show that collection waits for the next run. Do not promise “refresh now” while merely queueing for a 30–60 minute scheduler. Owners can use the workflow's Run button for immediate dispatch, still subject to ESI cache eligibility.

**Exit evidence:** each private hub collects successfully under its authorized grant; Jita is shared once; repeated requests do not duplicate collection; one inaccessible hub cannot replace another's data with an empty book.

## Phase 5: UI transition and release

1. Add configurable source/destination hub selection with Jita ↔ Tortuga and Jita ↔ C-J6MT presets. Retain both import/export directions.
2. Keep `top500` and `marketgroup` legacy views during comparison. Add ESI as a provider; do not silently mix legacy demand with Tortuga prices.
3. Display connection state, quote side/quantity, last successful collection, queued-refresh status, and stale/degraded data. Give missing sales/volume a clear unavailable state.
4. Preserve memoized calculations/sorting and virtualized rendering. Port Deno-only test/benchmark harnesses to the selected Node-compatible tooling without rewriting their assertions gratuitously.
5. When moving UI and API to one origin, update Vite's production base, API-origin configuration and callback URLs together. Preserve hash routing initially if it still serves the UX; OAuth callback remains a backend path.
6. Deploy to staging, run the test matrix below, then make production selection through the deployment script. Keep the previous completed snapshots and application release available for rollback.

**Exit evidence:** the full hub/route/source matrix is verified, a clean checkout reproduces the build, and release/rollback scripts pass in staging before production cutover.

## Single-command operation contract

Use a supported Node LTS version compatible with the chosen tools, pin its exact version in the repository/CI, and pin pnpm in `packageManager`. Current local Node 18 and workflow Node 20 are baseline observations, not proposed target versions. Use cross-platform Node scripts as the root entry points so PowerShell and WSL users invoke the same commands. Do not require Bash, Make or global CLIs on native Windows.

**Proposed commands — implementation deliverables, not currently runnable:**

| Command from repo root | Required behavior |
| --- | --- |
| `pnpm dev` | Check tools/config, start local storage/runtime and fixture services, apply migrations, seed Tortuga/C-J6MT/Jita fixtures, start web/API/collector, print URLs. No cloud account or EVE login needed after dependencies are installed. |
| `pnpm dev:live` | Same local storage, but real EVE SSO/ESI; require development app credentials and explicit grant connection. No production data or resources by default. |
| `pnpm collect -- --hub siseide-tortuga` | Run the same collector service once against the selected environment, respecting leases/cache, with bounded retries and an exit code. |
| `pnpm verify` | Type-check, meaningful unit/contract/storage tests, fixture integration tests and production build. Fails if migrations or contracts drift. |
| `pnpm test:e2e` | Start isolated fixture environment, exercise browser flows, then shut it down cleanly. |
| `pnpm deploy -- --env staging` | Build/test, validate environment identity, run forward-compatible migrations, deploy assets/API, verify the committed collector workflow is installed/enabled, smoke-test, report URL and release ID. |
| `pnpm deploy -- --env production` | Same release path against explicitly selected production resources; refuse ambiguous/default production targets. |
| `pnpm rollback -- --env staging --release <id>` | Restore a compatible app release and complete snapshot pointer; retain newer additive schema unless a separately tested reverse migration is necessary. |
| `pnpm down` | Stop local processes/containers, preserving volumes by default. Destructive reset is a separate explicit operation. |

For option A, `dev` wraps local Wrangler, local fixture services and a Node collector; dev storage lives in an ignored directory and is never `--remote`. For option B, it wraps `docker compose up --build --wait` plus a migration job and app/worker startup. Health checks control dependency order; exiting the root command stops children and returns errors predictably.

First-run prerequisites remain explicit: supported Node/pnpm or the documented container wrapper, Docker Desktop with Linux containers for the Compose variant, and dependencies/images downloaded. A single-command start does not mean no prerequisites. Fixture mode should work without internet **after** those downloads; live mode necessarily requires network and EVE consent.

### Bootstrap versus routine deployment

One-time setup includes provider/GitHub accounts, app/resource creation, EVE application registration, exact callback registration, service credentials, encryption-key placement, and any R2 subscription checkout. Interactive character consent cannot be replaced by a deploy script. Script everything else that the selected provider supports; document the remaining portal steps precisely.

Record resource identifiers and nonsecret configuration in version control. Keep credentials in ignored local files and provider/GitHub secrets. Add nested `.env*`/`.dev.vars` ignore rules with deliberate exceptions for sanitized examples; correct `VITE_API_BASE_URL` in the example. Separate development, staging and production keys, grants, buckets/databases and callbacks.

Use **one manual deployment workflow** that invokes the same root deployment script as local use. Validate and deploy a tested release SHA, avoiding an independent frontend push that can race the API/schema. Existing GitHub Pages deployment remains available until cutover; disable its automatic production deployment once a replacement pipeline is authoritative. Daily collection is independent of application deployment.

Backups must cover operational SQL plus current manifests/objects and access to the encryption key. A code rollback cannot recover a dropped schema, deleted token, or missing encryption key. Prefer additive schema changes, a compatibility window, and cleanup only after both old/new code are no longer needed.

## Test matrix and acceptance criteria

| Layer | Cases that must be demonstrated |
| --- | --- |
| Legacy behavior | Both `top500`/`marketgroup`, buy/sell source views, imports/exports, relist changes, no C-J price, transport inference, sorting and virtualization. Capture intentional changes separately. |
| Quote rules | Min sell/max buy, missing book side, empty valid market, depth/quantity limits, minimum volume, exact-location buy matching, both route directions, hub-specific transport/tax policy, lossless IDs/money rounding. |
| Demand | Regional scope labeling, seven completed UTC dates, sparse/missing days, no hub-sales substitution, unknown demand propagates to weekly profit/filler score. |
| ESI transport | Multiple pages, `304` reusing a cached body, mismatched page counts, duplicate order IDs, missing page, truncated/invalid JSON, timeout, bounded retries, `401`, `403`, `420`, `429` + `Retry-After`, `5xx`. |
| OAuth | Valid/invalid/replayed state, expired code, invalid JWT/signature/audience/issuer/scopes, granted/denied consent, refresh replacement, concurrent refresh jobs, revocation/disconnect, local callback and actual hosted callback. |
| Access policy | A viewer cannot read another profile's snapshots/jobs, spoof a hub grant, or trigger unbounded work. Character-visible books do not enter public caches/artifacts. |
| Storage/jobs | Restart persistence, migrations from empty and previous schema, lease expiry/fencing, duplicate requests, publication failure, orphan cleanup, last-good data after failure, one inaccessible hub alongside one healthy hub. |
| Local operation | Clean checkout fixture start, no EVE/cloud secrets, restart, native Windows/WSL entry point, occupied-port error, failed migration, graceful shutdown, data retained after `down`. |
| Hosting/deploy | Scripted staging release, isolated resources, cold/warm free-tier CPU, stored bytes and API operations, actual Actions billed duration, delayed schedule/manual recovery, restored backup, rollback. |
| Browser | Jita ↔ Tortuga and Jita ↔ C-J6MT, changed route/strategy, unknown volume, stale data, token reconnect, queued request, source switches, deep-link load and large-table scrolling. |

Use fake fetch/clock and sanitized ESI/HTML fixtures for deterministic tests. Fake SSO signs tokens with a test key and supports discovery, consent denial, expiry and refresh rotation; production configuration must never trust the fixture issuer. Real character tests use a separate development app and opt-in credentials, outside routine PR tests. Do not make CI depend on EVE availability or access to a private structure.

Reuse the existing 500/18,000-row sort cases and 18,000-row render case after the contract/runtime change. Compare to a recorded baseline on the same machine. Check for accidental recomputation on sort clicks and loss of virtualization. Add representative order-book page/byte cases for collector memory and throughput; current row benchmarks do not measure ESI ingestion.

Default CI should run fixture tests, type checks, migration validation and builds. Hosted CPU, scheduling, ACL and callback checks are explicit staging gates because local emulation cannot establish them. Re-run relevant checks when new changes or failures justify it, rather than treating every discovery edit as a reason to execute production collection.

## Rollout order and stop conditions

Suggested independently reviewable slices:

1. Repair/pin baseline tooling, add fixtures and the root local runner.
2. Add generic hub/quote/provenance contracts and a legacy adapter.
3. Add credential persistence, SSO and application access controls.
4. Add complete-generation ESI ingestion and collector commands.
5. Add Tortuga/C-J6MT route selection and refresh status.
6. Add the selected deployment script/workflow, staging evidence and budget measurements.
7. Cut over, observe, then retire legacy scraping and Deno-specific tooling when their replacements are proven.

Do not cut over if structure access is unverified, partial books can be published as complete, token rotation is unsafe, unknown weekly sales appear as known values, the startup script needs undocumented manual terminals, or the $0 operating envelope has not been measured. If Tortuga does not yet exist, finish the platform and C-J6MT path while leaving Tortuga's live acceptance check explicitly pending.

After cutover, track last successful collection per hub, grant health, page/byte counts, job duration, quota usage, and snapshot age. A stale result should be understandable to the user and recoverable by a bounded manual run. Retire the old provider only after both hubs and both trade directions have working replacement coverage; the existing C-J6MT screen is part of the requirement throughout.
