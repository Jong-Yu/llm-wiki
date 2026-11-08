"""명시한 새 서버 폴더에만 빈 정책·자료 루트와 암호화 키를 준비한다.

기존 서버의 시작/오류 복구에서는 호출하지 않는다. 생성 실패 시에도 기존
파일이나 이번에 남은 증거를 삭제하지 않으며 경로를 재사용해 덮어쓰지 않는다.
"""

import argparse
import json
import os
from pathlib import Path

from core.modules.access.auth import initialize_auth
from core.modules.access.policy import AccessPolicy, PolicyError


def initialize_new_server(root):
    root = Path(root).absolute()
    # 부모 경로는 이미 있어야 한다. 별칭 경로를 통한 기존 서버 접근도 피한다.
    if root.parent.resolve(strict=True) != root.parent or root.is_symlink():
        raise ValueError("Select a new directory under an existing unaliased parent.")
    root.mkdir(mode=0o700, exist_ok=False)
    data = root / "data"
    data.mkdir(mode=0o700)
    private = root / ".local"
    private.mkdir(mode=0o700)
    tenancy = private / "tenancy"
    tenancy.mkdir(mode=0o700)
    config = tenancy / "access.json"
    descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump({"version": 1, "tenants": {}, "users": {}}, stream)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    policy = AccessPolicy(config, data)
    initialize_auth(policy, key_path=tenancy / "credential.key")
    return {"access_config": str(config), "tenant_root": str(data)}


def main():
    parser = argparse.ArgumentParser(description="Initialize an explicitly selected NEW server directory; never repair an existing server.")
    parser.add_argument("--server-root", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = initialize_new_server(args.server_root)
    except (OSError, ValueError, TypeError, PolicyError):
        parser.error("Initialization failed; existing or partially created files were preserved. Select a new protected server directory.")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
