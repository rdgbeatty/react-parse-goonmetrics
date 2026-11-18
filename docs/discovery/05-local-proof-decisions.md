# Local proof: decisions for review

Implemented 2026-11-06. [Run guide](../../apps/market-backend/README.md). [Discovery index](README.md).

**2026-11-07:** the successful concept has been promoted to `apps/market-backend`, with `backend:*` commands and a working SDE catalog updater. This document records the proof's decisions chronologically; the current storage-model spike, 21-day history choice and bounded concurrency are in [document 6](06-backend-data-model.md). Earlier statements that the catalog is unimplemented or that collection is sequential describe the superseded proof.

## Scope and current result

This phase proves **local collector → validated JSON file → static browser viewer**, with an independent 60,000-row synthetic scale mode. It includes a local EVE authorization-code flow, durable refresh-token replacement, cached/paginated ESI collection, a default bounded sample, and opt-in full current-quote coverage. The same viewer works from a public-only export with no collector/auth endpoints.

Nothing has been committed, pushed, uploaded, scheduled or deployed by this proof. Existing GitHub workflows are untouched. No npm packages were installed or added.

The owner has now confirmed successful PKCE login and completed live collection. Inspection of the saved snapshot and private ESI response cache confirms responses for both configured structures; see the live follow-up below. Automated ESI/SSO tests use signed fake tokens and fake HTTP responses and remain separate from this real-world evidence.

## Decisions, alternatives and implications

