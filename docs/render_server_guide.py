"""초보자용 서버 가이드의 HTML과 선택적 PDF를 같은 원문에서 생성한다.

HTML: 프로젝트 .venv의 Python으로 이 파일을 실행한다.
PDF/설명용 화면: --pdf/--examples와 함께 Node, Playwright 모듈, Chrome의
실제 설치 경로를 지정한다. 설치·서비스 실행·운영 자료 접근은 하지 않는다.
"""
import argparse
import base64
import hashlib
import html
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

from markdown_it import MarkdownIt

DOCS = Path(__file__).resolve().parent
ROOT = DOCS.parent
ASSETS = DOCS / "assets" / "screenshots"

EXAMPLES = {
    "power-example.png": ("Windows 전원 설정에서 확인할 값", "서버 노트북 · 전원 연결 상태", '<div class="row"><b>화면 끄기</b><span>원하는 시간 선택 가능</span></div><div class="row important"><b>장치를 절전 모드로 전환</b><span>안 함</span></div><div class="row important"><b>덮개를 닫으면</b><span>계속 운영한다면: 아무 것도 안 함</span></div><p class="note">화면이 꺼지는 것과 PC가 잠드는 것은 다릅니다.</p>'),
    "wsl-version-example.png": ("배포판 이름과 WSL 버전 확인", "서버 PowerShell · 결과 형태를 설명하는 예시", '<pre>PS C:\\Users\\내계정&gt; wsl -l -v\n\n  NAME              STATE           VERSION\n* Ubuntu-24.04      Running         2</pre><div class="row important"><b>NAME</b><span>뒤의 -d 인수에 같은 이름 사용</span></div><div class="row important"><b>VERSION</b><span>2인지 확인</span></div>'),
    "doctor-example.png": ("API와 MCP를 따로 확인", "진단 JSON의 확인 위치 · 실제 실행 결과가 아님", '<pre>{\n  "connection": {\n    "api":        { "status": "ok", ... },\n    "mcp":        { "status": "ok", ... },\n    "comparison": { "status": "ok", ... }\n  },\n  "ok": true\n}</pre><p class="note">세 status와 전체 ok를 실제 내 PC의 출력에서 확인합니다.</p>'),
    "domain-example.png": ("Cloudflare 도메인 준비 순서", "메뉴 이름과 입력값의 종류를 설명하는 예시", '<div class="row"><b>① Domains</b><span>Onboard a domain / 도메인 추가</span></div><div class="row important"><b>② 기본 도메인</b><span>내도메인.net<br><small>https://와 wiki.는 넣지 않음</small></span></div><div class="row"><b>③ 기존 도메인</b><span>DNS 레코드 · DNSSEC · 네임서버 확인</span></div><div class="row important"><b>④ 상태</b><span>Active 확인 후 다음 단계</span></div>'),
    "tunnel-config-example.png": ("config.yml에서 바꿀 곳", "nano 편집 내용의 설명용 예시", '<pre>tunnel: <em>실제-UUID</em>\ncredentials-file: /home/wiki/.cloudflared/<em>실제-UUID</em>.json\ningress:\n  - hostname: <em>wiki.내도메인</em>\n    service: http://127.0.0.1:8766\n    originRequest:\n      httpHostHeader: 127.0.0.1:8766\n  - service: http_status:404</pre><p class="note">강조한 값은 실제 값으로 변경 · 내부 포트/Host는 유지</p>'),
    "dns-example.png": ("DNS에서 확인할 연결", "Cloudflare → 도메인 → DNS → Records", '<div class="row"><b>Type</b><span>CNAME</span></div><div class="row important"><b>Name</b><span>wiki</span></div><div class="row"><b>Target</b><span>실제-UUID.cfargotunnel.com</span></div><p class="note">이미 같은 이름을 사용 중이면 기존 서비스를 먼저 확인합니다.</p>'),
    "app-connection-example.png": ("Electron의 서버 연결 입력값", "제품 입력값의 설명용 예시 · 실제 Windows 앱 캡처 아님", '<div class="row important"><b>서버 기본 주소</b><span>https://wiki.내도메인<br><small>/mcp나 /api/v1을 추가하지 않음</small></span></div><div class="row"><b>개인 서버 토큰</b><span>••••••••••••••••••••<br><small>Cloudflare 비밀번호/터널 JSON과 다름</small></span></div><div class="row"><b>작업 공간 / 관점</b><span>허용 목록에서 personal / all 선택</span></div><div class="row"><b>자료 보기</b><span>연결 확인 → 문서 목록 보기</span></div>'),
}


