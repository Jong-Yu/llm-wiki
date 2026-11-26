"""앱에 포함되거나 설치된 Office 렌더러와 격리 실행의 글꼴 환경을 찾는다."""

import os
from pathlib import Path
import shutil
import sys
from xml.sax.saxutils import escape


def find_libreoffice(*, platform=None, environment=None, runtime_root=None):
    """앱의 고정 번들을 우선하고 기존 설치만 탐색하며 다운로드·설치하지 않는다."""
    platform = sys.platform if platform is None else platform
    environment = os.environ if environment is None else environment
    if platform == "win32":
        # Windows 환경 변수는 대소문자를 구분하지 않으며 전달받은 일반 dict도 같게 처리한다.
        environment = {name.upper(): value for name, value in environment.items()}
    runtime_root = Path(__file__).resolve().parents[2] if runtime_root is None else Path(runtime_root)
    candidates = []
    if platform == "win32":
        candidates.append(runtime_root / "office/program/soffice.exe")
    elif platform == "darwin":
        candidates.append(Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"))
    candidates.extend(shutil.which(name, path=environment.get("PATH", os.defpath))
                      for name in ("soffice", "libreoffice"))
    if platform == "win32":
        for name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "LOCALAPPDATA"):
            if environment.get(name):
                candidates.append(Path(environment[name]) / "LibreOffice/program/soffice.exe")
    return next((str(Path(path).resolve()) for path in candidates if path and Path(path).is_file()), None)


def office_environment(work, *, platform=None):
    """개인 설정을 바꾸지 않고 macOS 한글 글꼴 폴더를 이번 렌더에만 전달한다."""
    environment = dict(os.environ)
    if (sys.platform if platform is None else platform) == "darwin" and "FONTCONFIG_FILE" not in environment:
        work = Path(work)
        folders = ("/System/Library/Fonts", "/Library/Fonts", str(Path.home() / "Library/Fonts"))
        config = work / "fonts.conf"
        config.write_text(
            '<?xml version="1.0"?><fontconfig>' + "".join(f"<dir>{escape(folder)}</dir>" for folder in folders)
            + f"<cachedir>{escape(str(work / 'font-cache'))}</cachedir></fontconfig>", encoding="utf-8")
        environment["FONTCONFIG_FILE"] = str(config)
    return environment
