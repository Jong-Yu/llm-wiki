"""공개 포터블의 번들 Python/Windows 보호 경계/Office를 합성 문서로 직접 검증한다."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote
from urllib.request import urlopen
from zipfile import ZipFile, ZIP_DEFLATED


APP = Path(__file__).resolve().parents[1]
MARKERS = ("VISIBLE FIRST", "HIDDEN SECOND", "VISIBLE THIRD")
COLORS = ("F3B1AB", "A8D8B9", "A9C9F0")


def digest(path):
    """대형 포터블을 메모리에 적재하지 않고 검사한다."""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    """합성 실행의 결과만 아티팩트 폴더에 남긴다."""
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def download(url, target, maximum):
    """공개 HTTPS 릴리스만 사용하고 예상 범위를 넘는 응답은 중단한다."""
    with urlopen(url, timeout=90) as response, target.open("xb") as output:
        if not response.url.startswith("https://"):
            raise ValueError("non_https_release_redirect")
        size = 0
        for block in iter(lambda: response.read(1024 * 1024), b""):
            size += len(block)
            if size > maximum:
                raise ValueError("release_asset_too_large")
            output.write(block)


def extract_archive(archive, destination):
    """배포 도구의 Windows 경로·중복·링크 검사를 재사용한다."""
    script = APP / "scripts/prepare-windows-runtime.py"
    spec = importlib.util.spec_from_file_location("runtime_package", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with ZipFile(archive) as package:
        if len(package.infolist()) > 100000 or sum(item.file_size for item in package.infolist()) > 4 * 1024**3:
            raise ValueError("release_archive_too_large")
    destination.mkdir()
    module.extract_zip(archive, destination)


def synthetic_presentation(path):
    """사용자 파일·네트워크 참조가 없는 세 장의 PPTX를 만들고 두 번째 슬라이드를 숨긴다."""
    drawing = "http://schemas.openxmlformats.org/drawingml/2006/main"
    presentation = "http://schemas.openxmlformats.org/presentationml/2006/main"
    relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    types = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
             '<Default Extension="xml" ContentType="application/xml"/>',
             '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>']
    slides = []
    for number, (marker, color) in enumerate(zip(MARKERS, COLORS), 1):
        types.append(f'<Override PartName="/ppt/slides/slide{number}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>')
        slides.append(f'''<p:sld xmlns:a="{drawing}" xmlns:p="{presentation}" xmlns:r="{relationships}" show="{0 if number == 2 else 1}">
<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="{color}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Synthetic label"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="1828800"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3600" b="1"><a:solidFill><a:srgbClr val="202020"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>{marker}</a:t></a:r></a:p></p:txBody>
</p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>''')
    with ZipFile(path, "x", ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + "".join(types) + '</Types>')
        package.writestr("_rels/.rels", f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{relationships}/officeDocument" Target="ppt/presentation.xml"/></Relationships>')
        package.writestr("ppt/presentation.xml", f'<p:presentation xmlns:p="{presentation}" xmlns:r="{relationships}"><p:sldIdLst>' + "".join(f'<p:sldId id="{255 + number}" r:id="rId{number}"/>' for number in range(1, 4)) + '</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>')
        package.writestr("ppt/_rels/presentation.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(f'<Relationship Id="rId{number}" Type="{relationships}/slide" Target="slides/slide{number}.xml"/>' for number in range(1, 4)) + '</Relationships>')
        for number, content in enumerate(slides, 1):
            package.writestr(f"ppt/slides/slide{number}.xml", content)


def child_environment(runtime):
    """앱과 같은 OS 필수 변수만 보존하고 시스템 Office/Python의 PATH 도움을 제거한다."""
    allowed = {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE",
               "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"}
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    system = next((value for key, value in environment.items() if key.upper() == "SYSTEMROOT"), None)
    if not system:
        raise ValueError("windows_systemroot_missing")
    environment["PATH"] = os.pathsep.join((str(runtime / "python"), str(Path(system) / "System32"), system))
    environment.update(PYTHONUNBUFFERED="1", PYTHONUTF8="1")
    return environment


def native(runtime, output):
    """다운로드한 번들의 Python으로만 probe와 실제 bridge→Office 렌더를 실행한다."""
    if sys.platform != "win32" or Path(sys.executable).resolve() != (runtime / "python/python.exe").resolve():
        raise ValueError("bundled_windows_python_required")
    from core.client.office_runtime import find_libreoffice
    from PIL import Image
    import pypdfium2
    import win32api, win32file, win32security, win32job  # noqa: F401

    evidence = {"ok": False, "platform": sys.platform, "python": sys.version.split()[0], "steps": []}
    started = time.monotonic()
    environment = child_environment(runtime)
    empty_runtime = output / "no-runtime"
    if find_libreoffice(environment=os.environ, runtime_root=empty_runtime) is not None:
        raise ValueError("system_office_is_present")
    office = Path(find_libreoffice(environment=environment) or "").resolve()
    if office != (runtime / "office/program/soffice.exe").resolve():
        raise ValueError("bundled_office_not_selected")
    evidence.update(host_office_absent=True, bundled_office_selected=True)

    def command(name, arguments, *, token=None, bridge=False):
        """launch의 stdin을 종료까지 열어 실제 Electron 연결과 같은 수명으로 실행한다."""
        stdout_path, stderr_path = output / (name + ".stdout"), output / (name + ".stderr")
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            process = subprocess.Popen([sys.executable, "-B", "-m", "core.runtime.desktop_bridge", *arguments],
                                       cwd=runtime, env=environment, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                                       creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                if token is not None:
                    process.communicate(token, timeout=30)
                elif bridge:
                    process.wait(timeout=180)
                else:
                    process.communicate(timeout=30)
            finally:
                if process.poll() is None:
                    subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/taskkill.exe"),
                                    "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False)
                    process.wait(timeout=10)
                process.stdin.close()
        raw = stdout_path.read_text(encoding="utf-8", errors="replace")
        errors = stderr_path.read_text(encoding="utf-8", errors="replace")
        try:
            result = next((json.loads(line) for line in reversed(raw.splitlines()) if line.startswith('{')), {})
        except json.JSONDecodeError:
            result = {"ok": False, "stdout": raw[-4000:]}
        evidence["steps"].append({"name": name, "exit_code": process.returncode, "result": result,
                                  "stderr": errors[-4000:]})
        write_json(output / "native-result.json", evidence)
        stdout_path.unlink()
        stderr_path.unlink()
        if process.returncode != 0 or not result.get("ok"):
            raise RuntimeError("native_step_failed: " + name)
        return result

    try:
        probe = command("probe", ["probe"])
        if not probe["capabilities"].get("runtime_ready") or probe["capabilities"].get("probe") != "private_file_and_process_tree":
            raise ValueError("native_protection_probe_failed")
        with tempfile.TemporaryDirectory(prefix="wiki-native-smoke-") as scratch:
            prepared = command("private-prepare", ["prepare", "--root", scratch, "--name", "exec-windows-smoke"],
                               token=b"synthetic-only-runtime-smoke-token-0000000000")
            work = Path(prepared["work_directory"])
            synthetic_presentation(work / "source.pptx")
            original_hash = digest(work / "source.pptx")
            base = ["launch", "--parent-pid", str(os.getpid()), "--", "-B", "-m", "tools.source_preview_cli"]
            prepared_preview = command("preview-prepare", [*base, "prepare", "--work-dir", str(work), "--format", "pptx"], bridge=True)
            if prepared_preview["data"]["pageCount"] != 3:
                raise ValueError("hidden_slide_count_mismatch")
            with pypdfium2.PdfDocument(work / "preview.pdf") as pdf:
                if len(pdf) != 3:
                    raise ValueError("pdf_slide_count_mismatch")
                for index, marker in enumerate(MARKERS):
                    page = pdf[index]
                    textpage = page.get_textpage()
                    try:
                        if marker not in textpage.get_text_range():
                            raise ValueError("slide_order_or_text_mismatch")
                    finally:
                        textpage.close()
                        page.close()
            images = []
            for number in range(1, 4):
                command(f"preview-render-{number}", [*base, "render", "--work-dir", str(work), "--format", "pptx", "--page", str(number)], bridge=True)
                png = work / "page.png"
                with Image.open(png) as image:
                    if image.width < 200 or image.height < 100 or max(image.size) > 1600:
                        raise ValueError("preview_dimensions_invalid")
                    if all(low == high for low, high in image.convert("RGB").getextrema()):
                        raise ValueError("blank_preview")
                    images.append({"page": number, "width": image.width, "height": image.height, "sha256": digest(png)})
                shutil.copyfile(png, output / f"synthetic-slide-{number}.png")
            if len({item["sha256"] for item in images}) != 3 or digest(work / "source.pptx") != original_hash:
                raise ValueError("preview_changed_source_or_repeated_slide")
        evidence.update(ok=True, images=images, hidden_slide_included=True, source_preserved=True)
    finally:
        evidence["seconds"] = round(time.monotonic() - started, 2)
        write_json(output / "native-result.json", evidence)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--release-tag")
    source.add_argument("--archive", type=Path)
    source.add_argument("--native-runtime", type=Path)
    parser.add_argument("--sha256-file", type=Path)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"ok": False, "synthetic_documents_only": True, "release_tag": args.release_tag}
    try:
        if args.native_runtime:
            native(args.native_runtime.resolve(strict=True), output)
            report["ok"] = True
            return 0
        if not args.work_dir or (args.archive and not args.sha256_file):
            raise ValueError("work_directory_and_archive_checksum_required")
        work = args.work_dir.resolve()
        work.mkdir(parents=True, exist_ok=False)
        if args.release_tag:
            match = re.fullmatch(r"app-(\d+\.\d+\.\d+(?:-rc\.\d+)?)-portable", args.release_tag)
            if not match:
                raise ValueError("invalid_public_release_tag")
            name = f"LLM-Wiki-{match[1]}-windows-x64-portable.zip"
            base = "https://github.com/Jong-Yu/llm-wiki-releases/releases/download/" + quote(args.release_tag, safe="") + "/"
            archive, checksum = work / name, work / (name + ".sha256")
            download(base + quote(name + ".sha256"), checksum, 1024)
            download(base + quote(name), archive, 2 * 1024**3)
        else:
            archive, checksum = args.archive.resolve(strict=True), args.sha256_file.resolve(strict=True)
        expected = re.fullmatch(r"([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)\s*", checksum.read_text(encoding="utf-8").strip())
        if not expected or expected[2] != archive.name or digest(archive) != expected[1].lower():
            raise ValueError("release_checksum_mismatch")
        report.update(archive=archive.name, sha256=expected[1].lower())
        extract_archive(archive, work / "extracted")
        manifests = list((work / "extracted").rglob("resources/personal-runtime/runtime-manifest.json"))
        if len(manifests) != 1:
            raise ValueError("portable_runtime_layout_invalid")
        runtime = manifests[0].parent
        manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
        if manifest.get("platform") != "win32" or manifest.get("arch") != "x64":
            raise ValueError("unexpected_runtime_platform")
        for name, expected_hash in manifest["files"].items():
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts or ":" in name or "\\" in name:
                raise ValueError("unsafe_runtime_manifest")
            if digest(runtime / relative) != expected_hash:
                raise ValueError("runtime_manifest_hash_mismatch")
        report.update(runtime_files_verified=len(manifest["files"]), python_version=manifest["python_version"],
                      office_version=manifest["office_version"])
        write_json(output / "release-result.json", report)
        result = subprocess.run([str(runtime / "python/python.exe"), "-B", str(Path(__file__).resolve()),
                                 "--native-runtime", str(runtime), "--output", str(output)],
                                cwd=runtime, env=child_environment(runtime), timeout=600, check=False)
        if result.returncode != 0:
            raise RuntimeError("native_runtime_smoke_failed")
        report["ok"] = True
        return 0
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        print(json.dumps(report, ensure_ascii=False))
        return 1
    finally:
        write_json(output / ("native-runner.json" if args.native_runtime else "release-result.json"), report)


if __name__ == "__main__":
    raise SystemExit(main())