def example_html(title, subtitle, content):
    return f'''<!doctype html><html lang="ko"><meta charset="utf-8"><style>
    *{{box-sizing:border-box}}body{{margin:0;padding:20px;background:#eaf0f7;color:#213a53;font:19px/1.6 "Apple SD Gothic Neo","Malgun Gothic",sans-serif}}
    article{{background:white;border:1px solid #cad8e6;border-radius:10px;overflow:hidden}}
    .notice{{padding:12px 24px;background:#fff0cf;color:#7b541b;font-size:15px;font-weight:700}}
    header{{padding:24px 28px 18px;background:#f0f5fa}}h1{{font-size:27px;margin:0 0 7px}}header p{{margin:0;font-size:16px;color:#60768b}}
    .content{{padding:15px 28px 22px}}.row{{display:grid;grid-template-columns:235px 1fr;gap:12px;padding:15px 13px;border-bottom:1px solid #dfe8f0;font-size:19px}}
    .important{{background:#eaf4fd;border-left:4px solid #2b79b6}}b{{font-size:18px}}small{{font-size:15px;color:#63768b}}
    pre{{padding:20px;background:#14283e;color:#f1f6fb;font:17px/1.85 Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:4px}}
    em{{font-style:normal;color:#ffd586;font-weight:bold}}.note{{font-size:16px;color:#526f87;margin:18px 0 0}}</style>
    <article><div class="notice">설명용 입력 예시 · 실제 Windows 촬영 / 서버 실행 결과가 아닙니다</div>
    <header><h1>{html.escape(title)}</h1><p>{html.escape(subtitle)}</p></header><div class="content">{content}</div></article></html>'''


