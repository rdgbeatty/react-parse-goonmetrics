"""Run fresh-process end-to-end storage/publication jobs; no pip/npm installation."""
import argparse, subprocess, tempfile, shutil, os, time, resource, json, statistics, platform, sys, gzip, random, sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODES = ["node-object-json", "node-json", "node-v8", "node-c-binary", "python-json", "python-sqlite", "python-jsondoc", "python-jsonb", "python-dbm", "python-jsondoc-rowid", "python-jsonb-rowid"]

def measured(command):
    start = time.perf_counter()
    # Files avoid wait4/PIPE deadlock when a child emits more than a pipe buffer.
    with tempfile.TemporaryFile(mode="w+t",encoding="utf8") as output, tempfile.TemporaryFile(mode="w+t",encoding="utf8") as errors:
        process = subprocess.Popen(command, stdout=output, stderr=errors, text=True)
        _, status, usage = os.wait4(process.pid, 0)
        process.returncode = os.waitstatus_to_exitcode(status)
        output.seek(0); errors.seek(0)
        stdout, stderr = output.read(), errors.read()
    if process.returncode:
        raise RuntimeError(f"{' '.join(map(str,command))}\n{stdout}\n{stderr}")
    return stdout, {"wallMs":(time.perf_counter()-start)*1000,"cpuMs":(usage.ru_utime+usage.ru_stime)*1000,"maxRssKiB":usage.ru_maxrss}

def packed(directory, names):
    start = time.perf_counter(); cpu = time.process_time()
    plain = compressed = 0
    for name in names:
        data = (directory / name).read_bytes(); plain += len(data)
        compressed += len(gzip.compress(data, compresslevel=1, mtime=0))
    return {"plainBytes":plain,"gzip1Bytes":compressed,"wallMs":(time.perf_counter()-start)*1000,"cpuMs":(time.process_time()-cpu)*1000}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--types",type=int,default=20000)
    parser.add_argument("--source-days",type=int,default=24)
    parser.add_argument("--repeats",type=int,default=3)
    parser.add_argument("--work-dir",type=Path)
    repository = ROOT.parents[2]
    state_name = ".market-poc" if (repository/".market-poc").exists() else ".market-backend"
    parser.add_argument("--output",type=Path,default=repository/state_name/"benchmarks/storage-results.json")
    parser.add_argument("--modes",default=",".join(MODES))
    args = parser.parse_args()
    if not 1 <= args.types <= 50000 or not 21 <= args.source_days <= 365 or not 1 <= args.repeats <= 10:
        parser.error("types: 1–50000; source-days: 21–365; repeats: 1–10")
    modes = args.modes.split(",")
    if any(mode not in MODES for mode in modes):
        parser.error("Unknown mode")
    if args.work_dir:
        args.work_dir.mkdir(parents=True,exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="market-storage-bench-",dir=args.work_dir))
    try:
        native = work / "native-publish"
        print("Preparing deterministic input fixtures…",flush=True)
        raw,_ = measured(["node",str(ROOT/"workload.mjs"),str(work/"input"),str(args.types),str(args.source_days)])
        fixture = json.loads(raw)
        fixture.pop("selectedTypeIds",None)
        fixture["inputBytes"] = {path.name:path.stat().st_size for path in (work/"input").glob("*.json")}
        compiler = None
        if "node-c-binary" in modes:
            _,compiler = measured(["gcc","-O3","-std=c11","-Wall","-Wextra",str(ROOT/"native-publish.c"),"-o",str(native),"-lm"])
        records, artifacts, references = [], [], {}
        for repeat in range(args.repeats):
            order = modes.copy(); random.Random(1742+repeat).shuffle(order)
            for mode in order:
                state = work/f"{mode}-{repeat}"; state.mkdir()
                for scenario in ["bootstrap","prices","history"]:
                    command = ["node",str(ROOT/"node-worker.mjs"),mode,scenario,str(work/"input"),str(state),str(native)] if mode.startswith("node-") else [sys.executable,str(ROOT/"python-worker.py"),mode,scenario,str(work/"input"),str(state)]
                    raw,metrics = measured(command)
                    result = json.loads(raw)
                    # Outside measured work: semantic equality across languages/formats, including nulls and Unicode.
                    with open(state/"public.json",encoding="utf8") as file:
                        public = json.load(file)
                    if scenario not in references:
                        references[scenario] = public
                    if public != references[scenario]:
                        raise AssertionError(f"Publication mismatch for {mode}/{scenario}")
                    records.append({"repeat":repeat,**result,**metrics})
                    print(f"{repeat+1}/{args.repeats} {mode:18s} {scenario:9s}: CPU {metrics['cpuMs']:.0f} ms, wall {metrics['wallMs']:.0f} ms, RSS {metrics['maxRssKiB']/1024:.0f} MiB",flush=True)
                names = [path.name for path in state.iterdir() if path.name != "public.json"]
                price_names = ["items","summaries"] if mode.startswith("node-") or mode == "python-json" else names
                artifacts.append({"mode":mode,"repeat":repeat,"fullState":packed(state,names),"priceRestore":packed(state,price_names)})
                shutil.rmtree(state)
        medians = []
        for mode in modes:
            for scenario in ["bootstrap","prices","history"]:
                rows = [row for row in records if row["mode"]==mode and row["scenario"]==scenario]
                medians.append({"mode":mode,"scenario":scenario,**{key:statistics.median(row[key] for row in rows) for key in ["wallMs","cpuMs","maxRssKiB","stateBytes","publicBytes"]},
                                "cpuMinMs":min(row["cpuMs"] for row in rows),"cpuMaxMs":max(row["cpuMs"] for row in rows)})
        cpu_name = next((line.split(":",1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("model name")),"unknown")
        report = {"schemaVersion":1,"generatedAt":__import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
          "environment":{"platform":platform.platform(),"cpu":cpu_name,"logicalCpus":os.cpu_count(),"python":platform.python_version(),"sqlite":sqlite3.sqlite_version,
                         "node":subprocess.check_output(["node","--version"],text=True).strip(),"temporaryRoot":str(work.parent)},
          "method":{"repeats":args.repeats,"processes":"fresh process for each job; randomized mode order per repetition",
                    "cpu":"wait4 user+system, including waited-for native child; peak RSS is max process RSS, not simultaneous tree sum",
                    "input":"local replay of ESI-shaped JSON plus installed SDE; network/download and fixture generation excluded",
                    "history":"21 retained completed days; next-day full overlapping response with last-three-day corrections; stable missing-day gaps",
                    "packaging":"gzip level 1 proxy measured separately; not an Actions zstd/network measurement",
                    "native":"Node JSON parse/normalization/binary conversion + C read/aggregate/public JSON; all charged; compiler measured separately"},
          "fixture":fixture,"nativeCompiler":compiler,"medians":medians,"runs":records,"artifacts":artifacts,"semanticEquality":True}
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,indent=2)+"\n")
        print(f"Validated all publications. Report: {args.output}")
    finally:
        shutil.rmtree(work)

if __name__ == "__main__":
    main()
