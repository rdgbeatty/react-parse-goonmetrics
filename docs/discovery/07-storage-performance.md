# Storage pipeline measurements and decision

2026-11-07. [Harness and commands](../../apps/market-backend/bench/README.md), [project checklist](../../TODO.md), [data-model review](06-backend-data-model.md).

## Decision

Keep Node and split, compact JSON tables for the next backend step. Keep readable metadata/provenance envelopes, but avoid repeating field names and identities on every high-volume history row. Persist prepared 7/14-day summaries separately so a price-only job never restores or rewrites the retained daily history.

SQLite remains a credible future history store for keyed updates, resumability and transactions. These measurements do not establish a material CPU advantage that justifies introducing a production binding/runtime change now. If we adopt it, separate serving state from the large history state so hourly jobs do not restore the whole database.

Do not introduce a C worker or V8 binary state as the default on the strength of this test. The tested C path saves about a quarter of a CPU second on a daily reconciliation, while price-job results overlap or favor compact JSON. A native direct JSON decoder, tighter binary packing and different libraries remain unmeasured alternatives; this is a decision about these implementations and workload, not a universal language ranking.

## What was run

There were **111 successful measured jobs**: 81 main jobs, 12 longer-input sensitivity jobs and 18 SQLite document-layout follow-up jobs. Every publication was semantically equal within its fixture/profile. The small smoke run was additional validation. No packages were installed: Node, Python/SQLite/JSONB, GNU dbm and GCC were already present.

The main profile used:

- 20,000 item types and 60,000 hub/type quote rows.
- 447,144 input orders: 381,748 replayed from available local ESI caches and 65,396 synthetic fill orders.
- The installed official SDE catalog, plus 268 explicit synthetic stress types needed to reach 20,000 marketable types.
- 60,000 region/type history series; 24 source days and **1,259,379 retained daily records** after stable missing-date gaps.
- About 103.8 MB of order JSON, 151.9 MB per history response fixture and 7.64 MB of catalog input.
- Three repetitions, fresh processes per job and deterministic randomized candidate order.

The host was an Intel i9-14900KF under WSL2/Linux, Node 18.19.1, Python 3.12.3 and SQLite 3.45.1, with temporary state on Linux `/tmp`. These are **local measurements**, not GitHub runner measurements.

The timed path includes local JSON input read/parse, normalization, order aggregation, conversion into the candidate format, durable persistence, relevant restore/query, 7/14-day summaries and durable customer JSON publication. Network/SSO, fixture generation, SDE downloading/decompression and GitHub cache transport are excluded. This is the complete local processing path after download, not an internet-ingest latency test. The input reader is an eager coalesced replay; production per-response streaming can reduce memory and change allocation costs.

## Main CPU results

Median **CPU seconds**, including process startup and waited-for C children:

| Implementation | Bootstrap | Price refresh | Daily history |
| --- | ---: | ---: | ---: |
| Node named-field JSON adapter | 8.791 | 1.235 | 5.667 |
| **Node compact JSON** | **3.873** | **1.073** | **2.183** |
| Node V8 binary serialization | 4.618 | 1.065 | 2.509 |
| Node JSON adapter → fixed-width binary → C publication | 3.787 | 1.120 | 1.933 |
| Python compact JSON control | 6.655 | 1.393 | 5.488 |
| Python + relational SQLite | 6.640 | 1.438 | 5.215 |
| Python + SQLite JSON documents, WITHOUT ROWID | 10.482 | 1.458 | 7.732 |
| Python + SQLite JSONB documents, WITHOUT ROWID | 10.162 | 1.414 | 7.686 |
| Python + indexed GNU dbm JSON documents | 7.709 | 1.373 | 6.034 |

SQLite is accessed through the installed Python standard library. Compare its storage-engine effect against the Python JSON control; the Node-versus-Python difference is not a measurement of SQLite itself. A Node SQLite binding has not been measured or installed.

The named-field JSON adapter includes converting the common row representation to/from objects. A purpose-built object-processing implementation could avoid some of that cost. The comparison to use for the binary-format decision is compact JSON versus V8/native binary, which operate on the same common row model.