CSS = r'''
:root{color-scheme:light;--blue:#225f91;--ink:#23394f;--muted:#607488;--line:#d8e3ed}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:20px}body{margin:0;background:#edf2f7;color:var(--ink);font:17px/1.85 "Apple SD Gothic Neo","Malgun Gothic",sans-serif}
a{color:#1a6199;text-underline-offset:3px}header.site{background:#163653;color:#fff;padding:38px max(24px,calc((100vw - 1250px)/2))}header.site h1{font-size:31px;line-height:1.45;margin:8px 0}header.site p{font-size:15px;color:#d0e0ed;margin:6px 0}
.layout{display:grid;grid-template-columns:245px minmax(0,960px);gap:27px;max-width:1280px;margin:26px auto;padding:0 22px;align-items:start}
aside{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto;padding:9px 0}aside a{display:block;text-decoration:none;font-size:12.5px;line-height:1.5;padding:5px 7px}aside summary{font-weight:700;font-size:14px;margin-bottom:10px;cursor:pointer}
main{background:white;border:1px solid var(--line);border-radius:8px;padding:32px 40px;min-width:0}.preamble{font-size:15px;color:var(--muted)}.preamble h1{display:none}
h2{font-size:27px;line-height:1.4;margin:38px 0 22px;border-top:2px solid #79a7ca;padding-top:20px;color:#123e62}h3{font-size:20px;line-height:1.5;margin:28px 0 15px}p{margin:15px 0}li{margin:8px 0}strong{color:#173a58}
.guide-step{padding-bottom:10px}.guide-step:first-of-type h2{margin-top:10px}figure{margin:25px 0;border:1px solid var(--line);background:#f8fbfd;border-radius:6px;padding:12px;break-inside:avoid}
figure a{display:block;text-align:center;cursor:zoom-in}figure img{display:block;max-width:100%;height:auto;max-height:670px;object-fit:contain;margin:auto}figcaption{font-size:12px;line-height:1.65;color:#61788e;margin-top:10px}
.codebox{border:1px solid #cbddeb;border-radius:5px;overflow:hidden;margin:21px 0}.codehead{background:#eaf2f9;display:flex;justify-content:space-between;align-items:center;padding:7px 12px;font-size:12px;font-weight:700}.copy{border:1px solid #b7cfe1;background:#fff;padding:3px 11px;border-radius:4px;color:#28587b;cursor:pointer}
code{font:14px/1.65 Menlo,Consolas,monospace;background:#edf3f8;overflow-wrap:anywhere;padding:1px 4px;border-radius:3px}pre{margin:0;padding:15px;overflow:auto;background:#f7fafc;line-height:1.7}pre code{white-space:pre;background:none;padding:0;overflow-wrap:normal}
.table-wrap{overflow:auto;margin:20px 0}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.7}th,td{border:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top;min-width:115px}th{background:#ecf3f9}td code{font-size:12px}
dialog{border:0;border-radius:8px;padding:15px;max-width:96vw;max-height:94vh}dialog::backdrop{background:#13263bdc}dialog img{max-width:90vw;max-height:82vh;object-fit:contain}.close{display:block;margin:0 0 10px auto;padding:5px 14px;cursor:pointer}
.print-cover,.print-toc{display:none}footer.site{text-align:center;font-size:12px;padding:25px;color:#63798c}
@media(max-width:900px){.layout{display:block;padding:0 12px;margin:14px auto}aside{position:static;max-height:240px;margin:10px}main{padding:22px 19px}header.site{padding:25px 22px}header.site h1{font-size:26px}h2{font-size:24px}}
@media print{
@page{size:A4;margin:15mm 15mm 18mm}html{scroll-behavior:auto}body{background:#fff;font-size:10.4pt;line-height:1.67;color:#1e354a}
header.site,aside,footer.site,dialog,.copy,.preamble{display:none!important}.layout{display:block;margin:0;padding:0;max-width:none}main{padding:0;border:0;border-radius:0}
.guide-step{break-before:page;padding:0}.guide-step h2{font-size:19pt;line-height:1.4;margin:0 0 5mm;border-top:2pt solid #7da8c8;padding:3mm 0 0;break-after:avoid}
h3{font-size:13pt;margin:6mm 0 3mm;break-after:avoid}p{margin:2.8mm 0;orphans:3;widows:3}ul,ol{padding-left:6mm;margin:3mm 0}li{margin:1.7mm 0;orphans:2;widows:2}
figure{padding:2.5mm;margin:4mm 0;border-radius:1.5mm;break-inside:avoid}figure img{max-height:100mm!important;max-width:100%!important}figcaption{font-size:7.8pt;line-height:1.5;margin-top:2mm}
.codebox{margin:3mm 0;border-radius:1mm;break-inside:avoid;overflow:visible}.codehead{font-size:7.6pt;padding:1.6mm 2.5mm}pre{padding:2.5mm;overflow:visible;line-height:1.5}pre code{font-size:8.2pt;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
code{font-size:8.4pt;line-height:1.6;overflow-wrap:anywhere}.codebox.long{break-inside:auto}.codebox.long pre code{font-size:7.6pt;line-height:1.4}
.table-wrap{overflow:visible;margin:3.7mm 0}table{font-size:9pt;line-height:1.5;table-layout:fixed;break-inside:auto}th,td{min-width:0;padding:2.2mm 2.7mm;overflow-wrap:anywhere}td code{font-size:7.7pt}thead{display:table-header-group}tr{break-inside:avoid}
a{text-decoration:none;overflow-wrap:anywhere;color:#235f8d}.print-cover{display:block;height:249mm;padding:15mm 4mm 0;break-after:page;position:relative}.print-cover .eyebrow{font-size:9pt;letter-spacing:2px;color:#3c7aa9;font-weight:bold}
.print-cover .rule{height:2mm;width:22mm;background:#2679b4;margin:14mm 0}.print-cover h1{font-size:33pt;line-height:1.4;color:#173f60;margin:0 0 10mm;letter-spacing:-.7px}.print-cover .subtitle{font-size:16pt;line-height:1.6;color:#536f86}
.cover-box{background:#eef5fb;border-left:3px solid #408bbd;padding:6mm;margin:13mm 0 8mm;font-size:11pt;line-height:1.9}.cover-meta{font-size:9.5pt;color:#526f84;line-height:2}.cover-date{position:absolute;bottom:4mm;left:4mm;font-size:9pt;color:#6a8094}
.print-toc{display:block;break-after:page;padding:6mm 2mm 0}.print-toc h1{font-size:24pt;color:#1b4668;margin:0 0 3mm}.print-toc p{color:#6a8093;font-size:9pt}.print-toc nav{columns:2;column-gap:9mm;margin-top:6mm}.print-toc a{display:block;font-size:9pt;line-height:1.5;margin-bottom:2.2mm;break-inside:avoid}.print-toc small{font-size:8pt;color:#657b8e;display:block;border-top:1px solid #cbddea;margin-top:6mm;padding-top:3mm}
.guide-step[data-step="11"]{font-size:9.5pt;line-height:1.5}.guide-step[data-step="11"] .codebox.long pre{padding:2mm}.guide-step[data-step="11"] p{margin:2mm 0}
.guide-step[data-step="26"] figure img,.guide-step[data-step="27"] figure img,.guide-step[data-step="28"] figure img,.guide-step[data-step="29"] figure img,.guide-step[data-step="30"] figure img{max-height:110mm!important}
.guide-step[data-step="06"] figure img{max-height:78mm!important}.guide-step[data-step="28"] figure img{max-height:83mm!important}.guide-step[data-step="30"] figure img{max-height:97mm!important}
}
'''


