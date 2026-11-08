# LLM Wiki 설명 이미지 제작 정보

기준일: 2026-10-30

문서의 개념과 흐름을 설명하는 PNG 이미지다. 내장 이미지 생성 도구로 제작하고 문구·화살표·의미를 검토했다. 실제 제품 화면이나 실행 결과의 캡처가 아니다.

| 이미지 | 설명 |
| --- | --- |
| [전체 개념도](product-overview.png) | 원본, Wiki, AI 지식, 활용과 선택적 검토 |
| [추출 방침](extraction-policy.png) | 문장 예시, 계획과 사실의 구별, 검사·저장 흐름 |
| [시스템 구성도](system-architecture.png) | 개인 PC의 실행과 중앙 서버의 권한·저장 책임 |

생성된 PNG 파일을 수정 없이 보관한다. 시스템 구성도는 인터페이스를 거친 권한 검사 경로가 분명하도록 아래 후속 요청으로 편집한 최종본이다. 문서의 Mermaid 정의는 상세 흐름을 편집할 수 있는 별도 표현으로 유지한다.

## 생성 요청문

### product-overview

```text
Create a polished Korean educational infographic for a software product's development documentation. Landscape canvas, approximately 1800 x 1100 pixels, generous margins. Crisp flat vector-like editorial design rendered as a high-resolution PNG, pure white background, dark navy Korean sans-serif typography, restrained teal and blue for flows, amber for human judgment. Large legible Korean text with perfect spelling. Use thin connectors, simple meaningful line icons, numbered cards, ample whitespace, no gradients or 3D, no decorative robots, no screenshots, no watermark. Only display the exact short Korean labels below (and explicit English technical names). Content must be faithful, readable when embedded in a Markdown document. Do not invent extra facts or features.
Title: "LLM Wiki 한눈에 보기"
Subtitle: "문서와 근거, 사람의 판단을 함께 쌓는 지식 공간"
Main horizontal flow with four equally sized cards, left to right:
1. "원본 보관" with document/file icon. supporting lines "파일 · 직접 입력" and "등록한 자료 그대로 보관"
2. "Wiki 본문" with editable document icon. supporting lines "읽고 편집하는 Markdown" and "수정 전 전체 이력 보존"
3. "AI 지식 추출" with three-node graph icon. supporting lines "개체 · 관계 · 속성" and "원문 근거 · 조건 · 판본"
4. "탐색과 활용" with search/chat icon. supporting lines "그래프 · 질문 · 초안"
Use obvious single-direction arrows connecting cards 1 → 2 → 3 → 4.
Below the AI extraction card put a separate amber card titled "필요할 때 사람의 검토" with two lines "원문에 맞는 해석 정정" and "별도 출처의 전문가 판단". Connect this card to the knowledge/use flow using a dashed line with a label "선택적 검토". Do not depict expert review as a mandatory blocking step. Do not show human judgment overwriting the original source.
Use a clearly routed return arrow along the bottom from card 4 to card 2 labeled "초안은 사용자가 확인하고 Wiki에 반영".
Footer banner exactly: "원문 · AI 해석 · 전문가 판단은 구별해 보관합니다."
Ensure exact readable Korean labels and a clear single cycle, no duplicated labels.
```

### extraction-policy

```text
Create a polished Korean educational infographic for a software product's development documentation. Landscape canvas, approximately 1800 x 1100 pixels, generous margins. Crisp flat vector-like editorial design rendered as a high-resolution PNG, pure white background, dark navy Korean sans-serif typography, restrained teal and blue for flows, amber for human judgment. Large legible Korean text with perfect spelling. Use thin connectors, simple meaningful line icons, numbered cards, ample whitespace, no gradients or 3D, no decorative robots, no screenshots, no watermark. Only display the exact short Korean labels below (and explicit English technical names). Content must be faithful, readable when embedded in a Markdown document. Do not invent extra facts or features.
Title: "문장에서 지식을 추출하는 방법"
Subtitle: "원문의 의미와 근거를 함께 보존합니다"
Top half: a large pale blue source quote card titled "원문 예시" containing exactly "팀 A는 다음 달부터 시스템 B를 사용할 계획이다."
Below the quote, display a clean node relationship diagram:
left node "팀 A", right node "시스템 B", a rightward arrow labeled "사용 계획".
Two small tags under the arrow: "양태: 계획" and "시점: 다음 달부터".
Beside or beneath it a short explanatory note: "계획을 실제 사용 사실로 바꾸지 않습니다."
Lower half: a compact horizontal process with four numbered blocks:
"본문·규약 고정" → "주장·조건 추출" → "구조·인용 검사" → "판본·권한 확인 후 저장".
A return arrow from the 검사 block back to 추출 below the process reads "수정 가능한 검사 오류만 재추출 · 최대 2회". Avoid showing retry for permission or source revision changes.
An amber side note titled "추정 후보" says "근거와 가정을 구별" and "추가 확인 필요". Visually separate it from the source-backed relationship; never imply an accepted fact.
Footer banner exactly: "검사 통과 ≠ 의미의 정확성 ≠ 전문가 승인"
Use short labels and large Korean typography. The source quotation and its time phrase must be exact. No made-up dates, no English schema dump, no source code.
```

