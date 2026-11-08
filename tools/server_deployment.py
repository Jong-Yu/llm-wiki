"""명시한 Linux/WSL2 대상의 배포 묶음 생성과 읽기 전용 사전 점검.

prepare는 새 폴더만 생성한다. 서비스 설치/시작, 인증서 발급, 방화벽,
운영 자료/정책 변경은 수행하지 않는다. inspect는 대상 Linux에서 실행한다.
"""
import argparse
from hashlib import sha256
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys

from core.runtime.client_platform import private_directory, write_new
from core.runtime.server_filesystem import check_linux_paths

REQUIRED = {"schema_version", "service_name", "service_user", "project_dir", "tenant_root",
            "access_config", "https_host", "listen_address", "tls_cert", "tls_key", "proxy_user"}
OPTIONAL = {"port", "https_port", "ruleset_root", "ruleset_policy", "wsl_distribution", "wsl_user"}
PATHS = ("project_dir", "tenant_root", "access_config", "tls_cert", "tls_key", "ruleset_root", "ruleset_policy")


def validate(value):
    if not isinstance(value, dict) or not REQUIRED <= value.keys() or value.keys() - REQUIRED - OPTIONAL:
        raise ValueError("invalid_deployment_fields")
    config = {"port": 8766, "https_port": 443, **value}
    if type(config["schema_version"]) is not int or config["schema_version"] != 1:
        raise ValueError("invalid_schema_version")
    for field in ("service_name", "service_user", "proxy_user"):
        if not isinstance(config[field], str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,47}", config[field]) or config[field] == "root":
            raise ValueError("invalid_service_identity")
    for field in PATHS:
        path = config.get(field)
        if path is None and field in OPTIONAL:
            continue
        # These values enter systemd/Caddy/PowerShell templates, never a shell eval.
        if not isinstance(path, str) or not path.startswith("/") or path == "/" or any(ch in path for ch in '\r\n\0\\"%$`{}'):
            raise ValueError("invalid_linux_path")
        pure = PurePosixPath(path)
        if ".." in pure.parts or str(pure) != path or path.startswith(("/mnt/", "/media/")):
            raise ValueError("linux_filesystem_path_required")
    if bool(config.get("ruleset_root")) != bool(config.get("ruleset_policy")):
        raise ValueError("ruleset_pair_required")
    tenant = PurePosixPath(config["tenant_root"])
    for field in ("access_config", "tls_cert", "tls_key", "ruleset_policy"):
        if config.get(field):
            path = PurePosixPath(config[field])
            if tenant == path or tenant in path.parents:
                raise ValueError("configuration_must_be_outside_tenant_data")
    host = config["https_host"]
    if not isinstance(host, str) or len(host) > 253 or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host):
        raise ValueError("explicit_dns_host_required")
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in host.split(".")):
        raise ValueError("explicit_dns_host_required")
    if not isinstance(config["listen_address"], str):
        raise ValueError("explicit_listen_address_required")
    address = ipaddress.ip_address(config["listen_address"])
    if address.is_unspecified or address.is_multicast:
        raise ValueError("explicit_listen_address_required")
    for field in ("port", "https_port"):
        if type(config[field]) is not int or not 1 <= config[field] <= 65535:
            raise ValueError("invalid_port")
    if config["port"] == config["https_port"]:
        raise ValueError("ports_must_differ")
    if bool(config.get("wsl_distribution")) != bool(config.get("wsl_user")):
        raise ValueError("wsl_identity_pair_required")
    if config.get("wsl_distribution"):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", config["wsl_distribution"]) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", config["wsl_user"]):
            raise ValueError("invalid_wsl_identity")
    return config


def load(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_configuration_field")
            result[key] = value
        return result
    if path.stat().st_size > 16384:
        raise ValueError("configuration_limit")
    return validate(json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=pairs))


def quote(value):
    return json.dumps(str(value), ensure_ascii=False)