def make_html():
    parser = MarkdownIt("commonmark", {"html": True}).enable("table")
    tokens = parser.parse((DOCS / "WSL2_SERVER_GUIDE.md").read_text())
    headings = []
    for i, token in enumerate(tokens):
        if token.type != "heading_open":
            continue
        title = tokens[i + 1].content
        # PDF의 named destination 길이 제한을 지키도록 짧은 ASCII ID를 쓴다.
        slug = f"section-{i}"
        token.attrSet("id", slug)
        if token.tag == "h2":
            headings.append((slug, title))

    def image_rule(items, i, options, env):
        token = items[i]
        path = (DOCS / token.attrGet("src")).resolve()
        if not path.is_relative_to(ASSETS) or path.suffix != ".png":
            raise ValueError("Expected local guide PNG")
        uri = "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()
        caption = html.escape(token.content)
        return f'<figure><a href="{uri}" class="zoom"><img src="{uri}" alt="{caption}"></a><figcaption>{caption}</figcaption></figure>'

    def fence(items, i, options, env):
        token = items[i]
        label = {"bash": "서버 Ubuntu에서 입력", "powershell": "Windows PowerShell에서 입력", "yaml": "설정 파일에 입력", "text": "입력할 값"}.get(token.info, "입력 내용")
        size = " long" if len(token.content.splitlines()) > 24 else ""
        return f'<div class="codebox{size}"><div class="codehead"><span>{label}</span><button class="copy">복사</button></div><pre><code>{html.escape(token.content)}</code></pre></div>'

    parser.renderer.rules["image"] = image_rule
    parser.renderer.rules["fence"] = fence
    pieces = ['<div class="preamble">']
    section = False
    for i, token in enumerate(tokens):
        if token.type == "heading_open" and token.tag == "h2":
            pieces.append('</section>' if section else '</div>')
            step = tokens[i + 1].content.split(" ", 1)[0]
            pieces.append(f'<section class="guide-step" data-step="{html.escape(step)}">')
            section = True
        pieces.append(parser.renderer.render([token], parser.options, {}))
    pieces.append('</section>')
    nav = "".join(f'<a href="#{html.escape(slug)}">{html.escape(title)}</a>' for slug, title in headings)
    doc = f'''<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>처음부터 따라하는 Windows 서버 설치</title><style>{CSS}</style></head><body>
    <section class="print-cover"><div class="eyebrow">LLM WIKI · BEGINNER'S SETUP GUIDE</div><div class="rule"></div><h1>처음부터 따라하는<br>Windows 서버 설치</h1><p class="subtitle">집 밖에서도 접속하는<br>WSL2 · FastAPI · MCP 서버 만들기</p><div class="cover-box">어느 PC와 창에서 진행할지<br>무엇을 누르고 입력할지<br>어떤 결과가 나와야 다음으로 갈지</div><div class="cover-meta">36단계 · 화면과 입력 예시 · 오류 해결 · 재부팅 확인<br>고정 HTTPS: Cloudflare Tunnel 경로<br>기존 데이터 보존 이전: 별도 부록</div><p class="cover-date">2026. 10. 26. · 현재 코드 기준 · 실제 Windows 배포는 현장 확인 필요</p></section>
    <section class="print-toc"><h1>순서대로 따라하기</h1><p>제목을 누르면 해당 단계로 이동합니다. 처음 설치는 00~32, 앱 연결은 33을 확인하세요.</p><nav>{nav}</nav><small>공식 참고 화면과 설명용 예시를 구분했습니다. 화면 안의 다른 예시 값 대신 본문의 입력값을 사용하세요.</small></section>
    <header class="site"><small>LLM WIKI · BEGINNER'S SETUP GUIDE</small><h1>처음부터 따라하는 Windows 서버 설치</h1><p>집 밖 접속 · 단계별 화면 · 입력 명령 · 완료 기준 · 막힐 때 확인할 곳</p></header>
    <div class="layout"><aside><details class="toc" open><summary>순서 바로가기</summary>{nav}</details></aside><main>{''.join(pieces)}</main></div>
    <footer class="site">원문: WSL2_SERVER_GUIDE.md · 공식 참고 화면 + 설명용 입력 예시 · 실제 배포 성공 기록과 구분합니다.</footer>
    <dialog><button class="close">닫기</button><img alt="확대한 참고 화면"></dialog>
    <script>
    document.querySelectorAll('table').forEach(t=>{{const w=document.createElement('div');w.className='table-wrap';t.before(w);w.append(t)}});
    const toc=document.querySelector('.toc'), narrow=matchMedia('(max-width:900px)');toc.open=!narrow.matches;
    document.querySelectorAll('.copy').forEach(b=>b.onclick=async()=>{{const t=b.closest('.codebox').querySelector('code').textContent;await navigator.clipboard.writeText(t);b.textContent='복사됨';setTimeout(()=>b.textContent='복사',1600)}});
    const d=document.querySelector('dialog');document.querySelectorAll('.zoom').forEach(a=>a.onclick=e=>{{e.preventDefault();d.querySelector('img').src=a.href;d.showModal()}});d.querySelector('.close').onclick=()=>d.close();
    </script></body></html>'''
    target = DOCS / "WSL2_SERVER_GUIDE.html"
    target.write_text(doc, encoding="utf-8")
    return target


