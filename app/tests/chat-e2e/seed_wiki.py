"""채팅 E2E용 격리 서버의 위키에 테스트 문서를 만든다. 반드시 WikiStore.save()로만 쓴다(신규 생성)."""
import sys
from pathlib import Path
from core.modules.documents.store import WikiStore

DOCUMENTS = {
    "센서-경고.md": "# 센서 경고\n\n센서는 온도가 설정 범위를 벗어나면 경고 신호를 보냅니다. 상한 초과와 하한 미달을 구분합니다.\n\n경고 해제 임계값은 문서화되지 않았습니다.\n",
    "운전-모드.md": "# 운전 모드\n\n운전 모드가 바뀌는 동안에는 기존 경고 상태를 유지합니다. 모드 전환 후 온도 범위를 다시 확인합니다.\n",
    "경고-온도.md": "# 경고 온도 기준\n\n경고 온도 센서의 기준값은 설정 화면에서 바꿉니다.\n",
}

store = WikiStore(Path(sys.argv[1]))
for name, text in DOCUMENTS.items():
    if not (store.wiki_dir / name).exists():
        store.save(name, text, expected_revision=None)
print("seeded", len(DOCUMENTS))
