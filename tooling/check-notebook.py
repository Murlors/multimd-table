"""用当前解释器运行仓库 Notebook，并核验实际 HTML 输出；产物保留在忽略目录。"""

import argparse
import json
from pathlib import Path
import sys

from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpecManager
from nbclient import NotebookClient
import nbformat


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[1]
    path = root / "packages/python/examples/tables.ipynb"
    notebook = nbformat.read(path, as_version=4)
    nbformat.validate(notebook)
    # 固定解释器而不注册全局 kernel，确保示例使用当前安装的 wheel 和 extra。
    kernels = output / "kernels"
    spec = kernels / "multimd-table"
    spec.mkdir(parents=True)
    (spec / "kernel.json").write_text(json.dumps({
        "argv": [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        "display_name": "MultiMarkdown acceptance", "language": "python",
    }), encoding="utf-8")
    manager = KernelManager(kernel_name="multimd-table",
                            kernel_spec_manager=KernelSpecManager(kernel_dirs=[str(kernels)]))
    NotebookClient(notebook, km=manager, timeout=60,
                   resources={"metadata": {"path": str(output)}}).execute(cleanup_kc=True)
    html = "".join(item.get("data", {}).get("text/html", "")
                   for cell in notebook.cells for item in cell.get("outputs", []))
    assert 'rowspan="2"' in html and 'colspan="2"' in html
    assert "<strong>revenue</strong>" in html and ">12</td>" in html
    nbformat.write(notebook, output / "tables.ipynb")
    (output / "table.html").write_text(html, encoding="utf-8")
    print(f"Notebook execution and HTML output passed: {output}")


if __name__ == "__main__":
    main()