DRIVER = r'''
import {pathToFileURL} from 'node:url';import fs from 'node:fs/promises';
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const {chromium}=await import(pathToFileURL(config.playwright).href);
const browser=await chromium.launch({executablePath:config.browser,headless:true});
try{const page=await browser.newPage({viewport:{width:1000,height:1100},deviceScaleFactor:1.5});
if(config.examples){for(const ex of config.examples){await page.setContent(ex.html);await page.evaluate(()=>document.fonts.ready);await page.locator('article').screenshot({path:ex.path})}}
if(config.source){const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(pathToFileURL(config.source).href);await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll('figure img')].map(i=>i.decode()))});
await page.evaluate(()=>{document.querySelectorAll('figure a').forEach(a=>a.replaceWith(...a.childNodes));document.querySelectorAll('main a').forEach(a=>{const h=a.getAttribute('href');if(h&&!/^(https?:|#)/.test(h))a.removeAttribute('href')})});
await page.emulateMedia({media:'print'});const result=await page.evaluate(()=>({images:[...document.querySelectorAll('figure img')].map(i=>({alt:i.alt,loaded:i.complete&&i.naturalWidth>0})),blocks:[...document.querySelectorAll('main .guide-step p,main .guide-step li,main pre,main td,main th,main figcaption')].map(e=>e.textContent),headings:[...document.querySelectorAll('main h2,main h3')].map(e=>e.textContent),overflow:[...document.querySelectorAll('main pre,main table,main figure')].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>e.tagName)}));
if(result.images.some(i=>!i.loaded)||result.overflow.length||errors.length)throw new Error(JSON.stringify({errors,...result}));
await page.pdf({path:config.output,format:'A4',preferCSSPageSize:true,printBackground:true,tagged:true,outline:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="width:100%;margin:0 15mm;display:flex;justify-content:space-between;font:8px Arial;color:#708294"><span>LLM WIKI · WINDOWS SERVER SETUP</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'});
await fs.writeFile(config.qa,JSON.stringify({...result,errors}));console.log(JSON.stringify({output:config.output,images:result.images.length,headings:result.headings.length,blocks:result.blocks.length,overflow:result.overflow,errors}));}}
finally{await browser.close()}
'''