The C path includes Node parsing/normalization, numeric binary encoding, child startup, C reads/processing and C JSON output. Compiler time is separate: **0.108 CPU seconds / 0.275 elapsed seconds** in the main run. Charging compilation to a fresh cold job removes its small bootstrap advantage. The numeric binary format uses LE float64 matrices; it is not a bit-packed or column-compressed implementation. C's standard `%.17g` number formatting produces semantically equal but sometimes larger JSON than JavaScript's shortest-number output. A different native codec/JSON writer could change these results.

## Elapsed time and memory

Median **elapsed seconds** for selected implementations:

| Implementation | Bootstrap | Price refresh | Daily history |
| --- | ---: | ---: | ---: |
| Node compact JSON | 2.982 | 0.964 | 1.888 |
| Node V8 binary | 3.227 | 0.952 | 1.861 |
| Node/C binary | 2.846 | 1.011 | 1.599 |
| Python compact JSON control | 6.838 | 1.445 | 5.827 |
| Relational SQLite via Python | 6.878 | 1.489 | 5.346 |

Node can use multiple threads for GC/runtime work, so CPU seconds can exceed elapsed seconds. Main-run bootstrap peak process RSS was approximately 633 MiB for compact Node JSON, 635 MiB for Node/C, 942 MiB for SQLite/Python and 988 MiB for the Python JSON control. Large eager source decoding dominates those peaks. Native parent/child RSS is not summed; these numbers do not imply production streaming requires that memory.

For compact Node JSON, the price job spent roughly 0.74 elapsed seconds parsing/reducing the order replay, 0.013 seconds restoring metadata/summaries, 0.031 seconds persisting quotes and 0.057 seconds publishing. A faster persistent representation has little restore work left to eliminate. During daily history, source normalization and full retained-window writing dominate; summing the retained rows is only about 0.06–0.07 elapsed seconds in this implementation.

## Storage and the artifact-restore tradeoff

State after reconciliation; decimal MB. Gzip level 1 is a measured proxy, not Actions' actual zstd/network behavior.

| Representation | Raw state MB | Gzipped full state MB | Gzipped logical price restore MB |
| --- | ---: | ---: | ---: |
| Named-field JSON adapter | 164.98 | 8.82 | 0.77 |
| **Compact JSON** | **61.65** | **6.63** | **0.44** |
| V8 binary | 102.34 | 6.97 | 0.48 |
| Fixed-width binary/C | 88.72 | 6.72 | 0.49 |
| Relational SQLite, single file | 59.67 | 9.07 | 9.07 |
| SQLite JSON documents, WITHOUT ROWID | 160.80 | 9.19 | 9.19 |
| SQLite JSONB documents, WITHOUT ROWID | 167.71 | 9.45 | 9.45 |
| GNU dbm JSON documents, single file | 72.51 | 9.05 | 9.05 |

The compact JSON candidate uses separate catalog/quote/history/summary files. A price refresh restores only catalog and summaries; its complete order input supplies new quotes. The database candidates use a single file, so restoring that artifact also restores retained daily history even though the query need not read it. Splitting SQLite into serving/history files would address this; the table is not a reason to reject SQLite's capabilities.

Full-state packaging CPU was approximately 0.185 seconds for compact JSON, 0.213 for the fixed-width binary and 0.243 for relational SQLite. Real Actions artifact compression, transfer, checkout, startup and provider HTTP latency still need measurement. Do not turn the local CPU table into a billing forecast.

## Database-layout follow-up

The initial document candidates used WITHOUT ROWID, which is inappropriate for some larger document rows. SQLite's own guidance favors that optimization for small rows and recommends testing larger strings/BLOBs separately. [SQLite guidance](https://www.sqlite.org/withoutrowid.html).

An additional three-repetition run used ordinary rowid document tables with the **same fixture**:

| Document layout | Bootstrap CPU s | Price CPU s | Daily CPU s | Raw state MB | Gzip MB |
| --- | ---: | ---: | ---: | ---: | ---: |
| JSON text, ordinary rowid | 9.413 | 1.582 | 7.927 | 68.69 | 8.40 |
| JSONB, ordinary rowid | 8.709 | 1.513 | 7.889 | 68.62 | 8.63 |

