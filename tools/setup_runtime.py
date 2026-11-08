"""사용자가 선택한 Python으로 프로젝트 전용 환경과 잠긴 의존성을 설치한다."""

import argparse
from hashlib import sha256
import json
import os
import subprocess
import sys
import venv

from core.paths import PROJECT_DIR
from core.runtime.client_platform import project_python


def install(*, role, upgrade=False):
    if sys.version_info < (3, 12):
        raise ValueError("python_3_12_required")
    if role == "server" and os.name != "posix":
        raise ValueError("server_requires_posix_use_wsl2")
    if role == "server" and sys.platform == "linux":
        from core.runtime.server_filesystem import check_linux_paths
        check_linux_paths([PROJECT_DIR])
    lock = PROJECT_DIR / ".runtime-install.lock"
    # 여러 창의 설치가 겹치면 진행하지 않는다. 다른 실행의 잠금은 지우지 않는다.
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.close(descriptor)
        directory = PROJECT_DIR / ".venv"
        python = project_python(PROJECT_DIR)
        if directory.exists():
            if directory.is_symlink() or not (directory / "pyvenv.cfg").is_file() or not python.is_file():
                raise ValueError("existing_environment_invalid_preserved")
        else:
            venv.EnvBuilder(with_pip=True).create(directory)
        subprocess.run([str(python), "-c",
            "import sys,pathlib; sys.exit(0 if sys.version_info >= (3,12) and pathlib.Path(sys.prefix).resolve() == pathlib.Path(sys.argv[1]).resolve() else 1)",
            str(directory)], check=True)
        arguments = [str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", "-r", str(PROJECT_DIR / "requirements.lock")]
        if upgrade:
            arguments.append("--upgrade")
        subprocess.run(arguments, check=True, stdout=sys.stderr)
        subprocess.run([str(python), "-m", "pip", "check"], check=True, stdout=sys.stderr)
        return {"ok": True, "role": role, "python": str(python),
                "requirements_sha256": sha256((PROJECT_DIR / "requirements.lock").read_bytes()).hexdigest(),
                "next": ["-m tools.runtime_doctor", "-m tools.source_conversion_cli --diagnose"] if role == "personal" else ["-m core.runtime.http_cli --help"]}
    finally:
        lock.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--role", choices=("personal", "server"), required=True)
    parser.add_argument("--upgrade", action="store_true", help="Reinstall only the versions pinned in requirements.lock.")
    args = parser.parse_args(argv)
    try:
        result = install(role=args.role, upgrade=args.upgrade)
    except FileExistsError:
        result = {"ok": False, "error": {"code": "runtime_install_busy"}}
    except ValueError as error:
        result = {"ok": False, "error": {"code": str(error)}}
    except (OSError, subprocess.SubprocessError):
        result = {"ok": False, "error": {"code": "runtime_install_failed_environment_preserved"}}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