| Question | Decision in this proof | Alternatives / reason to revisit |
| --- | --- | --- |
| How much of the app changes? | Keep the proof under `prototype/`, with a small shared `marketSnapshot.mjs` contract. Existing React/Deno screens remain as their original flow. | Integrate directly into React now. That requires frontend installation and couples the data experiment to the larger refactor. A later React integration can consume the same snapshot. |
| Frontend/runtime dependencies? | Native browser modules and Node standard library; Node 18+ and `npm run poc` suffice. | Existing React/Vite or a new framework. Their capabilities are unnecessary to validate file publication, routes, sorting and memory at this phase. No package-install permission is needed because there is no install. |
| Is the Node server a new production API? | No. It is a loopback-only setup/collector/preview utility. `poc:static` serves just the export and has no local endpoints. | Host the API permanently. Not needed for the approved public/single-collector snapshot requirements. |
| Auth for local setup? | **Authorization code with PKCE/S256**, a real local callback, a one-use random state bound to an HttpOnly cookie, an independent verifier retained only in process memory, and RSA/JWKS JWT verification. Both exchange and refresh omit the app secret. Retain legacy confidential token refresh for compatibility. | The initial confidential flow and then form-based client authentication both failed the owner's real login. EVE's documented desktop flow matches local bootstrap better and removes the application-secret dependency. Manual token pasting or an external callback server adds avoidable handling. The initial Basic-only code also omitted OAuth component encoding for reserved characters. |
| Credential storage? | Ignored `private/` JSON written atomically with POSIX mode `0600`; directories request `0700`. The server never serves these files. Refresh replacements are saved before subsequent validation/collection can fail. Access tokens stay in memory. | OS keychain or authenticated encryption with a separately managed key. Those improve at-rest protection but add setup beyond this local proof; Windows ACLs need separate attention. GitHub secret/state write-back remains a later decision, not something this local store resolves. |
| Token/job concurrency? | One file lock serializes settings, callback credential writes, disconnect and collection, including CLI versus server. It can recover a lock whose owning process no longer exists. | A database lease/queue. One owner process and occasional CLI use do not need it. Crashing between upstream rotation and durable storage can still require reconnection; locks are not a distributed transaction. |
| Which live data first? | Default to 50 selected types per hub (max 200). Zero opts into the full union of types quoted across all three locations, including Jita-only types. The saved setting is preserved. | Automatically switch the owner's next button press to an expensive cold-cache run. An SDE/catalog or controlled concurrent enrichment can reduce the later per-type HTTP cost; neither is needed to add an explicit full-coverage experiment. Full current quotes still use separately limited regional history. |
| How to select the sample? | Alternate between each private book's ascending numeric type IDs, deduplicate, and publish the selected set for all hubs. Fall back to Jita if both private books are empty. | Taking the lowest IDs from the combined private books excluded every Tortuga item in the owner's first live sample. Watchlists, profitability ranking or market-group selection should replace the arbitrary proof selector later. |
| Why an ESI contact? | Maintainer contact/project URL is sent in the collector's User-Agent, outside the public snapshot. The proof requires it in local setup. | ESI recommends identifying the application; it does not require this form field for authorization. A deployed collector should configure the contact once for the maintainer, rather than requesting it from visitors. |
| Why repeated local status requests? | Poll once per second while a local collection runs, plus a pre-operation check. Status reads local state and makes no EVE requests. | Slower polling or server-sent events can reduce local traffic. One-second polling keeps this proof simple; a static viewer has no collection polling. |
| How to report progress? | Two bars: current/completed hubs and exact page progress from X-Pages. The second switches to item details, history and publication after the books finish. Polls report completed work, including cache hits, and resume after a browser reload. | A 20,000-item estimate would mix item types with raw orders/pages and could be misleading. Until the first page supplies its total, show indeterminate progress. Do not present a fabricated overall ETA. |
| Which timestamp is market freshness? | Use the oldest observed page per hub, preferring upstream Last-Modified, then Date/Age, then receipt time. Cached bodies and 304s preserve their age. Display absolute times and minute-updated relative ages, with file-generation time separate. | Re-label a regenerated JSON file as fresh data. That hides stale cached books. Existing cache entries retain their original observation timestamps until revalidation. |
| Freshness colors? | Under 1 hour is green, 1–8 hours amber, and 8 hours or more red. Exact age is always visible independently of the color. | Block old data, hide it, or silently refresh it. The owner tolerates delayed updates and needs to judge their usefulness. These thresholds are display decisions, not ESI expiry rules. |
| What is a quote? | Exact-location orders, minimum sell and maximum buy. Always acquire at source sell; choose destination sell-listing or immediate-buy execution estimate. Book units sum the full selected side. | Range-aware buy orders, depth-weighted trade sizes, fees by skill/structure and route execution. Current quotes estimate unit economics only; stock at other prices is not executable at the best price. |
| Cost assumptions? | Editable defaults: 700 ISK/m³ and 5.37% total sale expenses, taken from current source code. Prefer packaged volume; use ordinary type volume only when packaged volume is absent. Missing volume means unknown landed profit. | Character skills/structure fees, relist model, item-specific hauling state and exact decimal arithmetic. The current proof uses normal JavaScript numbers for estimates, not an accounting ledger. |
| Weekly volume? | Fetch history for up to 10 sampled types per distinct region by default (max 25, zero disables). Sum the last seven completed UTC days only when all seven dates exist. Cache according to ESI headers/ETags. | Full daily history fan-out, a larger rolling demand model, or book-depletion estimates. Regional volume is not hub sales. The proof intentionally omits weekly-profit/filler scoring rather than inventing hub demand. |
| Caching and failure publication? | Cache bodies/ETags/expiry outside the public directory, scoped by endpoint/character/compatibility date. Reuse fresh bodies and handle 304. All required books must finish before replacing the single snapshot file. | Publish partial hubs or stale individual fallback. That needs more metadata/UI and is deferred. Current failures leave the entire previous snapshot. |
| Large-table rendering? | Keep all derived rows in memory, render 100 rows per page, sort already-derived rows. | Reuse the existing React virtualization immediately. Pagination gives a small DOM and a useful file/browser test without React installation or a second virtualization implementation. |
| Where are generated files? | `.market-poc/` is ignored. Public export contains five root entries including `data/market.json`; a strict snapshot contract rejects extra fields. | Commit market JSON or write a GitHub state branch now. Neither is needed before local review. |
| IDs and API versions? | IDs become strings at the snapshot boundary; reject unsafe integer ESI IDs. Pin compatibility date `2026-11-05`. | Lossless JSON integer parsing or a generated client. Those can be introduced if actual IDs exceed JavaScript's safe range or endpoint scope grows. |
| Background work? | Explicit local button/CLI only; bounded retries, sequential pagination, and fail-fast rate-limit handling. | Timer, Actions workflow, queue or high-concurrency ingestion. Deliberately deferred until the local proof is reviewed. |