### system-architecture

```text
Create a polished Korean educational infographic for a software product's development documentation. Landscape canvas, approximately 1800 x 1100 pixels, generous margins. Crisp flat vector-like editorial design rendered as a high-resolution PNG, pure white background, dark navy Korean sans-serif typography, restrained teal and blue for flows, amber for human judgment. Large legible Korean text with perfect spelling. Use thin connectors, simple meaningful line icons, numbered cards, ample whitespace, no gradients or 3D, no decorative robots, no screenshots, no watermark. Only display the exact short Korean labels below (and explicit English technical names). Content must be faithful, readable when embedded in a Markdown document. Do not invent extra facts or features.
Title: "내 PC와 중앙 서버의 역할"
Subtitle: "AI 실행과 지식 보관의 책임을 나눕니다"
Layout two clearly bounded regions, left approximately 52% labeled "개인 PC", right approximately 40% labeled "중앙 서버", with a narrow connector gap.
Within left personal PC region:
upper box "Electron 앱" supporting "화면 · 입력 · 실행 관리"
lower central box "개인 실행기"
below it two sibling boxes "AI CLI" with supporting "Codex / Claude Code" and "문서 변환 · OCR".
Connect Electron 앱 downward to 개인 실행기, then connect 개인 실행기 to both AI CLI and 문서 변환 · OCR. Do not connect AI CLI itself directly to server storage.
Within right central server region:
top two endpoint pills "API" and "MCP".
Both point to central box "권한 확인 · 업무 처리".
This box points to storage area "문서 · 지식 · 전체 이력".
Use obvious labeled cross-region routes: Electron 앱 connects to API with label "조회 · 편집"; 개인 실행기 connects to both API and MCP with label "입력 · 규약 · 결과 제출". These routes should not cross text; use tidy right angle connectors.
Bottom inside PC region label "AI와 변환은 개인 PC에서 실행".
Bottom inside server region label "자료 · 권한 · 저장 결과 관리".
A full-width footer note says exactly "원본 · 편집 문서 · AI 추출 · 전문가 판단을 구분해 보관합니다."
No cloud provider logos, no claim that models are hosted entirely offline on PC, no AI model drawn inside server. The AI CLI is locally executed, not an assertion of local model inference. No token values, IP addresses, usernames, or secrets. Make structure instantly understandable.
```

## 시스템 구성도 편집 요청문

```text
Edit this Korean system architecture infographic. Keep the same polished navy/teal/amber visual style, all the same accurate Korean labels, the title/subtitle, two environment panels and the footer. Correct the server connector topology, which is currently ambiguous: every request must enter an API or MCP interface BEFORE the authorization/business logic. The personal runner must NOT connect directly to the business logic, and arrowheads must point from interfaces TO the business logic, not backwards.

You may rearrange the server panel and widen it for clean arrows. Use this simple clear layout:
Left panel 45% width "개인 PC", containing "Electron 앱" at top, "개인 실행기" in middle, and its two children "AI CLI" ("Codex / Claude Code") plus "문서 변환 · OCR" at bottom, with downward local execution arrows.
Right panel 50% width "중앙 서버", with a narrow INTERFACE column on its LEFT and a SERVICE column on its RIGHT.
Interface column contains TWO stacked boxes:
upper: "API" with small label "앱 조회 · 편집";
lower: "API / MCP" with small label "분석 입력 · 규약 · 결과".
These are two logical access paths, not two servers.
The Electron app connects horizontally only to upper API box. The personal runner connects horizontally only to lower API / MCP box. Ensure no direct arrow from personal runner to a service or storage.
From the right edge of BOTH interface boxes, arrows point RIGHT into the "권한 확인 · 업무 처리" box in the service column. Below it, a DOWN arrow points to "문서 · 지식 · 전체 이력". Route edges cleanly with bends as needed. No arrows pointing from service to interfaces. No shared cross-region bus with ambiguous branching.
Preserve bottom captions "AI와 변환은 개인 PC에서 실행", "자료 · 권한 · 저장 결과 관리", and footer "원본 · 편집 문서 · AI 추출 · 전문가 판단을 구분해 보관합니다."
If needed omit the old external edge captions because the small interface captions now express them. Keep exact Korean spelling, ample whitespace, legible text, all components within their environment panels. Title remains "내 PC와 중앙 서버의 역할".
```
