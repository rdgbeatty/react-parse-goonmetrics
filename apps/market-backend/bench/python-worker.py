"""Benchmark-only stdlib drivers: JSON, SQLite rows, SQLite JSON/JSONB documents, GNU dbm JSON."""
import sys, os, json, time, sqlite3, datetime, itertools, dbm.gnu
from pathlib import Path
from contextlib import contextmanager

MODE, SCENARIO, INPUT, STATE = sys.argv[1:5]
INPUT, STATE = Path(INPUT), Path(STATE)
STATE.mkdir(parents=True, exist_ok=True)
PHASES = {}

@contextmanager
def timed(name):
    start = time.perf_counter()
    try:
        yield
    finally:
        PHASES[name] = PHASES.get(name, 0) + (time.perf_counter() - start) * 1000

def parse(path):
    with open(path, encoding="utf8") as file:
        return json.load(file)

def text(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)

def durable(path, value):
    temporary = str(path) + ".tmp"
    with open(temporary, "w", encoding="utf8") as file:
        file.write(text(value)); file.flush(); os.fsync(file.fileno())
    os.replace(temporary, path)

fixture = parse(INPUT / "fixture.json")
AS_OF = fixture["asOfDay"] + (SCENARIO == "history")

def source_items():
    types = parse(INPUT / "catalog-input.json")["types"]
    result = []
    for type_id in fixture["selectedTypeIds"]:
        item = types[str(type_id)]
        volume = item["packagedVolumeM3"] if item["packagedVolumeM3"] is not None else item["volumeM3"]
        result.append([type_id,item["name"],1 if volume is None else volume])
    return result

def source_quotes(items):
    indexes = {item[0]: index for index, item in enumerate(items)}
    count = len(items)
    rows = [[hub, index, None, None, 0, 0, 0, 0, 0, 0, 0] for hub in range(3) for index in range(count)]
    now = datetime.datetime.fromisoformat(fixture["now"]).timestamp()
    for hub, orders in enumerate(parse(INPUT / "orders-input.json")):
        seen = set()
        for order in orders:
            if order["order_id"] in seen:
                continue
            seen.add(order["order_id"])
            index = indexes.get(order["type_id"])
            if index is None or not order["volume_remain"]:
                continue
            row = rows[hub * count + index]
            if order["is_buy_order"]:
                row[2] = order["price"] if row[2] is None else max(row[2], order["price"])
                row[4] += order["volume_remain"]
            else:
                row[3] = order["price"] if row[3] is None else min(row[3], order["price"])
                row[5] += order["volume_remain"]; row[6] += 1
                try:
                    age = now - datetime.datetime.fromisoformat(order["issued"]).timestamp()
                except (KeyError, ValueError, TypeError):
                    age = -1
                if age < 0:
                    row[10] += 1
                elif age <= 86400:
                    row[7] += 1; row[8] += order["volume_remain"]; row[9] += order["volume_total"]
    return rows

def source_history(items):
    indexes = {item[0]: index for index, item in enumerate(items)}
    output = []
    epoch = datetime.date(1970, 1, 1)
    for series in parse(INPUT / ("history-update.json" if SCENARIO == "history" else "history-input.json")):
        index = indexes.get(series["type_id"])
        if index is None:
            continue
        for row in series["history"]:
            day = (datetime.date.fromisoformat(row["date"]) - epoch).days
            if 0 <= AS_OF - day < 21:
                output.append([series["region"], index, day, row["volume"], row["average"], row["highest"], row["lowest"], row["order_count"]])
    return output

def summarize(rows, count):
    result = [[hub, index, 0, 0, 0, 0] for hub in range(3) for index in range(count)]
    for region, index, day, volume, *_ in rows:
        row = result[region * count + index]
        if 0 <= AS_OF - day < 7:
            row[2] += volume; row[4] += 1
        if 0 <= AS_OF - day < 14:
            row[3] += volume; row[5] += 1
    return [[region, index, seven if n7 == 7 else None, fourteen if n14 == 14 else None] for region, index, seven, fourteen, n7, n14 in result]

