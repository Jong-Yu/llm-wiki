#!/bin/bash
# 현재 서버 주소를 사용자의 비공개 GitHub 메모(secret gist)에 올린다. start-mac.command가 새 주소를 얻은 뒤 부른다.
# .local/address-gist-id가 있을 때만 동작한다. 빈 파일이면 메모를 새로 만들고 그 ID를 이 파일에 적는다.
# 메모에는 주소와 시각만 쓰고 토큰·계정 정보는 쓰지 않는다. 주소만으로는 개인 인증 없이 자료에 들어올 수 없다.
#   tools/publish-server-address.sh [주소: 생략하면 .local/last-server-url.txt]
set -euo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
id_file="$project_dir/.local/address-gist-id"
url_file="$project_dir/.local/last-server-url.txt"
memo_name='llm-wiki-server-address.md'
description='LLM Wiki 서버 주소 (서버를 다시 시작하면 자동으로 바뀜)'

[[ -f "$id_file" ]] || exit 0
fail() { printf '\n주소 메모를 바꾸지 못했습니다: %s\n' "$*" >&2; exit 1; }

url="${1:-}"
if [[ -z "$url" && -f "$url_file" ]]; then url="$(head -1 "$url_file")"; fi
[[ "$url" =~ ^https://[a-z0-9.-]+$ ]] || fail '서버 주소 형식이 올바르지 않습니다.'
gist_id="$(tr -d '[:space:]' <"$id_file")"
if [[ -n "$gist_id" && ! "$gist_id" =~ ^[0-9a-f]{20,64}$ ]]; then
    fail '.local/address-gist-id의 메모 ID 형식이 올바르지 않습니다.'
fi

# 터미널 창마다 PATH가 다를 수 있어 Homebrew 기본 위치도 찾는다.
gh="$(command -v gh || true)"
for candidate in /opt/homebrew/bin/gh /usr/local/bin/gh; do
    if [[ -z "$gh" && -x "$candidate" ]]; then gh="$candidate"; fi
done
[[ -n "$gh" ]] || fail 'GitHub CLI(gh)를 찾지 못했습니다.'

content="# LLM Wiki 서버 주소

- 앱 서버 주소: $url
- MCP 주소: $url/mcp
- 바뀐 시각: $(date '+%Y-%m-%d %H:%M %Z')

서버를 다시 시작하면 주소가 바뀌고, 이 메모도 그때 새 주소로 바뀝니다.
서버가 꺼져 있으면 위 주소로 연결되지 않습니다.
"
hint='인터넷 연결과 GitHub 로그인(gh auth status)을 확인하세요. 메모를 지웠다면 .local/address-gist-id를 빈 파일로 두면 다음 실행 때 새로 만듭니다.'

if [[ -z "$gist_id" ]]; then
    gist_id="$("$gh" api --method POST gists -f "description=$description" -F public=false \
        -f "files[$memo_name][content]=$content" --jq .id 2>/dev/null)" || fail "$hint"
    [[ "$gist_id" =~ ^[0-9a-f]{20,64}$ ]] || fail '새 메모의 ID를 확인하지 못했습니다.'
    printf '%s\n' "$gist_id" >"$id_file"
else
    "$gh" api --method PATCH "gists/$gist_id" -f "description=$description" \
        -f "files[$memo_name][content]=$content" --silent 2>/dev/null || fail "$hint"
fi
printf '\n주소 메모를 새 주소로 바꿨습니다: https://gist.github.com/%s\n' "$gist_id"
