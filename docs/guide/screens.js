window.LLM_WIKI_SCREENS = {
  "assets/login.png": {
    "width": 1440,
    "height": 960,
    "label": "실제 앱 화면 · 연습용 자료",
    "description": "로그인 탭에서 계정 이름과 예시 서버 주소를 입력한 상태입니다.",
    "hotspots": [
      {
        "label": "회원가입",
        "rect": {
          "x": 720,
          "y": 380.109,
          "width": 197,
          "height": 41.531
        }
      },
      {
        "label": "계정 이름",
        "rect": {
          "x": 523,
          "y": 464.641,
          "width": 394,
          "height": 36
        }
      },
      {
        "label": "서버 주소",
        "rect": {
          "x": 523,
          "y": 542.641,
          "width": 394,
          "height": 36
        }
      },
      {
        "label": "로그인",
        "rect": {
          "x": 523,
          "y": 598.641,
          "width": 394,
          "height": 36
        }
      }
    ],
    "source": "기존 app/tests/document-comparison의 전용 BrowserWindow와 격리 HTTP 서버를 재사용했습니다. 임시 서버의 표시명·신규 계정·가상 본문만 준비하고 기존 제품 renderer/preload로 촬영했습니다. 실제 AI는 호출하지 않았습니다."
  },
  "assets/ai-settings.png": {
    "width": 1440,
    "height": 960,
    "label": "실제 앱 화면 · 연습용 자료",
    "description": "개인 AI 연결을 시작하는 설정 화면입니다. 아직 로그인과 실제 응답을 확인하지 않은 상태입니다.",
    "hotspots": [
      {
        "label": "AI 실행",
        "rect": {
          "x": 325.766,
          "y": 93,
          "width": 62.906,
          "height": 36
        }
      },
      {
        "label": "Codex 로그인",
        "rect": {
          "x": 1273.516,
          "y": 270.812,
          "width": 96.484,
          "height": 28.594
        }
      },
      {
        "label": "프로그램 위치 · 문서 처리 진단",
        "rect": {
          "x": 269,
          "y": 390.406,
          "width": 1118,
          "height": 39.375
        }
      }
    ],
    "source": "기존 app/tests/document-comparison의 전용 BrowserWindow와 격리 HTTP 서버를 재사용했습니다. 임시 서버의 표시명·신규 계정·가상 본문만 준비하고 기존 제품 renderer/preload로 촬영했습니다. 실제 AI는 호출하지 않았습니다."
  },
  "assets/import.png": {
    "width": 1440,
    "height": 960,
    "label": "실제 앱 화면 · 연습용 자료",
    "description": "텍스트 붙여넣기로 자료를 입력한 상태입니다. 등록하기 전 화면입니다.",
    "hotspots": [
      {
        "label": "문서 제목",
        "rect": {
          "x": 249,
          "y": 200,
          "width": 1158,
          "height": 36
        }
      },
      {
        "label": "본문",
        "rect": {
          "x": 249,
          "y": 274,
          "width": 1158,
          "height": 256
        }
      },
      {
        "label": "등록하고 관계 추출",
        "rect": {
          "x": 1283.875,
          "y": 572,
          "width": 123.125,
          "height": 36
        }
      }
    ],
    "source": "기존 app/tests/document-comparison의 전용 BrowserWindow와 격리 HTTP 서버를 재사용했습니다. 임시 서버의 표시명·신규 계정·가상 본문만 준비하고 기존 제품 renderer/preload로 촬영했습니다. 실제 AI는 호출하지 않았습니다."
  },
  "assets/document.png": {
    "width": 1440,
    "height": 960,
    "label": "실제 앱 화면 · 연습용 자료",
    "description": "예시 문서의 본문을 연 상태입니다. 이 예시는 원본 연결과 추출된 관계가 없는 문서입니다.",
    "hotspots": [
      {
        "label": "관계 재추출",
        "rect": {
          "x": 1190.625,
          "y": 16,
          "width": 109.812,
          "height": 36
        }
      },
      {
        "label": "본문 편집",
        "rect": {
          "x": 1308.438,
          "y": 16,
          "width": 98.562,
          "height": 36
        }
      },
      {
        "label": "버전",
        "rect": {
          "x": 485.375,
          "y": 81,
          "width": 135.344,
          "height": 28
        }
      }
    ],
    "source": "기존 app/tests/document-comparison의 전용 BrowserWindow와 격리 HTTP 서버를 재사용했습니다. 임시 서버의 표시명·신규 계정·가상 본문만 준비하고 기존 제품 renderer/preload로 촬영했습니다. 실제 AI는 호출하지 않았습니다."
  },
  "assets/edit.png": {
    "width": 1440,
    "height": 960,
    "label": "실제 앱 화면 · 연습용 자료",
    "description": "문서의 본문을 편집 중인 화면입니다. 변경한 초안을 저장하기 전 상태입니다.",
    "hotspots": [
      {
        "label": "본문",
        "rect": {
          "x": 298,
          "y": 222,
          "width": 1108,
          "height": 460.75
        }
      },
      {
        "label": "변경 내용 확인",
        "rect": {
          "x": 1249.859,
          "y": 16,
          "width": 100.641,
          "height": 36
        }
      },
      {
        "label": "저장",
        "rect": {
          "x": 1358.5,
          "y": 16,
          "width": 48.5,
          "height": 36
        }
      }
    ],
    "source": "기존 app/tests/document-comparison의 전용 BrowserWindow와 격리 HTTP 서버를 재사용했습니다. 임시 서버의 표시명·신규 계정·가상 본문만 준비하고 기존 제품 renderer/preload로 촬영했습니다. 실제 AI는 호출하지 않았습니다."
  },
  "assets/sessions.png": {
    "width": 1440,
    "height": 960,
    "label": "실제 앱 화면 · 연습용 자료",
    "description": "아직 실행한 AI 작업이 없는 새 계정의 화면입니다. 실행 후에는 이곳에서 작업과 결과를 확인합니다.",
    "hotspots": [
      {
        "label": "지난 기록",
        "rect": {
          "x": 1205.453,
          "y": 16,
          "width": 98.562,
          "height": 36
        }
      },
      {
        "label": "새로고침",
        "rect": {
          "x": 1312.016,
          "y": 16,
          "width": 94.984,
          "height": 36
        }
      }
    ],
    "source": "기존 app/tests/document-comparison의 전용 BrowserWindow와 격리 HTTP 서버를 재사용했습니다. 임시 서버의 표시명·신규 계정·가상 본문만 준비하고 기존 제품 renderer/preload로 촬영했습니다. 실제 AI는 호출하지 않았습니다."
  },
  "assets/chat.png": {
    "width": 1440,
    "height": 960,
    "label": "실제 앱 화면 · 모의 AI 답변",
    "description": "질문 입력과 답변 내려받기 위치를 보여 줍니다. 화면의 답변은 모의 예시입니다.",
    "hotspots": [
      {
        "label": "질문 입력",
        "rect": {
          "x": 487,
          "y": 814,
          "width": 906,
          "height": 22
        }
      },
      {
        "label": "질문 보내기",
        "rect": {
          "x": 1365,
          "y": 842,
          "width": 28,
          "height": 28
        }
      },
      {
        "label": "내려받기",
        "rect": {
          "x": 673,
          "y": 419,
          "width": 103,
          "height": 26
        }
      }
    ],
    "source": "Generic in-memory chat fixture adapted from app/tests/chat-states/renderer.tsx; current KnowledgeChatPage/AppShell"
  },
  "assets/evidence.png": {
    "width": 1440,
    "height": 960,
    "label": "실제 앱 화면 · 모의 AI 답변",
    "description": "모의 답변의 근거 칩을 눌러 인용과 원문 위치를 펼친 상태입니다.",
    "hotspots": [
      {
        "label": "인용과 원문",
        "rect": {
          "x": 1063,
          "y": 77,
          "width": 360,
          "height": 840
        }
      },
      {
        "label": "근거",
        "rect": {
          "x": 537,
          "y": 387,
          "width": 118,
          "height": 24
        }
      }
    ],
    "source": "Generic in-memory chat fixture; document 예시-운영-안내.md"
  },
  "assets/ontology.png": {
    "width": 1440,
    "height": 960,
    "label": "실제 앱 화면 · 연습용 자료",
    "description": "검색한 개념을 선택해 관계와 원문 설명을 펼친 연습용 예시입니다.",
    "hotspots": [
      {
        "label": "원문 열기",
        "rect": {
          "x": 1187,
          "y": 439,
          "width": 45,
          "height": 24
        }
      },
      {
        "label": "개념 상세",
        "rect": {
          "x": 1072,
          "y": 100,
          "width": 360,
          "height": 786
        }
      },
      {
        "label": "화면에 맞춤",
        "rect": {
          "x": 1328,
          "y": 889,
          "width": 91,
          "height": 32
        }
      }
    ],
    "source": "Generic synthetic document created with WikiStore/OntologyStore in isolated /private/tmp/wiki-guide-generic- workspace; current App renderer"
  },
  "assets/review.png": {
    "width": 1440,
    "height": 960,
    "label": "실제 앱 화면 · 연습용 자료",
    "description": "원문 관계를 읽고 승인을 선택해 이유를 작성한 상태입니다. 실제 판단 저장은 하지 않았습니다.",
    "hotspots": [
      {
        "label": "판단 선택",
        "rect": {
          "x": 634,
          "y": 341,
          "width": 751,
          "height": 32
        }
      },
      {
        "label": "이유",
        "rect": {
          "x": 634,
          "y": 415,
          "width": 751,
          "height": 54
        }
      },
      {
        "label": "저장",
        "rect": {
          "x": 634,
          "y": 479,
          "width": 49,
          "height": 32
        }
      }
    ],
    "source": "Same generic isolated document and current review queue API; approval form only, no review write"
  }
};