class JsonStore:
    def write(self, name, rows):
        with timed("store"):
            durable(STATE / name, rows)
    def read(self, name):
        with timed("restore"):
            return parse(STATE / name)
    def close(self):
        pass

class SqliteStore:
    def __init__(self):
        self.db = sqlite3.connect(STATE / "state.sqlite")
        self.db.execute("PRAGMA journal_mode=DELETE")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA cache_size=-65536")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS items(i INTEGER PRIMARY KEY,typeId INTEGER,name TEXT,volume REAL);
          CREATE TABLE IF NOT EXISTS quotes(hub INTEGER,i INTEGER,bid REAL,ask REAL,buyUnits INTEGER,sellUnits INTEGER,askOrders INTEGER,recentOrders INTEGER,recentUnits INTEGER,recentOriginal INTEGER,unknownIssued INTEGER,PRIMARY KEY(hub,i)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS history(region INTEGER,i INTEGER,day INTEGER,volume INTEGER,average REAL,highest REAL,lowest REAL,orderCount INTEGER,PRIMARY KEY(region,i,day)) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS summaries(region INTEGER,i INTEGER,seven INTEGER,fourteen INTEGER,PRIMARY KEY(region,i)) WITHOUT ROWID;
        """)
    def write(self, name, rows):
        with timed("store"), self.db:
            if name == "items":
                self.db.executemany("INSERT INTO items VALUES(?,?,?,?)", ((i, *row) for i, row in enumerate(rows)))
            elif name == "quotes":
                self.db.execute("DELETE FROM quotes")
                self.db.executemany("INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
            elif name == "history":
                self.db.execute("DELETE FROM history WHERE day < ?", (AS_OF - 20,))
                self.db.executemany("""INSERT INTO history VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(region,i,day) DO UPDATE SET
                  volume=excluded.volume,average=excluded.average,highest=excluded.highest,lowest=excluded.lowest,orderCount=excluded.orderCount
                  WHERE history.volume!=excluded.volume OR history.average!=excluded.average OR history.highest!=excluded.highest OR history.lowest!=excluded.lowest OR history.orderCount!=excluded.orderCount""", rows)
            else:
                self.db.execute("DELETE FROM summaries")
                self.db.executemany("INSERT INTO summaries VALUES(?,?,?,?)", rows)
    def aggregate(self):
        with timed("process"):
            return [list(row) for row in self.db.execute("""SELECT region,i,
              CASE WHEN sum(day >= ?)=7 THEN sum(CASE WHEN day >= ? THEN volume ELSE 0 END) END,
              CASE WHEN sum(day >= ?)=14 THEN sum(CASE WHEN day >= ? THEN volume ELSE 0 END) END
              FROM history GROUP BY region,i ORDER BY region,i""", (AS_OF-6, AS_OF-6, AS_OF-13, AS_OF-13))]
    def read(self, name):
        with timed("restore"):
            query = {"items": "SELECT typeId,name,volume FROM items ORDER BY i", "quotes": "SELECT * FROM quotes ORDER BY hub,i", "summaries": "SELECT * FROM summaries ORDER BY region,i"}[name]
            return [list(row) for row in self.db.execute(query)]
    def close(self):
        self.db.close()

class DocumentStore:
    def __init__(self):
        self.db = sqlite3.connect(STATE / "state.sqlite")
        self.db.execute("PRAGMA journal_mode=DELETE"); self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA cache_size=-65536")
        suffix = "" if MODE.endswith("-rowid") else " WITHOUT ROWID"
        self.db.execute("CREATE TABLE IF NOT EXISTS docs(kind TEXT,k INTEGER,body BLOB,PRIMARY KEY(kind,k))" + suffix)
        self.encode = "jsonb" if "jsonb" in MODE else "json"
    def write(self, name, rows):
        with timed("store"), self.db:
            if name == "history":
                documents = ((name, region * fixture["typeCount"] + index, text(list(group))) for (region, index), group in itertools.groupby(rows, lambda row: (row[0], row[1])))
            else:
                documents = [(name, 0, text(rows))]
            self.db.executemany(f"INSERT INTO docs VALUES(?,?,{self.encode}(?)) ON CONFLICT(kind,k) DO UPDATE SET body=excluded.body", documents)
    def aggregate(self):
        with timed("process"):
            # Exercise SQLite's actual JSON/JSONB document traversal, not a pretend JSON database.
            query = """SELECT cast(json_extract(j.value,'$[0]') AS INTEGER) AS r, cast(json_extract(j.value,'$[1]') AS INTEGER) AS i,
              CASE WHEN sum(json_extract(j.value,'$[2]') >= ?)=7 THEN sum(CASE WHEN json_extract(j.value,'$[2]') >= ? THEN json_extract(j.value,'$[3]') ELSE 0 END) END,
              CASE WHEN sum(json_extract(j.value,'$[2]') >= ?)=14 THEN sum(CASE WHEN json_extract(j.value,'$[2]') >= ? THEN json_extract(j.value,'$[3]') ELSE 0 END) END
              FROM docs d,json_each(d.body) j WHERE d.kind='history' GROUP BY r,i ORDER BY r,i"""
            return [list(row) for row in self.db.execute(query, (AS_OF-6, AS_OF-6, AS_OF-13, AS_OF-13))]
    def read(self, name):
        with timed("restore"):
            return json.loads(self.db.execute("SELECT json(body) FROM docs WHERE kind=? AND k=0", (name,)).fetchone()[0])
    def close(self):
        self.db.close()

class DbmStore:
    def __init__(self):
        self.db = dbm.gnu.open(str(STATE / "state.gdbm"), "c")
    def write(self, name, rows):
        with timed("store"):
            if name == "history":
                for (region, index), group in itertools.groupby(rows, lambda row: (row[0], row[1])):
                    self.db[f"h:{region}:{index}"] = text(list(group)).encode()
            else:
                self.db[name] = text(rows).encode()
            self.db.sync()
    def aggregate(self):
        with timed("process"):
            result = []
            for region in range(3):
                for index in range(fixture["typeCount"]):
                    seven = fourteen = n7 = n14 = 0
                    for row in json.loads(self.db[f"h:{region}:{index}"]):
                        if 0 <= AS_OF-row[2] < 7: seven += row[3]; n7 += 1
                        if 0 <= AS_OF-row[2] < 14: fourteen += row[3]; n14 += 1
                    result.append([region,index,seven if n7==7 else None,fourteen if n14==14 else None])
            return result
    def read(self, name):
        with timed("restore"):
            return json.loads(self.db[name])
    def close(self):
        self.db.close()

start = time.perf_counter()
store = JsonStore() if MODE == "python-json" else SqliteStore() if MODE == "python-sqlite" else DbmStore() if MODE == "python-dbm" else DocumentStore()
if SCENARIO == "bootstrap":
    with timed("source"):
        items = source_items()
    store.write("items", items)
else:
    items = store.read("items")
quotes = summaries = None
if SCENARIO != "history":
    with timed("source"):
        quotes = source_quotes(items)
    store.write("quotes", quotes)
if SCENARIO != "prices":
    with timed("source"):
        history = source_history(items)
    store.write("history", history)
    if hasattr(store, "aggregate"):
        summaries = store.aggregate()
    else:
        with timed("process"):
            summaries = summarize(history, len(items))
    store.write("summaries", summaries)
if quotes is None:
    quotes = store.read("quotes")
if summaries is None:
    summaries = store.read("summaries")
with timed("publish"):
    durable(STATE / "public.json", {"schemaVersion":2,"items":items,"quotes":quotes,"summaries":summaries})
store.close()
print(json.dumps({"mode":MODE,"scenario":SCENARIO,"internalWallMs":(time.perf_counter()-start)*1000,"phases":PHASES,
                  "stateBytes":sum(path.stat().st_size for path in STATE.iterdir() if path.name != "public.json"),"publicBytes":(STATE/"public.json").stat().st_size}))
