"""检查实际 wheel 的运行时边界，并保存逐文件体积与发布包指纹。"""

import argparse
from email.parser import Parser
import hashlib
import json
from pathlib import Path
import zipfile


def inspect(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        metadata_name = next(name for name in names if name.endswith(".dist-info/METADATA"))
        metadata = Parser().parsestr(archive.read(metadata_name).decode("utf-8"))
        assert metadata["Name"] == "multimd-table"
        assert not metadata.get_all("Requires-Dist"), "Core wheels must have no Python runtime dependencies"
        native = [name for name in names if name.endswith((".so", ".pyd"))]
        assert len(native) == 1 and native[0].startswith("multimd_table/_native.")
        for name in names:
            assert name.startswith(("multimd_table/", "multimd_table-")), name
            assert not name.endswith((".wasm", ".pyc", ".rs", ".whl")), name
        for name in ["multimd_table/py.typed", "multimd_table/_native.pyi", "multimd_table/types.py"]:
            assert name in names, f"Missing type information: {name}"
        assert any(name.endswith(".dist-info/licenses/LICENSE") for name in names)
        return {
            "wheel": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "archiveBytes": path.stat().st_size,
            "unpackedBytes": sum(item.file_size for item in archive.infolist()),
            "nativeBytes": archive.getinfo(native[0]).file_size,
            "runtimeDependencies": metadata.get_all("Requires-Dist", []),
            "files": [{"path": item.filename, "bytes": item.file_size} for item in archive.infolist()],
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    wheels = sorted(args.directory.glob("*.whl"))
    assert wheels, "No wheels found"
    reports = [inspect(path) for path in wheels]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as output:
        json.dump(reports, output, indent=2)
    for report in reports:
        print(f'{report["wheel"]}: wheel {report["archiveBytes"]} B; native {report["nativeBytes"]} B; no runtime dependencies')
