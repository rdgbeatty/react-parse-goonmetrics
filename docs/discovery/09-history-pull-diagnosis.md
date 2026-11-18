# History pull diagnosis and predictable batches

Diagnosed on 2026-11-09 UTC from the owner's three persisted local run reports. Existing grant, configuration, retained data and public snapshot were inspected read-only and retained; no live backfill was launched during diagnosis.

## Evidence

| Run start (UTC) | Kind | Successful history pairs | Failed | Stop reason |
| --- | --- | ---: | ---: | --- |
| Nov 8, 05:42 | History | 5,160 | 0 | Normal five-minute time budget. |
| Nov 9, 02:33 | Quotes + history | 1,878 | 3 | Three consecutive 404s for type 12190. |
| Nov 9, 04:52 | History | 0 | 3 | The same type 12190 was retried first; stopped after about 2.5 seconds. |

All three failing region/type pairs were **Omber Processing**, type **12190**, in The Forge (`10000002`), Heimatar (`10000030`) and Insmother (`10000009`). A minimal public recheck returned `404 {"error":"Type not found!"}` for type 12190, while Tritanium's history returned 200 with 403 records and a healthy error budget. These requests used a generic diagnostic identifier without a saved contact value or character token.

The installed SDE labels Omber Processing `published: false`. The current Jita snapshot nevertheless includes a sell order for four units. This demonstrates that quote presence and history availability need separate treatment; filtering unpublished items out of the table would discard actual quotes. There are **29 unpublished quoted types**, including the next four mining-processing skills in ID order and expired event items. The unpublished flag is consistent with the observed failure, rather than proof of a universal API rule.

Retained-state verification found **7,080 records**, including the three failed records, **73,387 daily rows**, **zero summary mismatches** and no pending checkpoint files. **7,077 of 57,135 active pairs** had successfully collected history at least once; **1,878** were still fresh and **50,058** had never successfully collected. Integrity checks found no evidence of lost successful data.

## Why the collector stalled

1. The collector alternated regions for each item. One unsupported item therefore generated three adjacent regional 404s.
2. Every failure incremented the same global consecutive-failure counter. Three item-specific errors were mistaken for a source-wide problem.
3. Failed requests had a five-minute retry delay. Once that elapsed, the never-successfully-fetched item returned to the front of the queue, causing the next run to stop on the same item.
4. Error classification searched message text for `history`. That word also appeared in the request URL, so HTTP failures were misleadingly labeled `invalid-data`.
5. “Pending” combined never-fetched, expired and failed data. This explains why it rose from 51,939 to 55,257 after a daily expiry: successful old history had become eligible for refresh, rather than disappearing.
6. Never-fetched pairs came before expired successful pairs. Thus the second run inserted new series instead of exercising daily updates against the first run. Automatic completion can finish backfill and reach those older entries; the UI now separates backfill coverage from freshness.

The three simultaneous workers were not evidence of excessive parallelism. The logs show no 420/429 responses, network retries or authentication errors in these history runs. The observed productive rate was roughly **17 region/item pairs per second**, implying around a minute per 1,000-pair batch and roughly an hour for a complete initial pass at similar speed. This is an estimate from local source timings, not a guarantee.

## Owner decisions and implemented behavior

- Up to **1,000 region/item attempts and 1,000 actual outbound HTTP requests per batch**, with the existing **300-second safety limit**. Retries consume the outbound cap. These are pairs/requests, not 1,000 types multiplied by three regions.
- The local UI automatically continues through batches. Each batch checkpoints, compacts, publishes and saves its own numbered report. **Pause after this batch** finishes the current batch; **Resume history** continues saved work, including after browser or backend restart. Closing the browser does not stop a running server pass.
- Item-specific 404s defer that pair for **24 hours** and continue with other items. Its quote row and any previous successful history remain available. No hardcoded item blacklist or broad quote filter was introduced.
- The diagnostics page lists deferred item names/IDs, regions, reason, first recorded failure, elapsed deferred time, latest attempt, next retry and failure count. Repeated failures preserve the first timestamp; successful recovery clears the current deferral.
- Earlier 404 evidence is recovered from the existing run reports when old records lack a first-failure timestamp. Their old report finish time is the available timestamp resolution. Those records are upgraded when next processed; no retrospective source-data rewrite is needed.
- A pass remembers handled pairs, so cache expiry during a long pass does not make it loop over already handled items. A later new pass reevaluates expiry and deferred retry dates. Resume completes the saved pass; it does not run a permanent daily scheduler.
- Real rate-limit signals, low remaining budgets and repeated systemic failures still stop the pass safely. Budget headers are checked on error responses too. Deferring 404s must not bypass ESI's shared error limit. See [CCP's rate-limit guidance](https://developers.eveonline.com/docs/services/esi/rate-limiting/).
- Old state and credentials remain in the existing ignored directory. The fix requires a backend restart and page reload. No package installation or GitHub push is needed.

The new diagnostics distinguish **ever collected**, **currently fresh**, **eligible for a request**, and **waiting for retry**. Deferred entries remain visible when their retry time arrives, labeled eligible on the next pass.

## Commands

```text
npm run backend
npm run backend:history                         # one bounded batch
npm run backend:history -- --all                # automatic pass
npm run backend:history -- --resume             # resume a saved pass
npm run backend:history:verify                  # local integrity check
npm run backend:test
```

The CLI and local UI use the same refresher/session code. No production collection is triggered merely by starting the server. Session metadata is stored under `history/session/`; numbered batch reports remain in `metrics/runs/`. Source records contain the first-deferral timestamp and consecutive failure count. Legacy report categories are preserved as historical evidence; newly processed 404s use `not-found`.

## Validation

All 63 backend tests passed; the final HTTP-level 404/batch regressions also passed separately. Installed Chrome passed the complete 404 → next batch → pause → browser reload → resume → completion workflow, including two-day deferral ages imported from legacy reports and numbered batch reports. The lifecycle benchmark smoke test also passed.

Regression coverage reproduces the three-region 404 trap, verifies that later items are collected, checks 24-hour skip/retry and multi-day deferral ages, preserves old history through failures, confirms recovery clears deferrals, tests 1,000-pair chunk boundaries and hard retry caps, and checks pause/restart/resume without duplicate requests. Tests also stop on genuinely low ESI error budgets and distinguish item-specific `Type not found!` from region/route 404 failures.

The owner dataset remains unchanged by automated tests. All mutation tests and browser checks use temporary synthetic state. No full live rerun has been started on the owner's behalf; the next local collection will exercise the fix with actual ESI responses.