def render(config):
    c = validate(config)
    name, project = c["service_name"], c["project_dir"]
    installed = "/etc/llm-wiki/" + name
    arguments = [project + "/.venv/bin/python", "-B", "-m", "core.runtime.http_cli",
                 "--access-config", c["access_config"], "--tenant-root", c["tenant_root"], "--port", str(c["port"])]
    if c.get("ruleset_root"):
        arguments += ["--ruleset-root", c["ruleset_root"], "--ruleset-policy", c["ruleset_policy"]]
    common = "NoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nUMask=0077\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillMode=control-group\n"
    backend = ("[Unit]\nDescription=LLM Wiki authenticated API and MCP\nAfter=network.target\n\n[Service]\nType=simple\n"
        + "User=" + c["service_user"] + "\nWorkingDirectory=" + quote(project) + "\n"
        + "ExecStart=" + " ".join(map(quote, arguments)) + "\n" + common
        + "ReadWritePaths=" + quote(c["tenant_root"]) + " " + quote(str(PurePosixPath(c["access_config"]).parent))
        + "\n\n[Install]\nWantedBy=multi-user.target\n")
    proxy = ("[Unit]\nDescription=LLM Wiki explicit TLS reverse proxy\nAfter=network-online.target " + name + ".service\nWants=network-online.target\n\n"
        + "[Service]\nType=simple\nUser=" + c["proxy_user"] + "\n"
        + "ExecStart=/usr/bin/caddy run --config " + installed + "/Caddyfile --adapter caddyfile\n"
        + common + "AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n"
        + "StateDirectory=" + name + "-https\nStateDirectoryMode=0700\n"
        + "Environment=XDG_DATA_HOME=/var/lib/" + name + "-https\n"
        + "Environment=XDG_CONFIG_HOME=/var/lib/" + name + "-https\n"
        + "\n[Install]\nWantedBy=multi-user.target\n")
    caddy = ("{\n    admin off\n    auto_https off\n}\n\nhttps://" + c["https_host"] + ":" + str(c["https_port"]) + " {\n"
        + "    bind " + c["listen_address"] + "\n    tls " + quote(c["tls_cert"]) + " " + quote(c["tls_key"]) + "\n"
        + "    reverse_proxy 127.0.0.1:" + str(c["port"]) + " {\n        header_up Host 127.0.0.1:" + str(c["port"]) + "\n        flush_interval -1\n    }\n}\n")
    operations = f"""# {name} 검토 후 적용 절차

이 묶음은 설치/기동하지 않았습니다. 관리자와 대상 경로를 확인한 Linux/WSL2에서만 진행하세요.
운영 정책·자료·인증서/개인 키는 포함하지 않습니다. 토큰을 명령 인자/로그에 넣지 마세요.

1. Ubuntu에 Python 3.12+/venv와 공식 Caddy를 설치하고 두 서비스 사용자를 확인합니다.
   기존 Python 환경을 보존한 채 프로젝트에서 `python3 -B -m tools.setup_runtime --role server`를 실행합니다.
2. 코드·tenant·정책·규약을 WSL Linux filesystem에 두고 아래 사전 점검을 실행합니다.
   명령은 실제 운영 서비스 사용자로 실행하며, proxy_user의 인증서 읽기 권한은 별도 확인합니다.
   `cd {shlex.quote(project)}`
   `.venv/bin/python -B -m tools.server_deployment inspect --config /검토한/deployment.json`
   오류가 있으면 적용하지 않습니다. backend는 단일 worker/loopback이며 저장 권한을 자동 승격하지 않습니다.
3. 변경 전 현재 service unit, enable/active 상태, reverse proxy 설정, wsl.conf와 Windows 작업 스케줄러 항목을
   비서비스 개인 백업 디렉터리에 전체 보존하고 SHA256을 기록합니다. tenant 이동은 이 도구 범위가 아닙니다.
   기존 이름/설정이 존재하면 덮어쓰지 말고 차이를 검토하세요. 아래 명령은 새 경로에만 설치합니다.
   `sudo mkdir -m 0755 {installed}` (상위 /etc/llm-wiki는 먼저 준비; 이미 존재하면 중단)
   `sudo cp --no-clobber Caddyfile {installed}/Caddyfile`
   `sudo cp --no-clobber {name}.service {name}-https.service /etc/systemd/system/`
   `sudo chmod 0644 {installed}/Caddyfile /etc/systemd/system/{name}.service /etc/systemd/system/{name}-https.service`
   각 설치 파일을 manifest SHA256과 대조합니다. 기존 파일 때문에 복사가 생략되면 중단합니다.
4. TLS 인증서가 {c['https_host']}를 포함하고 유효한지, 개인 키와 일치하는지, 클라이언트에서 신뢰하는지 확인합니다.
   이 도구는 ACME/자체 CA 발급·DNS·공유기·Windows 방화벽 변경을 실행하지 않습니다.
   `sudo -u {c['proxy_user']} /usr/bin/caddy validate --config {installed}/Caddyfile --adapter caddyfile`
   `sudo systemd-analyze verify /etc/systemd/system/{name}.service /etc/systemd/system/{name}-https.service`
5. 확인한 범위만 적용합니다: `sudo systemctl daemon-reload`
   `sudo systemctl enable --now {name}.service {name}-https.service`
   `systemctl is-active {name}.service {name}-https.service`
6. 서버와 다른 PC에서 각자의 보호 토큰으로 실제 읽기 진단을 실행합니다:
   `.venv/bin/python -B -m tools.runtime_doctor --skip-ai --server https://{c['https_host']}:{c['https_port']} --token-file /개인/보호/server.token --tenant 허용tenant --profile 허용profile`
   API/MCP 인증·주체·정책·소속을 대조합니다. HTTPS 실패를 --insecure/HTTP 전환으로 우회하지 마세요.
   기존 서버의 Origin 검사는 유지되므로 일반 브라우저 cross-origin 접속을 허용하지 않습니다.
7. WSL2에서는 기존 /etc/wsl.conf의 [boot] systemd=true를 보존·병합한 후 계획된 WSL 재시작을 합니다.
   systemd enable은 Windows 부팅 시 WSL을 시작한다는 뜻이 아닙니다. 아래 startup-wsl.ps1을 해당 배포판 소유 Windows
   계정의 작업 스케줄러에서 시작 시 실행하도록 별도 등록하고, 로그온 여부/자격을 명시적으로 정합니다.
   자동 로그인이나 SYSTEM 계정 전환을 추정하지 않습니다. 전경 sleep이 WSL 실행을 유지합니다.
   실제 Windows 재부팅→서비스 active→다른 PC HTTPS API/MCP 도달까지 확인해야 자동시작 완료입니다.

## 되돌림

새 서비스만 추가한 경우 `sudo systemctl disable --now {name}-https.service {name}.service`로 정지합니다.
기존 설정을 교체했다면 보존한 원본 전체와 enable/active 상태를 복원하고 daemon-reload 후 그 상태로 되돌립니다.
Windows에 이번에 등록한 정확한 작업만 비활성화하고 wsl.conf를 변경했다면 보존본을 검토·복원합니다.
자료·히스토리·토큰·발행 규약·원장은 삭제/복구 덮어쓰기하지 않습니다. 신규 unit/config 파일은 manifest hash와
일치하는 이번 산출물인지 확인한 뒤에만 제거할 수 있습니다. 검사 실패나 응답 유실을 재설치로 덮지 마세요.

참고: https://learn.microsoft.com/en-us/windows/wsl/systemd
https://learn.microsoft.com/en-us/windows/wsl/wsl-config
https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
https://caddyserver.com/docs/caddyfile/directives/tls
"""
    files = {name + ".service": backend, name + "-https.service": proxy, "Caddyfile": caddy,
             "deployment.json": json.dumps(c, ensure_ascii=False, indent=2) + "\n", "OPERATIONS.md": operations}
    if c.get("wsl_distribution"):
        files["startup-wsl.ps1"] = ("# Register explicitly in the distro owner's Windows Task Scheduler. No credentials here.\n"
            + "$ErrorActionPreference = 'Stop'\n"
            + "& \"$env:SystemRoot\\System32\\wsl.exe\" --distribution '" + c["wsl_distribution"]
            + "' --user '" + c["wsl_user"] + "' --exec /bin/sleep infinity\nexit $LASTEXITCODE\n")
    return files