## Implemented verification

The initial `npm run poc:test` passed **15 checks**; auth, sampling, full coverage, progress and freshness regression coverage brings the suite to **29 checks**:

- 60,000 synthetic rows round-trip; comparisons work for every source/destination combination.
- Acquisition/sale sides, haul defaults, unknown versus zero volume, null sorting and seven completed UTC history days.
- Rejection of credential fields/duplicate types/invalid values at publication; invalid publication preserves the old file; local operations serialize.
- ESI pages/cached bodies/304, inconsistent page counts, unsafe IDs, and permission/rate-limit failures.
- JWT signature/issuer/audience/expiry/scopes, and refresh-token persistence before a subsequent validation failure.
- Full mocked ESI/SSO flow for Jita, Siseide and C-J6MT, with real aggregation and regional-history summaries.
- Bounded samples include both private hubs even when one book contains every lowest numeric type ID; shared types are deduplicated and empty books fall back correctly.
- Full scope includes Jita-only types, preserves missing private quotes, and passes through local configuration and the real collection pipeline with mocked upstream data.
- Exact page progress for network and cached pages; progress for all three books, metadata and regional history; local in-flight progress, duplicate-job rejection, publication completion and failure state.
- Thirty-minute versus one-day ages, display thresholds, the oldest page timestamp, upstream Last-Modified and Date/Age, and unchanged age through 304/local cache reuse.
- Local HTTP credential isolation, Host/origin/CSRF protections, OAuth state binding and replay rejection, and public-only static export behavior.
- OAuth client authentication method selection, reserved-character encoding for Basic credentials, separate app/code/refresh error handling, secret-safe error messages, and removal of stale errors after saved settings.
- RFC PKCE challenge/verifier matching, client-ID-only local login, secret-free PKCE exchange/refresh, authentication-mode persistence, and exactly one token exchange for a callback despite replay.

Installed Chrome in headless mode loaded the actual 60,000-row fixture and rendered the page. Browser interaction checks passed for six trade directions, same-hub empty state, swap, search, pagination, numeric sorting, strategy/cost changes, and recovery from an attempted live collection with missing credentials. At most 100 data rows were rendered at a time. The generated snapshot was approximately **9.47 MB**. Headless virtual-time timing is not used as a trustworthy parse benchmark.

The explicit static export command succeeded. Credential/cache/generated paths are ignored by Git. Syntax and whitespace checks passed. No package installation, provider account access or real EVE request was required for these checks. The existing Deno test suite was not run; it is separate and Deno is unavailable in this environment.

## Owner's acceptance sequence

1. Run `npm run poc`, open the printed URL, and inspect fixture behavior and route/cost assumptions.
2. Register the displayed callback/scopes, save the EVE application credentials locally, and connect the character. Confirm the displayed character is correct.
3. Supply Tortuga's actual ID and verify the C-J6MT ID. Begin with a small sample and optionally history set to zero; run live collection. Record duration, request count and cache hits shown in the live banner.
4. Run collection again to verify cache reuse and that the persisted grant works after restarting the local process. Test incorrect structure access deliberately if appropriate, checking that the last good file remains.
5. Export and run `npm run poc:static`; confirm the same live dataset works without a collector API. Inspect the downloadable JSON.
6. Review the choices above, especially native-module isolation, the bounded live universe, credential storage, quote strategy and regional-volume interpretation. Only then choose the next slice: full catalog enrichment/React integration and, separately, GitHub credential persistence/publication.

