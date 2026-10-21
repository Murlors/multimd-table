"""在独立环境验收实际 wheel 和源码包；需要当前解释器安装 maturin、mypy。"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "packages/python"


def run(*command, cwd, env=None):
    subprocess.run([str(item) for item in command], cwd=cwd, env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", default=sys.executable, help="Consumer CPython interpreter")
    parser.add_argument("--out", type=Path, default=ROOT / ".performance/python-acceptance")
    parser.add_argument("--wheel", type=Path, help="Verify an existing release wheel without rebuilding it")
    args = parser.parse_args()
    interpreter = shutil.which(args.python)
    if interpreter is None:
        parser.error(f"CPython interpreter not found: {args.python}")
    interpreter = os.path.abspath(interpreter)
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=False)
    vectors = ROOT / ".performance/python/vectors.json"
    if not vectors.is_file():
        parser.error("Run bun tooling/export-contracts.ts before Python acceptance")
    env = {**os.environ, "MULTIMD_VECTORS": str(vectors)}
    # 避免消费者从调用者的源码路径导入，所有测试都在独立环境中执行。
    env.pop("PYTHONPATH", None)
    wheels = output / "wheels"
    if args.wheel:
        wheels.mkdir()
        shutil.copy2(args.wheel.resolve(), wheels)
    else:
        run(sys.executable, "-m", "maturin", "build", "--release", "--locked", "--sdist",
            "--interpreter", interpreter, "--out", wheels, cwd=PACKAGE, env=env)
    run(sys.executable, PACKAGE / "check_wheel.py", wheels, "--out", output / "wheels.json",
        cwd=output, env=env)
    wheel, = wheels.glob("*.whl")
    artifacts = [("wheel", wheel), *[("sdist", source) for source in wheels.glob("*.tar.gz")]]
    consumer = output / "consumer"
    run(interpreter, "-m", "venv", consumer, cwd=output, env=env)
    executable = consumer / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    observations = []
    for label, artifact in artifacts:
        # wheel 安装不访问 registry；源码安装走真实 PEP 517 隔离构建。
        run(executable, "-I", "-m", "pip", "install", "--no-deps", "--force-reinstall",
            *(["--no-index"] if label == "wheel" else []), artifact, cwd=output, env=env)
        result = subprocess.run(
            [str(executable), "-I", "-c", "import json, pathlib, sys; "
             "import multimd_table._native as native; "
             "assert pathlib.Path(native.__file__).resolve().is_relative_to(pathlib.Path(sys.prefix).resolve()); "
             "print(json.dumps({'python': sys.version, 'native': native.__file__}))"],
            cwd=output, env=env, check=True, capture_output=True, text=True,
        )
        observations.append({"artifact": label, **json.loads(result.stdout)})
        run(executable, "-I", "-c", "import importlib.util; import multimd_table; "
            "assert importlib.util.find_spec('markdown_it') is None", cwd=output, env=env)
        run(executable, "-I", "-m", "unittest", "discover", "-s", PACKAGE / "tests", "-v",
            "-p", "test_core.py", cwd=output, env=env)
        run(sys.executable, "-m", "mypy", "--strict", "--no-incremental",
            "--python-executable", executable, PACKAGE / "tests/typing_consumer.py",
            cwd=output, env=env)
    # extra 单独安装，证明核心用户无需 Markdown 宿主，并验收实际发布物中的适配器。
    adapter = output / "adapter-consumer"
    run(interpreter, "-m", "venv", adapter, cwd=output, env=env)
    adapter_python = adapter / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    for label, artifact in artifacts:
        run(adapter_python, "-I", "-m", "pip", "install", "--force-reinstall",
            f"{artifact}[markdown-it]", cwd=output, env=env)
        run(adapter_python, "-I", "-m", "unittest", "discover", "-s", PACKAGE / "tests", "-v",
            "-p", "test_markdown_it.py", cwd=output, env=env)
        run(sys.executable, "-m", "mypy", "--strict", "--no-incremental",
            "--python-executable", adapter_python, PACKAGE / "tests/typing_markdown_it.py",
            cwd=output, env=env)
        observations.append({"artifact": label, "extra": "markdown-it"})
    (output / "report.json").write_text(json.dumps(observations, indent=2) + "\n", encoding="utf-8")
    print(f"Python wheel and source-package acceptance passed: {output}")


if __name__ == "__main__":
    main()