def prepare(config, output):
    contents = render(config)
    # Claim a new directory exclusively; publish the completion manifest last.
    import tempfile
    import shutil
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError("existing_bundle_preserved")
    temporary = Path(tempfile.mkdtemp(prefix="." + output.name + "-", dir=output.parent))
    try:
        hashes = {}
        for name, content in contents.items():
            raw = content.encode("utf-8")
            write_new(temporary / name, raw)
            hashes[name] = sha256(raw).hexdigest()
        write_new(temporary / "manifest.json", (json.dumps({"schema_version": 1, "files": hashes,
            "applied": False, "secrets_included": False}, indent=2) + "\n").encode())
        # mkdir claims the destination exclusively; publication uses hard links without replacement.
        private_directory(output, exist_ok=False)
        try:
            for name in (*contents, "manifest.json"):
                os.link(temporary / name, output / name)
        except BaseException:
            # Only names just created by this operation are eligible for cleanup.
            for name in (*contents, "manifest.json"):
                target = output / name
                if target.exists() and os.path.samefile(target, temporary / name): target.unlink()
            output.rmdir()
            raise
        return {"ok": True, "output": str(output), "files": hashes, "applied": False}
    finally:
        shutil.rmtree(temporary)


def inspect(config):
    c = validate(config)
    checks = []
    def record(name, action):
        try:
            action()
            checks.append({"name": name, "status": "ok"})
        except Exception:
            checks.append({"name": name, "status": "error"})
    paths = [Path(c[field]) for field in ("project_dir", "tenant_root", "access_config", "ruleset_root", "ruleset_policy") if c.get(field)]
    record("persistent_linux_filesystems", lambda: check_linux_paths(paths))
    def users():
        import pwd
        for field in ("service_user", "proxy_user"):
            pwd.getpwnam(c[field])
        if pwd.getpwuid(os.geteuid()).pw_name != c["service_user"]:
            raise ValueError("run_as_service_user")
    record("existing_service_users_and_current_identity", users)
    def policy():
        from core.modules.access.policy import AccessPolicy
        from core.runtime.rulesets import configured_rulesets
        value = AccessPolicy(Path(c["access_config"]), Path(c["tenant_root"]))
        value.validate()
        registry = configured_rulesets(Path(c["ruleset_root"]) if c.get("ruleset_root") else None,
                                       Path(c["ruleset_policy"]) if c.get("ruleset_policy") else None, value)
        if registry is not None:
            from core.modules.extraction_rules.administration import RulesetAdministration
            _, current, _ = RulesetAdministration(registry).snapshot()
            for tenant in current["tenants"]:
                registry.read(tenant)
    record("access_and_ruleset_policy", policy)
    def python():
        subprocess.run([c["project_dir"] + "/.venv/bin/python", "-B", "-c",
            "import sys; import core.runtime.http_cli; sys.exit(0 if sys.version_info >= (3,12) else 1)"],
            cwd=c["project_dir"], timeout=15, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    record("python_environment_and_server_import", python)
    def systemd():
        if sys.platform != "linux" or Path("/proc/1/comm").read_text().strip() != "systemd":
            raise ValueError("systemd_not_running")
    record("systemd_pid1", systemd)
    def tls():
        import ssl
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(c["tls_cert"], c["tls_key"])
    # Backend users must not be granted proxy private-key access merely for this check.
    import getpass
    if getpass.getuser() == c["proxy_user"]:
        record("tls_certificate_key_pair", tls)
    else:
        checks.append({"name": "tls_certificate_key_pair", "status": "not_run", "reason": "requires_proxy_identity"})
    checks.append({"name": "caddy_executable", "status": "ok" if Path("/usr/bin/caddy").is_file() else "error"})
    return {"ok": all(row["status"] != "error" for row in checks), "checks": checks, "changed": False,
            "not_verified": ["proxy_user_key_access", "certificate_hostname_expiry_and_client_trust", "dns_and_firewall",
                             "windows_boot_startup", "remote_api_mcp_connection"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("operation", choices=("prepare", "inspect"))
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        config = load(args.config)
        if args.operation == "prepare":
            if args.output is None: raise ValueError("output_required")
            result = prepare(config, args.output)
        else:
            if args.output is not None: raise ValueError("inspect_is_read_only")
            result = inspect(config)
    except FileExistsError:
        result = {"ok": False, "error": {"code": "existing_bundle_preserved"}}
    except (ValueError, OSError, TypeError):
        result = {"ok": False, "error": {"code": "deployment_configuration_unavailable"}}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
