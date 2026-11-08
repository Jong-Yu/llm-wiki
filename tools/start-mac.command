#!/bin/bash
# macOS Finder에서 더블클릭하거나 터미널에서 실행하는 API/MCP + Quick Tunnel 런처.
set -euo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

fail() { printf '\n오류: %s\n' "$*" >&2; exit 1; }
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    printf '사용법: %s [포트: 기본 8766]\n' "$0"
    printf 'API/MCP 서버와 Quick Tunnel을 시작합니다. Ctrl+C 또는 창 닫기로 함께 종료합니다.\n'
    printf '터널 실행 파일: 프로젝트의 .local/cloudflared\n'
    exit 0
fi
[[ $# -le 1 ]] || fail '포트 번호 하나만 지정하세요. --help로 실행법을 확인하세요.'
port="${1:-8766}"
[[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || fail '포트는 1~65535의 정수여야 합니다.'
python="$project_dir/.venv/bin/python"
[[ -x "$python" ]] || fail '프로젝트 .venv/bin/python이 없습니다. README의 실행 환경 준비를 확인하세요.'
[[ -f .local/tenancy/access.json ]] || fail '기존 .local/tenancy/access.json이 없습니다. 기존 서버 설정 위치를 확인하세요.'

cloudflared="$project_dir/.local/cloudflared"
[[ -x "$cloudflared" ]] || fail '프로젝트 .local/cloudflared가 없거나 실행 권한이 없습니다. README의 Mac 터널 실행 파일 안내를 확인하세요.'

# 배포자가 명시한 설정만 전달한다. 끊어진 링크도 생략하지 않고 서버 검증에서 거부한다.
server_arguments=(--access-config .local/tenancy/access.json --tenant-root data --port "$port"
    --tracked-read-index --read-metrics)
ruleset_config="$project_dir/.local/server-rulesets.json"
if [[ -e "$ruleset_config" || -L "$ruleset_config" ]]; then
    server_arguments+=(--ruleset-config "$ruleset_config")
fi

# 기존 프로세스를 재사용하거나 종료하지 않는다. 자료 검사는 읽기만 수행한다.
"$python" -B - "$port" <<'PY'
import socket
import sys
from pathlib import Path
from core.modules.access.policy import AccessPolicy, PolicyError

try:
    AccessPolicy(Path('.local/tenancy/access.json'), Path('data')).validate()
except (PolicyError, OSError, ValueError):
    sys.exit('오류: 기존 정책 또는 자료 폴더를 읽을 수 없습니다. 원래 자료 위치를 확인하세요. 자동 초기화하지 않습니다.')
try:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', int(sys.argv[1])))
except OSError:
    sys.exit('오류: 포트를 사용할 수 없습니다. 기존 서버를 직접 종료하거나 다른 포트를 지정하세요.')
PY

run_dir="$(mktemp -d "${TMPDIR:-/tmp}/llm-wiki-quick.XXXXXX")"
server_pid=''
tunnel_pid=''
cleanup() {
    trap '' INT TERM HUP
    for pid in $server_pid $tunnel_pid; do kill -TERM "$pid" 2>/dev/null || true; done
    # 정상 종료를 기다리되 멈추지 않는 자식 때문에 창 종료가 무한 대기하지 않게 한다.
    for attempt in 1 2 3 4 5; do
        alive=0
        for pid in $server_pid $tunnel_pid; do
            if kill -0 "$pid" 2>/dev/null; then alive=1; fi
        done
        [[ "$alive" == 1 ]] || break
        sleep 1
    done
    for pid in $server_pid $tunnel_pid; do
        kill -KILL "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    done
    rm -rf -- "$run_dir"
    rm -f -- "$project_dir/.local/last-server-url.txt"
    printf '\n이번 실행에서 시작한 서버와 터널을 종료했습니다.\n'
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

printf 'API/MCP 서버 시작: http://127.0.0.1:%s\n' "$port"
"$python" -B -m core.runtime.http_cli \
    "${server_arguments[@]}" \
    >"$run_dir/server.log" 2>&1 &
server_pid=$!
ready=0
for ((attempt=0; attempt<30; attempt++)); do
    if ! kill -0 "$server_pid" 2>/dev/null; then
        cat "$run_dir/server.log" >&2
        fail '서버가 시작되지 않았습니다. 위 오류를 확인하세요.'
    fi
    # 이 런처가 시작한 프로세스가 포트를 소유하는지 확인한다.
    if /usr/sbin/lsof -nP -a -p "$server_pid" -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
        status="$(/usr/bin/curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/mcp" || true)"
        if [[ "$status" == 401 ]]; then ready=1; break; fi
    fi
    sleep 1
done
[[ "$ready" == 1 ]] || { cat "$run_dir/server.log" >&2; fail '서버 준비 대기 시간이 초과되었습니다.'; }

# 사용자 Cloudflare 설정을 바꾸지 않고 이번 Quick Tunnel만 설정한다.
printf '{}\n' >"$run_dir/cloudflared.yml"
printf 'Cloudflare Quick Tunnel 연결 중…\n'
/usr/bin/env -u TUNNEL_NAME "$cloudflared" tunnel --config "$run_dir/cloudflared.yml" --no-autoupdate \
    --url "http://127.0.0.1:$port" --http-host-header "127.0.0.1:$port" \
    --loglevel info >"$run_dir/tunnel.log" 2>&1 &
tunnel_pid=$!
public_url=''
for ((attempt=0; attempt<60; attempt++)); do
    if ! kill -0 "$server_pid" 2>/dev/null || ! kill -0 "$tunnel_pid" 2>/dev/null; then
        cat "$run_dir/server.log" >&2
        tail -25 "$run_dir/tunnel.log" >&2
        fail '서버 또는 터널이 종료되었습니다.'
    fi
    public_url="$(sed -nE 's@.*(https://[a-z0-9-]+\.trycloudflare\.com).*@\1@p' "$run_dir/tunnel.log" | head -1)"
    if [[ -n "$public_url" ]] && grep -q 'Registered tunnel connection' "$run_dir/tunnel.log"; then break; fi
    sleep 1
done
if [[ -z "$public_url" ]] || ! grep -q 'Registered tunnel connection' "$run_dir/tunnel.log"; then
    tail -25 "$run_dir/tunnel.log" >&2
    fail '터널 연결 대기 시간이 초과되었습니다. 인터넷 연결과 Cloudflare 상태를 확인하세요.'
fi

# 주소는 실행할 때마다 바뀌므로 로컬 파일에 남겨 다른 도구와 세션이 읽게 한다. 인증 정보는 담지 않는다.
printf '%s\n' "$public_url" >"$project_dir/.local/last-server-url.txt"
printf '\n앱 서버 주소: %s\nMCP 주소:     %s/mcp\n' "$public_url" "$public_url"
printf '기존 개인 인증을 사용하세요. 주소는 재실행할 때 바뀝니다.\n'
printf '이 창을 열어 두세요. 종료: Ctrl+C 또는 창 닫기\n\n'
while kill -0 "$server_pid" 2>/dev/null && kill -0 "$tunnel_pid" 2>/dev/null; do sleep 1; done
cat "$run_dir/server.log" >&2
tail -25 "$run_dir/tunnel.log" >&2
fail '서버 또는 터널이 종료되어 나머지 프로세스도 정리합니다.'