def browser_operation(args, **config):
    if not args.playwright or not args.browser:
        raise SystemExit("--examples/--pdf requires --playwright and --browser paths")
    node = args.node or shutil.which("node")
    if not node:
        raise SystemExit("Node executable not found")
    with tempfile.TemporaryDirectory(prefix="guide-browser-") as temporary:
        tmp = Path(temporary)
        (tmp / "driver.mjs").write_text(DRIVER)
        (tmp / "config.json").write_text(json.dumps({"playwright": args.playwright, "browser": args.browser, **config}))
        subprocess.run([str(node), str(tmp / "driver.mjs"), str(tmp / "config.json")], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", action="store_true")
    parser.add_argument("--examples", action="store_true")
    parser.add_argument("--node")
    parser.add_argument("--playwright")
    parser.add_argument("--browser")
    parser.add_argument("--qa", type=Path)
    args = parser.parse_args()
    if args.examples:
        browser_operation(args, examples=[{"path": str(ASSETS / name), "html": example_html(*values)} for name, values in EXAMPLES.items()])
        manifest = json.loads((ASSETS / "SOURCES.json").read_text())
        manifest["assets"] = [item for item in manifest["assets"] if item["type"] != "illustrative_input"]
        for name in EXAMPLES:
            raw = (ASSETS / name).read_bytes()
            manifest["assets"].append({"file": name, "type": "illustrative_input", "creator": "This guide; HTML rendering", "not_actual_windows_capture": True, "not_execution_evidence": True, "sha256": hashlib.sha256(raw).hexdigest(), "dimensions": list(struct.unpack(">II", raw[16:24]))})
        (ASSETS / "SOURCES.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    source = make_html()
    print("HTML:", source)
    if args.pdf:
        output = ROOT / "output" / "pdf" / "WSL2_SERVER_GUIDE.pdf"
        output.parent.mkdir(parents=True, exist_ok=True)
        qa = args.qa or output.with_suffix(".qa.json")
        browser_operation(args, source=str(source), output=str(output), qa=str(qa))


if __name__ == "__main__":
    main()
