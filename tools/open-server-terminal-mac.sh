#!/bin/bash
# Claude 세션이 끝나도 서버가 계속 돌도록 macOS 터미널 창에서 start-mac.command를 실행한다.
# 이미 도는 런처가 있으면 정상 종료 신호(TERM)로 먼저 내리고, 새 터널 주소를 .local/last-server-url.txt에서 읽어 알려 준다.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
port="${1:-8766}"
[[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || { echo '포트는 1~65535의 정수여야 합니다.' >&2; exit 1; }
url_file="$project_dir/.local/last-server-url.txt"

# 이 프로젝트의 런처만 찾는다. 런처의 종료 처리가 서버와 터널을 함께 내린다.
# 명령줄이 상대 경로일 수 있어, 작업 폴더가 이 프로젝트인 런처만 대상으로 삼는다.
launcher_pids=()
for pid in $(pgrep -f 'tools/start-mac.command' || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    [[ "$cwd" == "$project_dir" ]] && launcher_pids+=("$pid")
done
if (( ${#launcher_pids[@]} > 0 )); then
    echo "실행 중인 런처를 종료합니다: ${launcher_pids[*]}"
    kill -TERM "${launcher_pids[@]}" || true
    for _ in $(seq 1 20); do
        lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break
        sleep 1
    done
fi
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "포트 ${port}를 다른 프로세스가 쓰고 있어 시작하지 않습니다. 직접 확인해 주세요." >&2
    exit 1
fi
rm -f -- "$url_file"

# 터미널 창을 새로 열어 런처를 실행한다. 경로의 공백은 따옴표로 보호한다.
/usr/bin/osascript <<OSA
tell application "Terminal"
    activate
    do script "cd " & quoted form of "$project_dir" & " && tools/start-mac.command $port"
end tell
OSA

for _ in $(seq 1 90); do
    [[ -s "$url_file" ]] && break
    sleep 1
done
if [[ -s "$url_file" ]]; then
    echo "서버 주소: $(cat "$url_file")"
else
    echo '터널 주소를 확인하지 못했습니다. 터미널 창의 메시지를 확인해 주세요.' >&2
    exit 1
fi
