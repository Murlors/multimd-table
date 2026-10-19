"""完整 Python 调用基准；无纯 Python 解析器对照，不声称任何加速比例。"""
import gc
import hashlib
import json
from pathlib import Path
import platform
import statistics
import sys
import time
from python import Core

core = Core()
fixtures = json.load(open(sys.argv[1], encoding="utf8"))
rows = []
for fixture in fixtures:
    for operation in ("parse", "write") if fixture["id"] in ("plain-1000", "rich-1000") else ("parse",):
        source, options = fixture["source"], fixture["options"]
        model = core.parse_table(source, options)
        call = (lambda: core.parse_table(source, options)) if operation == "parse" else (lambda: core.stringify_table(model))
        expected = [len(section["rows"]) for section in model["sections"]] if model else None
        assert expected == fixture["rows"]
        gc.collect()
        until = time.perf_counter() + 0.5
        while time.perf_counter() < until:
            result = call()
        samples = []
        for _ in range(7):
            count, start = 0, time.perf_counter()
            while time.perf_counter() - start < 0.04:
                result = call()
                count += 1
            samples.append((time.perf_counter() - start) * 1000 / count)
        rows.append({"id": f"{operation}/{fixture['id']}", "samples": samples, "medianMs": statistics.median(samples)})
report = {
    "python": sys.version, "platform": platform.platform(), "arch": platform.machine(),
    "librarySha256": hashlib.sha256(core.library_path.read_bytes()).hexdigest(),
    "fixtureSha256": hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest(),
    "profile": "single-process-observation", "warmupMs": 500, "measurements": rows,
}
path = Path(sys.argv[2])
with path.open("x", encoding="utf8") as output:
    json.dump(report, output, indent=2)
print(json.dumps(report, indent=2))
