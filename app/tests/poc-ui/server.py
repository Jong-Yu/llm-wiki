"""Electron 계약 검증 전용 서버. 모든 정책·키·자료는 전달된 새 임시 폴더에 둔다."""
import socket
import sys
from pathlib import Path
import uvicorn
from tools.initialize_server import initialize_new_server
from core.modules.access.policy import AccessPolicy
from core.runtime.application import create_application

root = Path(sys.argv[1])
config = initialize_new_server(root)
policy = AccessPolicy(config["access_config"], config["tenant_root"])
app = create_application(policy)
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
sock.listen(128)
print(f"READY http://127.0.0.1:{sock.getsockname()[1]}", flush=True)
uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(sockets=[sock])