Owner testing has established live login and collection; the remaining acceptance steps still apply. Passing the fixture and mocked-auth tests does not approve future publication.

## Auth failure follow-up

The owner subsequently reached the local OAuth callback but received a generic 401 message. No grant was saved. Public discovery confirmed the expected endpoints and advertised both `client_secret_basic` and `client_secret_post`. Diagnostic requests used freshly generated invalid codes, never the owner's captured cookies or code. Basic requests returned 401; form-authenticated requests returned `invalid_grant` even with a deliberately wrong dummy secret. Thus those probes **do not validate the saved secret**, nor prove a successful token exchange.

Changes made: encode Basic client components according to [OAuth section 2.3.1](https://www.rfc-editor.org/rfc/rfc6749#section-2.3.1); prefer the advertised form method without retrying a one-use code; identify the failed SSO stage; distinguish client credentials, expired codes and invalid refresh grants; omit untrusted error descriptions; trim copied outer secret whitespace; clear stale errors on saved settings/disconnect; and require actual connection status before displaying a query-string success message.

The full corrected login still requires a fresh owner-driven EVE authorization. The application credentials have not been declared valid on the strength of an invalid-code probe.

The updated 20-test suite passed. A separate headless Chrome regression also passed: an unauthenticated page with `?connected=1` no longer displays a successful connection, and the one-use OAuth feedback flag is removed from the URL.

### Second follow-up: local PKCE

The owner's fresh retry of the confidential/form flow returned `400 invalid_grant`; the form-method change did not establish a working login. New local logins now follow [EVE's documented PKCE/S256 flow](https://developers.eveonline.com/docs/services/sso/#authorization-code-with-pkce). A fresh random verifier is kept with its state, client ID and original redirect URI, never sent to the browser or persisted in the public snapshot. The callback reuses that exact redirect URI and verifier. A private `authentication: "pkce"` marker makes later refreshes use the public-client payload documented in the [native-app refresh guide](https://docs.esi.evetech.net/docs/sso/refreshing_access_tokens.html#native-applications).

This is a deliberate local-auth design change, not proof of why EVE rejected the earlier grant. Real acceptance still needs an owner-driven fresh login. The app retains any saved legacy secret but does not transmit it in PKCE requests, and it never retries an authorization code automatically.

### Live collection and sample follow-up

The owner confirmed successful local PKCE login. The saved live snapshot contains 50 rows for each of Jita, Tortuga and C-J6MT. The cached structure identities are `Siseide - Tortuga` and `C-J6MT - 1st Taj Mahgoon`. Cached order responses contain 1,189 Tortuga orders across 555 types, and 53,193 C-J6MT orders across 7,817 types. These are observations from this local run, not ongoing market counts.

The original combined-lowest-ID sample selected no Tortuga types, so all 50 Tortuga rows had null quotes despite a successful authorized fetch. The selector now alternates between the two private books before deduplicating and bounding the sample. This corrects the proof's coverage without expanding enrichment beyond its existing limit. Existing snapshots are preserved; restart the local server and collect again to publish the corrected selection.

The inspected run took about 83 seconds, with 462 ESI HTTP requests and 92 cache hits reported by the collector. Full raw-book pagination and per-type metadata/history requests explain why a small published sample can still take substantial time. These network costs are distinct from parsing or aggregating 20,000 in-memory rows. Local `/local/status` polls are separate from these ESI counters.

### Full coverage, progress and freshness follow-up (2026-11-07)

The 50-type default originally bounded enrichment while authenticating and reading the private books. It did not reduce order pagination. Full mode now uses `typeLimit: 0` to publish all types quoted at any of the three configured locations; positive values retain the existing sample mode. This zero convention is explicit in setup and the shared snapshot contract. No existing settings or live snapshot are rewritten automatically.

The cold-cache request cost is approximately one metadata lookup per distinct selected type, plus up to `historyLimit × distinct regions` history lookups, alongside the paginated books and structure resolution. Metadata/HTTP caching remains in use; a bulk static catalog and concurrent requests are future alternatives. The first full experiment should use history zero to measure complete current prices and metadata independently. Full history is still outside the proof's 0–25 history setting and must not be inferred from the full-books label. A full live collection has not been run by the agent.

Both progress bars report actual work, without an overall duration estimate. The hub bar finishes when the three books are collected, and the second bar continues through enrichment and publication. The browser can resume watching an existing job after a reload. Market freshness is based on source observations independently of file generation, updates locally every minute, and is shown for all three hubs even when only two are selected in the trade table. See the run guide for the source timestamp fallbacks and display thresholds.

Installed Chrome passed an additional browser check using isolated temporary state and mocked collection: unknown/exact page counts, hub changes, metadata/history/publication, reload/resume, completion/failure, preserved previous data, per-hub absolute/relative ages, age advancement without refetching, stale warning despite recent file generation, full-scope labeling and the mobile freshness layout. The 60,000-row dataset still renders at most 100 table rows at a time. These checks make no live EVE calls and do not rewrite the owner's configuration, grant or snapshot.

### Data lifecycle clarification: SDE and daily history (2026-11-07)

The owner correctly identified that the per-type metadata requests are an implementation shortcut, not a requirement of full market coverage. The current [official SDE](https://developers.eveonline.com/docs/services/static-data/) provides the static catalog, and its [schema changelog](https://developers.eveonline.com/static-data/tranquility/schema-changelog.yaml) confirms the `types.packagedVolume` field. The intended next implementation should derive a compact local catalog keyed by type ID, containing the English name and hauling volume, and reuse it for every collection. Check the SDE build identifier and rebuild when it changes; names and volumes are static between applicable game updates, rather than immutable forever. This eliminates routine per-type ESI metadata calls. Retain packaged versus ordinary volume distinctions during import.

| Data | Intended refresh cadence | Stored state |
| --- | --- | --- |
| Item catalog | Initial setup and new SDE builds | Compact catalog and source build identifier. |
| Current orders/quotes | Each requested market refresh, respecting ESI cache expiry | Latest public snapshot and rebuildable page cache. |
| Regional daily history | Daily, independently of quote collection; check publication/expiry before retrying missing recent data | Records keyed by region, type and UTC date, plus fetched time, ETag and date coverage. |
| Weekly-volume summary | Recompute locally from retained history as its UTC window advances or corrected records arrive | Summary and history-through date, independent of quote freshness. |

The current [ESI OpenAPI specification](https://esi.evetech.net/meta/openapi.json) documents `/markets/{region_id}/history` as expiring daily at 11:05. Its data-selection parameters are `region_id` and `type_id`; it has no start/end/since date filter or batch of types. Conditional HTTP headers support validation but do not request a partial date window. Consequently, refreshing only the last 2–3 days is a local merge/reconciliation policy, not a way to reduce this endpoint to a delta response. Daily per-region/type request fan-out still exists; it should not be repeated for each hourly price job.

Retain a small rolling history window, for example 14 completed UTC days for seven-day statistics and overlap checks. Update existing dates by key instead of blindly appending, catch up all missing dates after downtime, and reconcile all returned dates within the retained window since the response already contains them. This also captures corrections older than three days within that window. No relational database or long-term order-history archive is required for this state. Persist the catalog and history between local runs and eventual Actions jobs; process memory alone is insufficient.

The current prototype already reuses unexpired ESI type/history responses, but still requests type metadata through ESI and computes history during the collection pipeline. A separate SDE catalog and independently scheduled/resumable daily history refresh remain **planned changes**, not implemented behavior. The earlier 20,000-metadata-request estimate applies to that shortcut on a cold cache. It is not a reason to restrict full market snapshots once the catalog is in place. This clarification changes documentation only and performs no live collection.