Changing table layout removed much of the space penalty. It did not create a CPU advantage over the typed relational layout or the Python JSON control in this document/query design. This is why the recommendation should not be “JSON databases are slow.” [SQLite JSON/JSONB documentation](https://www.sqlite.org/json1.html).

## Longer upstream history sensitivity

A separate **single-repetition** profile used 2,000 types, three regions, **365 source days** and the same 21-day retention policy. Each source-history fixture was about 222 MB, but retained state had only 125,937 daily rows. This is a sensitivity check, not a three-run median or measured actual ESI coverage.

| Implementation | Bootstrap CPU s | Price CPU s | History CPU s |
| --- | ---: | ---: | ---: |
| Node compact JSON | 2.529 | 0.303 | 2.188 |
| Node/C binary | 2.029 | 0.264 | 2.075 |
| Python JSON control | 2.862 | 0.189 | 2.825 |
| Relational SQLite via Python | 3.161 | 0.198 | 2.911 |

The C path benefits in that particular cold run, but the daily result is close because incoming JSON still has to be decoded. Retaining fewer dates does not remove source parsing or the per-region/type request fan-out. ESI has no last-three-days filter. A production daily refresher should process one response at a time and remain resumable instead of coalescing all annual responses into memory.

## SDE scope

The SDE cost shared by every candidate was left out as requested. The benchmark does parse the installed catalog during initialization. HTTP byte ranges locate the `types.jsonl` **member within CCP's ZIP**; they are not a property of JSON that prevents choosing a binary/database internal store. Changing local storage does not change CCP's compressed source member.

## Data model resulting from the measurements

1. Keep identities/provenance explicit and stable: type ID, hub/location, region and completed UTC date.
2. Use compact row storage for the large daily history table, with a declared column schema and version. Keep metadata readable. Benchmark any conversion at the read/write boundary.
3. Persist current quote/competition summaries and prepared demand summaries separately from retained daily history.
4. Keep the public viewer JSON independent of backend storage. The column-oriented benchmark payload is not automatically the production viewer contract.
5. Retain raw orders only in job memory, deduplicate transiently, reduce them, then discard them. Store no individual-order history or depth archive.
6. Use `issued` directly for the current 24-hour ask-activity window; retain the aggregate window timestamp. Do not infer age by rounding remaining duration.
7. Expose recent order count, remaining units and original listed units as distinct proxies. No seller identity is present in the public book, so these are not distinct-seller counts or verified new imports. The exact repricing interpretation of `issued` still needs an owner-controlled check before a stronger “updated” label. [ESI schema](https://esi.evetech.net/meta/openapi.json).
8. Keep ask-to-ask economics: destination ask less sale expenses, Jita ask and packaged-volume shipping. Multiply by a labeled weekly-equivalent regional demand reference for the opportunity estimate. Fourteen-day volume should be divided by two for that weekly rate.

The [project TODOs](../../TODO.md) track the remaining persistent-history adapter, operational refresh jobs, GitHub state/grant handling, Actions and frontend review.

## Raw aggregate measurements

- [Main profile: 81 jobs](benchmarks/storage-linux-2026-11-07.json)
- [365-day input sensitivity: 12 jobs](benchmarks/storage-annual-input-2026-11-07.json)
- [Document rowid layouts: 18 jobs](benchmarks/storage-document-layout-2026-11-07.json)

These files contain timings, sizes, environment and fixture counts, not raw order books or character credentials. Successful benchmark temporary files are deleted by the runner; incomplete fixtures from harness development were also cleaned up.

The updated application suite passes **45 tests**, including issued-time boundaries, unknown timestamps, aggregate-only cache persistence/reuse, raw-route cache protection, legacy cleanup, weekly-equivalent flow and the reference benchmark model. The cleanup removed 462 legacy raw-order page files (107,241,495 bytes); history/catalog/grants and published aggregate snapshots were retained. Restart the local backend and collect again to generate competition fields in the current snapshot. Rendering/ranking those fields is a later frontend task.
