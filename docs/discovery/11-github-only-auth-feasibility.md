# GitHub-only sign-in and collection: feasibility spike

Date: **2026-11-17**. This document supersedes document 10's assumption that hosted EVE sign-in necessarily needs an externally hosted callback. The preferred direction is now **GitHub Pages + Actions + Secrets**, with separate owner GitHub authorization. No new workflow, remote Secret, GitHub App, commit, push or deployment was created for this spike.

**2026-11-18 implementation:** [Document 12](12-combined-release.md) supersedes the implementation status here. The hosted flow and combined build now exist, with local/synthetic integration tests. Pending Secrets are intentionally retained to avoid concurrent-setup deletion races. No remote deployment has occurred.

## Finding and evidence

**The browser-access obstacle has passed a real Chrome test.** A static page can read EVE discovery, signing keys and a token-endpoint rejection. It can also read GitHub REST responses with an Authorization header. This supports a GitHub-only design; it does **not** prove a complete hosted login, Secret write or unattended collector yet.

| Check | Observed result | What it establishes |
| --- | --- | --- |
| EVE token endpoint OPTIONS from loopback and a representative `https://example.github.io` Origin | 204; allow-origin `*`, POST and content-type permitted | Advertised browser access does not exclude Pages. The representative origin is a header probe, not a hosted Pages test. |
| Chrome: EVE discovery | Readable 200 | Browser can discover the OAuth endpoints and S256 support. |
| Chrome: EVE signing keys | Readable 200 | Browser can download public JWT verification keys. |
| Chrome: token POST with deliberately invalid client/code | Readable 401 | Browser can send a form POST and read the rejection. This is a CORS success, not an OAuth success. |
| Chrome: GitHub REST with deliberately invalid Bearer token | Readable 401 | Browser preflight permits Authorization and the response is readable. Actual Secret-write authorization is untested. |
| Mocked exchange using real signed JWTs and WebCrypto | Six new test cases passed; full suite 77/77 | PKCE binding, one-use state, callback/expiry checks, JWT signature/identity/scope checks and safe error handling work under test. |

EVE's rejection was HTML rather than JSON. The probe reads the response without displaying its body; treating JSON parse failure as a CORS failure would give the wrong conclusion. A server-side probe with the known public application ID and a deliberately invalid code returned a readable 500 HTML error. Neither rejection predicts a real successful exchange. Browser probe elapsed times under headless virtual time are not meaningful network performance measurements.

