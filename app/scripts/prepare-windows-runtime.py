"""해시로 고정한 Windows Python·OCR와 개인 소스를 새 설치용 폴더에 조립한다."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import tempfile
from urllib.parse import urlparse
from urllib.request import urlopen
import zipfile


APP = Path(__file__).resolve().parents[1]
PROJECT = APP.parent
SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def sha256(path):
    """큰 다운로드도 한 번에 메모리에 읽지 않고 검증한다."""
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative(name):
    """Windows에서 다른 위치로 해석될 경로와 예약 이름을 거부한다."""
    name = name.replace('\\', '/')
    parts = name.rstrip('/').split('/')
    reserved = {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)),
                *(f'LPT{i}' for i in range(1, 10))}
    if (not name or name.startswith('/') or any(
            not part or part in {'.', '..'} or ':' in part or '\x00' in part
            or any(ord(char) < 32 for char in part) or part.endswith((' ', '.'))
            or part.split('.')[0].upper() in reserved for part in parts)):
        raise ValueError('unsafe_archive_path')
    return PurePosixPath(*parts)


def normal_file(path):
    """캐시와 준비한 입력에서 링크·특수 파일을 다운로드 성공으로 간주하지 않는다."""
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('unsafe_input_file')


def plain_directory(path):
    """사용자가 지정한 출력/캐시의 심볼릭 링크 경계를 따라 쓰지 않는다."""
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError('unsafe_directory')
        if part.exists() and not part.is_dir():
            raise ValueError('not_a_directory')


def fetch(asset, cache):
    """고정 HTTPS 원본을 검증한 뒤 원자적으로 캐시에 공개한다."""
    name = safe_relative(asset['filename'])
    if len(name.parts) != 1 or not SHA256.fullmatch(asset['sha256']):
        raise ValueError('invalid_asset_lock')
    if urlparse(asset['url']).scheme != 'https':
        raise ValueError('https_asset_required')
    plain_directory(cache)
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / str(name)
    if destination.exists() or destination.is_symlink():
        normal_file(destination)
        if sha256(destination) != asset['sha256']:
            raise ValueError('cached_asset_hash_mismatch: ' + str(name))
        return destination
    descriptor, temporary_name = tempfile.mkstemp(prefix='.download-', dir=cache)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, 'wb') as output, urlopen(asset['url'], timeout=60) as response:
            if urlparse(response.url).scheme != 'https':
                raise ValueError('https_redirect_required')
            shutil.copyfileobj(response, output)
        if sha256(temporary) != asset['sha256']:
            raise ValueError('download_hash_mismatch: ' + str(name))
        # link는 기존 캐시를 교체하지 않는다. 경쟁한 작성자의 결과도 다시 검사한다.
        try:
            os.link(temporary, destination)
        except FileExistsError:
            normal_file(destination)
            if sha256(destination) != asset['sha256']:
                raise ValueError('concurrent_asset_hash_mismatch')
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def extract_zip(source, destination, *, wheel=False):
    """전체 경로를 먼저 검사하고 wheel의 설치 scheme을 앱 전용 Python에 펼친다."""
    with zipfile.ZipFile(source) as archive:
        entries = []
        seen = set()
        for entry in archive.infolist():
            relative = safe_relative(entry.filename)
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError('archive_link_or_special_file')
            target = destination / Path(*relative.parts)
            if wheel and relative.parts[0].endswith('.data'):
                if len(relative.parts) < 3:
                    if entry.is_dir():
                        continue
                    raise ValueError('invalid_wheel_data')
                scheme = relative.parts[1]
                roots = {'purelib': destination, 'platlib': destination,
                         'scripts': destination.parents[1] / 'Scripts',
                         'headers': destination.parents[1] / 'Include',
                         'data': destination.parents[1]}
                if scheme not in roots:
                    raise ValueError('unknown_wheel_scheme')
                target = roots[scheme] / Path(*relative.parts[2:])
            key = str(target).casefold()
            if key in seen:
                raise ValueError('duplicate_archive_path')
            seen.add(key)
            if target.exists() and not entry.is_dir():
                raise ValueError('archive_would_overwrite_file')
            entries.append((entry, target))
        for entry, target in entries:
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source_stream, target.open('xb') as output:
                    shutil.copyfileobj(source_stream, output)


def extract_ocr(source, destination, seven_zip, temporary):
    """검증한 NSIS에서 OCR 실행에 쓰는 파일·설정·라이선스만 보존한다."""
    listing = subprocess.run([str(seven_zip), 'l', '-slt', '-ba', str(source)],
                             check=True, capture_output=True, text=True).stdout
    paths = []
    for block in listing.split('\n\n'):
        fields = dict(line.split(' = ', 1) for line in block.splitlines() if ' = ' in line)
        if 'Symbolic Link' in fields or 'Hard Link' in fields:
            raise ValueError('ocr_archive_link')
        if 'Path' in fields:
            paths.append(safe_relative(fields['Path']))
    if not paths:
        raise ValueError('empty_ocr_archive')
    subprocess.run([str(seven_zip), 'x', '-y', '-bd', str(source), '-o' + str(temporary)],
                   check=True, capture_output=True)
    candidates = list(temporary.rglob('tesseract.exe'))
    if len(candidates) != 1:
        raise ValueError('unexpected_ocr_layout')
    root = candidates[0].parent
    destination.mkdir()
    selected = [root / 'tesseract.exe', *sorted(root.glob('*.dll'))]
    for directory in ('doc', 'tessdata'):
        if (root / directory).is_dir():
            selected.extend(path for path in (root / directory).rglob('*') if not path.is_dir())
    for path in selected:
        normal_file(path)
        relative = path.relative_to(root)
        if any(part.is_symlink() for part in path.parents if part != temporary.parent):
            raise ValueError('ocr_link_directory')
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    if not (destination / 'doc/LICENSE').is_file():
        raise ValueError('ocr_license_missing')


def validate_pe(path):
    """다른 OS/CPU 바이너리를 이름만 바꾸어 넣지 않도록 PE x64를 확인한다."""
    with path.open('rb') as stream:
        header = stream.read(64)
        if len(header) != 64 or header[:2] != b'MZ':
            raise ValueError('windows_executable_required')
        stream.seek(struct.unpack_from('<I', header, 60)[0])
        pe = stream.read(6)
        if pe[:4] != b'PE\0\0' or len(pe) != 6 or struct.unpack_from('<H', pe, 4)[0] != 0x8664:
            raise ValueError('windows_x64_required')


def validate_lock(lock, project):
    """소스의 고정 의존성이 바뀌면 예전 번들을 묵시적으로 재사용하지 않는다."""
    if lock['schema_version'] != 1 or sha256(project / 'requirements.lock') != lock['requirements_sha256']:
        raise ValueError('requirements_lock_changed')
    if not re.fullmatch(r'3\.13\.\d+', lock['python']['version']):
        raise ValueError('unsupported_embedded_python')
    names = set()
    for asset in lock['wheels']:
        filename = asset['filename']
        if not filename.endswith('.whl') or not any(tag in filename for tag in ('-win_amd64.whl', '-any.whl')):
            raise ValueError('unsupported_wheel_platform')
        parts = filename[:-4].rsplit('-', 3)
        if len(parts) != 4:
            raise ValueError('invalid_wheel_name')
        _, python_tag, abi, _ = parts
        if abi not in ('none', 'abi3', 'cp313') or (abi == 'cp313' and python_tag != 'cp313'):
            raise ValueError('unsupported_wheel_python')
        distribution, version = parts[0].split('-')[:2]
        names.add((re.sub(r'[-_.]+', '-', distribution).lower(), version))
    for line in (project / 'requirements.lock').read_text().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        requirement = line.split(';', 1)[0].strip()
        name, version = requirement.split('==')
        if (re.sub(r'[-_.]+', '-', name).lower(), version) not in names:
            raise ValueError('locked_dependency_missing: ' + name)


def source_files(project):
    """기존 ZIP 생성기의 허용 목록을 재사용한다."""
    spec = importlib.util.spec_from_file_location('personal_runtime_sources',
                                                 APP / 'scripts/package-personal-runtime.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.source_files(project)


def verify(lock_path, output, *, project=PROJECT):
    """현재 소스·고정 입력·실제 묶음이 모두 같을 때만 패키징을 허용한다."""
    lock = json.loads(lock_path.read_text())
    validate_lock(lock, project)
    manifest_path = output / 'runtime-manifest.json'
    normal_file(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    if manifest['lock_sha256'] != sha256(lock_path):
        raise ValueError('runtime_asset_lock_changed')
    current = {path.relative_to(project).as_posix(): sha256(path) for path in source_files(project)}
    if current != manifest['sources']:
        raise ValueError('runtime_sources_changed')
    files = {}
    plain_directory(output)
    for path in output.rglob('*'):
        if path.is_symlink():
            raise ValueError('runtime_symlink')
        if path.is_file() and path != manifest_path:
            normal_file(path)
            files[path.relative_to(output).as_posix()] = sha256(path)
    if files != manifest['files']:
        raise ValueError('runtime_payload_changed')
    return {'output': str(output), 'verified': True, 'file_count': len(files),
            'windows_execution_verified': False}


def prepare(lock_path, cache, output, seven_zip, *, project=PROJECT):
    """모든 조립·검증이 끝난 새 폴더만 공개하고 기존 출력은 보존한다."""
    if output.exists() or output.is_symlink():
        raise FileExistsError('runtime_output_exists_choose_new_directory')
    plain_directory(output.parent)
    lock = json.loads(lock_path.read_text())
    validate_lock(lock, project)
    sources = source_files(project)
    assets = [lock['python'], lock['ocr'], *lock['traineddata'], *lock['wheels']]
    downloads = {asset['filename']: fetch(asset, cache) for asset in assets}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.windows-runtime-', dir=output.parent) as scratch:
        staging = Path(scratch) / 'personal-runtime'
        staging.mkdir()
        for path in sources:
            target = staging / path.relative_to(project)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        python = staging / 'python'
        extract_zip(downloads[lock['python']['filename']], python)
        for asset in lock['wheels']:
            extract_zip(downloads[asset['filename']], python / 'Lib/site-packages', wheel=True)
        # site가 pywin32.pth의 DLL 경로 초기화를 수행한다. 사용자 pip/PYTHONPATH는 쓰지 않는다.
        (python / 'python313._pth').write_text('python313.zip\n.\nLib/site-packages\n..\nimport site\n')
        extract_ocr(downloads[lock['ocr']['filename']], staging / 'ocr', seven_zip,
                    Path(scratch) / 'ocr-installer')
        for asset in lock['traineddata']:
            shutil.copyfile(downloads[asset['filename']], staging / 'ocr/tessdata' / asset['filename'])
        for path in ('python/python.exe', 'python/python313.dll', 'ocr/tesseract.exe'):
            validate_pe(staging / path)
        for path in ('python/Lib/site-packages/pywin32.pth',
                     'python/Lib/site-packages/pywin32_system32/pywintypes313.dll',
                     'python/Lib/site-packages/win32/win32api.pyd',
                     'python/Lib/site-packages/win32/win32job.pyd',
                     'ocr/tessdata/eng.traineddata', 'ocr/tessdata/kor.traineddata'):
            normal_file(staging / path)
        notice = ('LLM Wiki Windows personal runtime\n\n'
                  f"CPython {lock['python']['version']}: python/LICENSE.txt\n"
                  f"Tesseract {lock['ocr']['version']}: ocr/doc/LICENSE and documentation\n"
                  'Tesseract language data: ocr/tessdata/LICENSE\n'
                  'Python package licenses: python/Lib/site-packages/*.dist-info/\n\n'
                  'This application-private runtime does not modify the system Python or PATH.\n'
                  'No account credentials, user documents, history or server are included.\n'
                  'Install Codex CLI or Claude Code separately and sign in with your own account.\n'
                  'Configure the server address and authentication in the application.\n'
                  'Updates replace this bundled runtime with the app; do not run pip/setup_runtime here.\n')
        (staging / 'THIRD_PARTY_NOTICES.txt').write_text(notice, encoding='utf-8')
        manifest = {'schema_version': 1, 'platform': 'win32', 'arch': 'x64',
                    'python_version': lock['python']['version'], 'ocr_version': lock['ocr']['version'],
                    'requirements_sha256': lock['requirements_sha256'],
                    'lock_sha256': sha256(lock_path), 'ai_cli_bundled': False,
                    'windows_execution_verified': False,
                    'sources': {str(path.relative_to(project).as_posix()): sha256(path) for path in sources},
                    'files': {str(path.relative_to(staging).as_posix()): sha256(path)
                              for path in sorted(staging.rglob('*')) if path.is_file()}}
        (staging / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        if output.exists() or output.is_symlink():
            raise FileExistsError('runtime_output_created_concurrently')
        staging.rename(output)
    return {'output': str(output), 'file_count': len(manifest['files']),
            'python': lock['python']['version'], 'ocr': lock['ocr']['version'],
            'windows_execution_verified': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--lock', type=Path, default=APP / 'config/windows-runtime.lock.json')
    parser.add_argument('--cache-dir', type=Path, default=APP / 'release/windows-runtime-cache')
    parser.add_argument('--output-dir', type=Path, default=APP / 'release/windows-runtime/personal-runtime')
    parser.add_argument('--seven-zip', type=Path, help='7zz executable supporting NSIS extraction')
    parser.add_argument('--verify-only', action='store_true', help='Check existing payload against current source and lock')
    args = parser.parse_args(argv)
    if args.verify_only:
        result = verify(args.lock.absolute(), args.output_dir.absolute())
    else:
        if args.seven_zip is None:
            parser.error('--seven-zip is required when preparing a new bundle')
        result = prepare(args.lock.absolute(), args.cache_dir.absolute(), args.output_dir.absolute(),
                         args.seven_zip.absolute())
    print(json.dumps(result))


if __name__ == '__main__':
    main()
