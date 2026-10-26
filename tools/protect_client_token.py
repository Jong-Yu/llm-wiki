"""운영자가 별도로 발급한 토큰을 입력받아 새 개인 보호 파일로만 보관한다."""

import argparse
import getpass
import json
from pathlib import Path
import re
import sys

from core.runtime.client_platform import private_directory, write_new


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--token-file", type=Path, required=True)
    args = parser.parse_args(argv)
    path = args.token_file.absolute()
    if path.exists() or path.is_symlink():
        result = {"ok": False, "error": {"code": "existing_token_preserved"}}
    elif not sys.stdin.isatty():
        result = {"ok": False, "error": {"code": "interactive_terminal_required"}}
    else:
        try:
            token = getpass.getpass("Server personal token (hidden): ")
            if re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token) is None:
                raise ValueError()
            private_directory(path.parent)
            write_new(path, token.encode("ascii"))
            result = {"ok": True, "token_file": str(path), "existing_settings_changed": False}
        except (OSError, ValueError):
            result = {"ok": False, "error": {"code": "protected_token_creation_failed"}}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