EVE documents authorization-code PKCE without a client secret. GitHub documents REST CORS and encrypted Secret updates using a fine-grained token or GitHub App token. These are separate capabilities; access to EVE does not authorize GitHub writes. [EVE SSO](https://developers.eveonline.com/docs/services/sso/), [GitHub REST CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests), [Secret updates](https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret).

## How the design works

Pages supplies the browser's program. EVE supplies the login service. Actions runs the periodic collector. GitHub's REST API supplies the private credential store. An external application server is unnecessary **if the owner separately supplies GitHub authorization**.

```mermaid
sequenceDiagram
    participant Owner
    participant Page as Pages / owner browser
    participant Eve as EVE SSO
    participant GitHub as GitHub Secrets API
    participant Job as Serialized Actions collector
    Owner->>Page: Connect EVE
    Page->>Eve: Navigate to authorization with PKCE challenge
    Eve->>Page: Redirect to static callback with one-use code
    Page->>Eve: Exchange code + verifier, without app secret
    Eve->>Page: Access token + refresh grant
    Page->>Page: Verify signed token and character/scopes
    Owner->>Page: Supply temporary repository-scoped GitHub token
    Page->>GitHub: Fetch public encryption key; save encrypted pending grant
    Page->>Job: Dispatch owner setup / adopt grant
    Job->>Eve: Validate pending grant / character
    Job->>GitHub: Save canonical grant privately
    Job->>Eve: Collect Jita + C-J6MT
    Job->>GitHub: Preserve any replacement grant before continuing
    Job->>Job: Merge dated history and export public files
    Job->>Page: Publish viewer + market.json via Pages artifact
```

The diagram describes the proposed integration, not functionality already connected to GitHub. Ordinary visitors only download the public snapshot; this design assumes approved owners maintain **one shared collector**, as agreed during discovery. Individual private visitor datasets would require a separate design.

There are three different credentials:

| Credential | Purpose and location |
| --- | --- |
| Public EVE client ID | Identifies our registered application. Safe in Pages configuration. PKCE does not require publishing or supplying the application secret. |
| Private EVE character refresh grant | Lets Actions obtain short-lived character access. Canonical copy in an Actions environment Secret; never in source, Pages files, cache, logs or state archives. |
| Private GitHub authorization | Permits Secret changes and optionally workflow dispatch. Owner setup uses a temporary scoped token in browser memory. The unattended writer uses an App installation token or a separately stored scoped personal token. |

A public encryption key is not a credential that grants write permission. The browser must possess an authorized GitHub token as well as encrypt the value. Conversely, a GitHub token does not reveal existing plaintext Secrets through the API.

## Owner setup: two entirely GitHub-based choices

| Choice | Owner experience | Advantages | Tradeoffs |
| --- | --- | --- | --- |
| Scoped personal access token | Create a token for this repository; paste it into the owner setup page when connecting EVE. | Fewest components; no GitHub App registration or external host. | Token creation/reconnection is a manual step. Expiration and organization policy can require renewal. A retained automation token also needs maintenance. |
| GitHub App for unattended writes, temporary owner token for browser setup | Same browser authorization step; install one narrowly permissioned App on the repository for the collector. | App's private key stays in Actions Secrets; runner mints short-lived installation tokens. Avoids an expiring personal automation token. | More initial setup, another key to preserve/revoke. App registration itself still does not give the browser an authenticated token or host an endpoint. |

These are compatible: the browser token can be short-lived and revoked after setup while an App performs later automatic write-back. A fully button-driven GitHub login is a further feature, not something REST CORS alone provides. GitHub's documented OAuth App web exchange currently requires a client secret; do not publish it to make a static page work. A device-flow or Actions-assisted alternative would need its own tested design. [GitHub OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [App authentication inside Actions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow).

**Proposed default for review:** prove owner setup with a repository-scoped token first. For an installation intended to survive long dormancy, retain the GitHub App writer as the stronger maintenance option. The owner preference question remains open; neither credential has been created.

## Secret storage and rotation details

Use a dedicated **`market-collector` Actions environment** for the mutable canonical grant. GitHub reads repository/organization Secrets when a workflow is queued, but environment Secrets when the referencing job starts. With a shared concurrency group, job-start loading avoids a queued job taking the previous run's old grant. This is a documented design reason, not yet an end-to-end concurrency test. [Secret loading times](https://docs.github.com/en/actions/reference/security/secrets).

Environment Secrets use the same sealed-box encryption model as repository Secrets. Their API permission is **Environments: write**; repository Secrets use **Secrets: write**. Creating/configuring the environment itself is a separate initial administrative operation. A browser token can additionally need **Actions: write** to dispatch the adoption workflow. Limit access to this repository; these permissions are not limited to one named Secret. [Environment Secret API](https://docs.github.com/en/rest/actions/secrets#create-or-update-an-environment-secret), [Workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

Do not allow browser setup to race with an in-progress refresh. Proposed sequence:

1. Browser verifies EVE login and encrypts a pending JSON grant, with a random setup nonce, into `EVE_PENDING_GRANT` in the collector environment. GitHub requires LibSodium sealed-box encryption. No plaintext grant goes into workflow inputs.
2. Browser dispatches an owner-only adoption workflow with the **nonsecret nonce**. Adoption and all authenticated collectors use one concurrency group with cancellation disabled. The grant remains pending until the workflow succeeds; the UI must distinguish pending from connected.
3. When the job starts, it loads environment Secrets, matches the nonce and validates the pending grant against the configured application/scopes and approved collector character. A newer pending setup supersedes older requests; a nonce mismatch stops adoption.
4. Only then does the worker save the new canonical `EVE_GRANT`, remove the pending Secret, and optionally collect. Buffer the existing `EveSso.authorize`/refresh persistence callbacks during initial adoption so an unverified character cannot overwrite the canonical grant.
5. Normal refreshes write any replacement grant immediately, before subsequent ESI/collection work. If write-back fails, stop and report failure; never publish a successful run that silently lost its replacement credential. Keep grant and writer material out of cache/artifact/release paths.

There is no atomic transaction spanning EVE refresh and GitHub Secret persistence. A runner/network failure in that gap can still require owner reconnection; serialization and immediate write-back reduce the risk without eliminating it. Add masking for any replacement token before subsequent logging, and never expose it through job outputs.

GitHub's built-in `GITHUB_TOKEN` cannot supply arbitrary Secret-write authority. Use a scoped personal token or a GitHub App installation token for this operation. The App key or personal writer token remains in private Secrets. The production grant becomes canonical; an older local grant must not be assumed current after hosted refreshes. [Permissions beyond GITHUB_TOKEN](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).

This needs one reviewed encryption library for the final browser Secret writer. Prefer a packaged, pinned LibSodium implementation served with the app, not remotely loaded scripts or custom cryptographic code. **No package has been installed and no Secret writer is included in the spike.** Installation requires the owner's permission. [GitHub encryption guide](https://docs.github.com/en/rest/guides/encrypting-secrets-for-the-rest-api).

## Data storage and manual workflows

Keep runtime code in the normal branch, generated viewer/`market.json` in the Pages deployment artifact, and credentials in Secrets. Pages is a publication target, not a general appendable database. Each successful deployment supplies a complete generation.

For nonsecret catalog/history state, consider **versioned Release assets** rather than commits or cache-only persistence. Upload a new uniquely named checksummed archive, verify it, and keep the previous good archive until publication succeeds. Retain only a small bounded number. Restore by a validated generation identifier, not an unvalidated mutable filename. Archive an explicit allowlist of catalog/history/summaries/current aggregates and safe metrics; never tar the entire local state directory. Recovery must safely reject unexpected archive paths/symlinks and incompatible/corrupt manifests.

This avoids credential commits and survives cache eviction during dormancy. It creates a small data release/tag and asset-management code, so cache-only restoration remains a simpler alternative if rebuilding history is acceptable. Releases have documented asset limits; keep generation sizes and retention measured, rather than treating public storage as unlimited. [Release assets](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), [Cache eviction](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

| Workflow | Proposed behavior |
| --- | --- |
| Adopt collector grant | Owner-dispatched, serialized, validated pending-to-canonical Secret update; no secrets in inputs. |
| Resume / refresh | Manual only initially. Restore/rebuild nonsecret state, check/update SDE, authenticate and persist replacement grants, collect quotes, run bounded history work, save state, publish explicit public export. |
| Continue history | Manual bounded batches using existing resumable CLI; retain each completed batch so interruption does not restart a whole backfill. Republish summaries with the dated quote generation. |
| Publish viewer | Deploy approved viewer and selected validated snapshot. No EVE credential required. |

Separate jobs may share the same reusable Node libraries. Adoption, authenticated collection and mutable state publication need one coordinated writer; do not parallelize separate workflows that each restore an old state generation and overwrite one another. An optional cache can accelerate restores, while Release assets remain the proposed durable checkpoint. Run budgets, retention, first actual runner timings, cancellation/rotation recovery and partial-publication tests remain implementation work. Schedules stay off while mothballed.

## Local reproduction

No dependency installation is required. From the repository root:

```text
npm run backend:github-check
```

Stop the normal backend first if it owns port 4173. Open **http://localhost:4173** and run the browser checks. For credential-free checks without stopping that backend, use `npm run backend:github-check -- --port=4177`; real sign-in requires an exactly registered callback for that port.

For the optional real sign-in test, paste the **public EVE client ID**, not the secret, into the page. The existing registration must include exactly `http://localhost:4173/auth/eve/callback`. Connect EVE, select the collector character and verify the returned character name/ID. The static server merely serves the callback HTML; token exchange and signed JWT verification occur in the browser. It reads no local configuration/grant files and logs no requests. The test grant is held only in memory and disappears on Forget or reload. It is not saved to GitHub or to the working collector's private files.

Temporary PKCE verifier/state use session storage solely to survive navigation to EVE and back; they expire after ten minutes and are consumed once. Access/refresh tokens are not stored there. Errors are sanitized and no upstream bodies/token strings are rendered. This is an isolated feasibility harness, not the production admin page or a deployable copy of the market viewer.

Production needs a real static callback file under the Pages repository subpath, with relative assets and an exact corresponding EVE registration. Do not depend on Vite rewrites, hash routing or the local alias as a hosted HTTP handler. Prefer a separate production registration if changing the callback would break local use.

Run automated checks with `npm run backend:test`. Stop the spike with Ctrl+C and restart the ordinary collector with `npm run backend`.

## Decisions and remaining proof

| Decision / assumption | Selected for this spike | Alternative / remaining decision |
| --- | --- | --- |
| Shared dataset | Owner-managed collector; visitors read public data | Per-visitor accounts are outside the agreed version. |
| Browser EVE exchange | PKCE + WebCrypto; no application secret | External token broker is a fallback if future browser behavior prevents this path. |
| Initial GitHub authority | Temporary scoped owner token proposed | Owner may prefer further work on button-only GitHub login. |
| Automatic write-back | GitHub App or stored scoped token, inside Actions | App avoids personal-token renewal; owner preference still open. |
| Canonical grant location | Dedicated environment Secret proposed | Repository Secrets are simpler but their queue-time loading complicates rotation. |
| Setup versus ongoing refresh | Stage + adopt in serialized workflow proposed | Direct canonical browser writes need another reliable coordination strategy. |
| Nonsecret state | Bounded versioned Release assets proposed | Cache-only with deliberate rebuild on dormancy remains viable. |
| Implementation scope | Static browser harness, reusable browser client, tests and design | Encryption dependency, Secret writes and workflows deferred until design review. |

**Passed:** credential-free real browser access and mocked authenticated exchange/security cases. **Available for owner testing:** full browser EVE login on the registered local callback. **Still unproven:** successful live browser token exchange, actual Secret encryption/write/read-at-job-start, grant adoption/rotation under serialized queued runs, Release-state restore, Pages subpath callback, and one full GitHub collection/deployment. The serious feasibility result is positive; claiming the integrated system already works would go beyond the evidence.
