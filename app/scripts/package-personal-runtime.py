"""개인 실행기에 필요한 소스만 허용 목록으로 ZIP에 넣고 자료·인증·로컬 설정은 제외한다."""
from pathlib import Path
import argparse
import hashlib
import json
import zipfile

def source_files(project):
    """ZIP과 Windows 설치 파일이 같은 소스 허용 목록을 사용한다."""
    files = [project / 'requirements.txt', project / 'requirements.lock',
             project / '.agent' / 'ontology_semantics.md']
    for directory in ('core', 'tools'):
        files.extend(path for path in (project / directory).rglob('*.py')
                     if '__pycache__' not in path.parts and 'tests' not in path.relative_to(project).parts)
    for path in files:
        if path.is_symlink():
            raise ValueError('Symlink in runtime source; packaging stopped')
        for parent in path.parents:
            if parent == project:
                break
            if parent.is_symlink():
                raise ValueError('Symlink in runtime source; packaging stopped')
        if not path.is_file():
            raise ValueError('Missing runtime source; packaging stopped')
    return sorted(files)


def main():
    app = Path(__file__).resolve().parents[1]
    project = app.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=app / 'release',
                        help='Separate output directory for a verified release; defaults to app/release')
    args = parser.parse_args()
    version = json.loads((app / 'package.json').read_text())['version']
    output = args.output_dir.resolve() / f'llm-wiki-personal-runtime-{version}.zip'
    output.parent.mkdir(parents=True, exist_ok=True)
    files = source_files(project)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, 'llm-wiki-personal-runtime/' + path.relative_to(project).as_posix())
        archive.writestr('llm-wiki-personal-runtime/INSTALL.txt', '''LLM Wiki personal runtime\n\nRequires Python >= 3.12. Extract to a stable, user-owned directory.\nFrom that directory run:\n  python3 -m tools.setup_runtime --role personal\nOn Windows use py -3.12 instead of python3.\nSelect this folder and .venv/bin/python (Windows: .venv/Scripts/python.exe)\nin the desktop app's Personal Runtime settings. Diagnose, save and restart.\nFor a new release, extract its ZIP to a new directory, set it up, and select\nthe new folder/Python in the app. Keep existing user data and history.\nUse the app and runtime from the same release batch.\nWhen updating dependencies in an existing source folder, append --upgrade.\nThis option updates pinned dependencies, not application or Python source.\nCodex CLI and personal login, Tesseract and language data are separate.\nRun python -m tools.runtime_doctor with the installed venv for diagnostics.\nNo credentials, account configuration, documents or history are bundled.\nServer production deployment is not part of this archive.\n''')
    checksum = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + '.sha256').write_text(f'{checksum}  {output.name}\n')
    print(json.dumps({'artifact': str(output), 'sha256': checksum, 'source_files': len(files)}))


if __name__ == '__main__':
    main()
