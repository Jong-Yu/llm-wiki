window.LLM_WIKI_GUIDE = {
  courses: [
    {
      id: 'start',
      title: '처음 시작하기',
      description: '서버와 개인 AI를 연결하고 첫 자료를 등록합니다.',
    },
    {
      id: 'use',
      title: '지식 활용하기',
      description: '본문과 관계를 살펴보고 근거가 있는 답변을 파일로 받습니다.',
    },
    {
      id: 'manage',
      title: '수정하고 관리하기',
      description: '본문을 고치고 관계를 검토하며 실행 상태를 확인합니다.',
    },
  ],
  steps: [
    {
      id: 'sign-in',
      course: 'start',
      title: '서버 계정으로 시작하기',
      image: 'assets/login.png',
      focus: ['계정 이름', '서버 주소', '로그인', '가입하고 시작'],
      lead: '문서가 보관된 서버에 내 계정으로 접속합니다.',
      actions: [
        {
          title: '가입 또는 로그인 선택',
          text: '실제 앱에서 처음 사용하는 계정은 회원가입, 기존 계정은 로그인을 선택합니다.',
        },
        {
          title: '이름과 서버 입력',
          text: '계정 이름과 안내받은 서버 주소를 입력하고 가입하고 시작 또는 로그인을 누릅니다.',
        },
        {
          title: '작업 공간 확인',
          text: '접속 후 현재 작업 공간이 사용할 자료가 있는 공간인지 확인합니다.',
        },
      ],
      expected: '로그인 화면을 지나 작업 공간의 문서 화면이 열립니다.',
      tip: '앱 로그인과 개인 AI 로그인은 별개이므로 다음 장면에서 AI도 연결하세요.',
      anchor: '../USER_GUIDE.md#서버에-가입하고-로그인하기',
    },
    {
      id: 'connect-ai',
      course: 'start',
      title: '개인 AI 연결하기',
      image: 'assets/ai-settings.png',
      focus: ['AI 실행', 'Codex 로그인', '프로그램 위치 · 문서 처리 진단'],
      lead: '사용할 AI의 CLI를 이 컴퓨터에 먼저 설치한 뒤 앱에서 연결합니다.',
      preparation: {
        title: '먼저 Codex CLI 또는 Claude Code CLI를 설치하세요',
        text: 'LLM Wiki에는 AI CLI가 포함되어 있지 않습니다. 사용할 CLI를 공식 안내에 따라 이 PC에 내려받아 설치하고, 같은 OS 사용자로 로그인해야 합니다.',
        check: '설치 후 새 터미널에서 codex --version 또는 claude --version으로 버전이 표시되는지 확인하세요. 앱의 로그인 버튼은 CLI를 설치하는 버튼이 아닙니다.',
        links: [
          { label: 'Codex CLI 공식 설치 안내', href: 'https://learn.chatgpt.com/docs/codex/cli' },
          { label: 'Claude Code 공식 설치 안내', href: 'https://code.claude.com/docs/en/setup' },
        ],
      },
      actions: [
        {
          title: 'AI 선택',
          text: '실제 앱의 설정에서 AI 실행을 열고 사용할 Codex 또는 Claude Code를 선택합니다.',
        },
        {
          title: '로그인 완료',
          text: '선택한 AI의 로그인 버튼을 누르고 열린 터미널이나 브라우저에서 로그인을 마칩니다.',
        },
        {
          title: '연결 상태 확인',
          text: '앱으로 돌아와 로그인 완료 확인을 누릅니다. 실제 응답까지 확인하려면 AI 호출 확인을 사용합니다.',
        },
      ],
      expected: '로그인 확인 또는 실제 AI 응답을 확인한 연결 상태가 표시됩니다.',
      tip: 'AI 호출 확인은 개인 계정의 실제 사용량에 반영될 수 있습니다.',
      anchor: '../USER_GUIDE.md#ai-연결-전에-cli-설치하기',
    },
    {
      id: 'import-source',
      course: 'start',
      title: '첫 자료 등록하기',
      image: 'assets/import.png',
      focus: ['파일 선택', '문서 제목', '본문', '등록하고 관계 추출'],
      lead: '파일이나 붙여넣은 글을 원본으로 보관하고 문서와 관계를 만듭니다.',
      actions: [
        {
          title: '등록 방식 선택',
          text: '실제 앱에서 문서 → 문서 등록을 열고 파일 업로드 또는 텍스트 붙여넣기를 선택합니다.',
        },
        {
          title: '자료 입력',
          text: '파일 한 개를 선택하거나 문서 제목과 본문을 입력한 뒤 등록하고 관계 추출을 누릅니다.',
        },
        {
          title: '단계별 완료 확인',
          text: '원본 보관 → 문자 변환 → 문서 저장 → 관계 추출을 확인하고 문서 열기로 이동합니다.',
        },
      ],
      expected: '저장된 문서와 추출한 관계를 여는 버튼이 표시됩니다.',
      tip: '등록 결과가 불확실하면 새로 등록하기 전에 원래 요청의 결과 확인을 사용하세요.',
      anchor: '../USER_GUIDE.md#자료-등록하기',
    },
    {
      id: 'read-document',
      course: 'use',
      title: '저장된 본문 읽기',
      image: 'assets/document.png',
      focus: ['버전'],
      lead: '등록한 자료가 어떤 문서로 저장되었는지 확인합니다.',
      actions: [
        {
          title: '문서 열기',
          text: '실제 앱의 등록 결과에서 문서 열기를 누르거나 문서 목록에서 원하는 문서를 엽니다.',
        },
        {
          title: '본문과 상태 확인',
          text: '내용을 읽고 문서 정보, 버전과 관계 상태를 확인합니다.',
        },
        {
          title: '원본 대조',
          text: '원본이 연결된 문서에서 원래 파일의 표나 배치를 확인해야 한다면 원본 보기로 이동해 내려받습니다.',
        },
      ],
      expected: '현재 Wiki 본문과 그 근거가 된 원본을 구별해 확인할 수 있습니다.',
      tip: 'Wiki 본문은 읽고 편집할 수 있는 문서이므로 원본의 서식과 다를 수 있습니다.',
      anchor: '../USER_GUIDE.md#문서-찾고-읽기',
    },
    {
      id: 'explore-ontology',
      course: 'use',
      title: '개념과 관계 살펴보기',
      image: 'assets/ontology.png',
      focus: ['개념 상세', '원문 열기', '화면에 맞춤'],
      lead: '문서에서 추출한 개념을 시작점으로 관계와 조건을 읽습니다.',
      actions: [
        {
          title: '시작점 찾기',
          text: '실제 앱의 온톨로지에서 개념이나 문서 이름을 검색하고 살펴볼 개념을 시작점으로 추가합니다.',
        },
        {
          title: '연결 넓히기',
          text: '개념을 선택하고 이 개념의 연결 불러오기 또는 연결 더 보기를 사용합니다.',
        },
        {
          title: '근거 읽기',
          text: '관계를 선택해 관계 상세의 조건을 읽고 근거·검토 이력 보기로 원문과 판단을 확인합니다.',
        },
      ],
      expected: '선택한 개념의 연결과 관계의 원문 근거가 표시됩니다.',
      tip: '지도는 연결을 나누어 불러오므로 처음 보이는 관계가 전부라고 판단하지 마세요.',
      anchor: '../USER_GUIDE.md#온톨로지에서-개념과-관계-탐색하기',
    },
    {
      id: 'ask-question',
      course: 'use',
      title: '문서에 질문하기',
      image: 'assets/chat.png',
      focus: ['질문 입력', '질문 보내기'],
      lead: '문서 이름과 알고 싶은 조건을 적어 AI에게 질문합니다.',
      actions: [
        {
          title: '대화 열기',
          text: '실제 앱에서 AI 채팅을 엽니다. 새 주제라면 대화 목록의 새 대화를 선택합니다.',
        },
        {
          title: '질문 보내기',
          text: '예를 들어 “예시 운영 안내에서 보완을 요청하는 조건을 원문 인용과 함께 알려 줘”라고 적고 질문 보내기를 누릅니다.',
        },
        {
          title: '후속 질문',
          text: '답변을 읽고 같은 주제를 더 확인하려면 같은 대화에서 이어서 질문합니다.',
        },
      ],
      expected: '질문과 AI 답변이 대화에 표시되고 답변의 근거를 열 수 있습니다.',
      tip: 'Enter는 질문 보내기, Shift+Enter는 줄바꿈입니다.',
      anchor: '../USER_GUIDE.md#대화-시작하고-이어가기',
    },
    {
      id: 'check-evidence',
      course: 'use',
      title: '답변의 근거 확인하기',
      image: 'assets/evidence.png',
      focus: ['근거', '인용과 원문'],
      lead: '답변의 조건과 수치를 실제 인용문과 대조합니다.',
      actions: [
        {
          title: '근거 열기',
          text: '실제 앱에서 확인할 답변의 근거 칩을 누릅니다.',
        },
        {
          title: '인용과 출처 대조',
          text: '사용한 문서와 인용 위치를 확인하고 답변의 결론을 뒷받침하는 내용인지 읽습니다.',
        },
        {
          title: '부족한 범위 확인',
          text: '저장된 인용이 없거나 일부만 읽었다는 안내가 있으면 질문 범위를 구체화해 다시 확인합니다.',
        },
      ],
      expected: '이번 답변이 실제로 사용한 출처와 인용을 확인할 수 있습니다.',
      tip: '인용이 있다는 사실만으로 답변의 모든 문장이 확인된 것은 아닙니다.',
      anchor: '../USER_GUIDE.md#답변의-근거-확인하기',
    },
    {
      id: 'download-answer',
      course: 'use',
      title: '확인한 답변을 파일로 받기',
      image: 'assets/chat.png',
      focus: ['내려받기'],
      lead: '내용을 확인한 답변을 필요한 형식으로 저장합니다.',
      actions: [
        {
          title: '내려받기 선택',
          text: '실제 앱에서 저장할 답변 아래의 내려받기를 누릅니다.',
        },
        {
          title: '형식과 위치 선택',
          text: '표시된 지원 형식 중 원하는 형식을 고르고 저장할 위치와 새 파일 이름을 정합니다.',
        },
        {
          title: '저장 파일 확인',
          text: '내려받은 파일을 열어 내용과 표·문단 배치를 확인합니다.',
        },
      ],
      expected: '선택한 위치에 답변 파일이 저장됩니다.',
      tip: '파일 내려받기와 개인 초안 저장은 공유 Wiki 본문을 바꾸지 않습니다.',
      anchor: '../USER_GUIDE.md#답변-바로-내려받기',
    },
    {
      id: 'edit-document',
      course: 'manage',
      title: '본문 고치고 저장하기',
      image: 'assets/edit.png',
      focus: ['본문', '변경 내용 확인', '계속 편집', '저장'],
      lead: '현재 문서를 고친 뒤 저장 전 차이를 확인합니다.',
      actions: [
        {
          title: '편집 시작',
          text: '실제 앱에서 고칠 문서를 열고 본문 편집을 눌러 내용을 수정합니다.',
        },
        {
          title: '변경 비교',
          text: '변경 내용 확인을 눌러 이전 내용과 수정한 내용을 비교합니다.',
        },
        {
          title: '저장하고 다시 읽기',
          text: '보완하려면 계속 편집을, 확정하려면 저장을 누르고 읽기 화면에서 결과를 확인합니다.',
        },
      ],
      expected: '수정한 본문이 새 판본으로 저장되고 이전 전체 문서는 이력에 남습니다.',
      tip: '다른 사람이 먼저 고쳤다는 안내가 나오면 최신 본문과 내 초안을 대조해 다시 작성하세요.',
      anchor: '../USER_GUIDE.md#본문과-문서-정보-수정하기',
    },
    {
      id: 'reextract-relations',
      course: 'manage',
      title: '바뀐 본문으로 관계 갱신하기',
      image: 'assets/document.png',
      focus: ['관계 재추출'],
      lead: '저장한 본문으로 새 후보를 만들고 비교한 뒤 반영합니다.',
      actions: [
        {
          title: '새 후보 만들기',
          text: '실제 앱에서 현재 본문을 저장한 뒤 관계 재추출을 누릅니다.',
        },
        {
          title: '결과 비교',
          text: '완료 후 결과 비교·반영을 열어 추가되거나 사라진 관계와 원문 근거를 살펴봅니다.',
        },
        {
          title: '판단 후 반영',
          text: '사라진 관계의 판단을 기록하고 검사를 진행합니다. 전체 확인 항목을 선택한 뒤 검사 후 반영을 누릅니다.',
        },
      ],
      expected: '반영을 마치면 관계가 새 버전으로 바뀌었다는 안내가 표시됩니다.',
      tip: '본문 저장, 재추출 후보 생성, 관계 반영은 각각 별개의 단계입니다.',
      anchor: '../USER_GUIDE.md#관계-재추출과-결과-반영하기',
    },
    {
      id: 'review-claim',
      course: 'manage',
      title: '원문에 맞는 관계인지 검토하기',
      image: 'assets/review.png',
      focus: ['판단 선택', '이유', '저장'],
      lead: 'AI가 추출한 주장을 원문과 대조하고 이유를 남깁니다.',
      actions: [
        {
          title: '검토할 주장 열기',
          text: '실제 앱의 검토함에서 필요한 상태를 고르고 문서 안의 검토 항목을 엽니다.',
        },
        {
          title: '원문과 조건 대조',
          text: '주체·관계·대상과 조건이 원문에 맞는지 읽고 승인, 수정, 보류, 반려 중 하나를 선택합니다.',
        },
        {
          title: '이유와 판단 저장',
          text: '선택한 판단의 이유를 적고 저장을 누릅니다.',
        },
      ],
      expected: '선택한 주장의 판단과 이유가 검토 기록에 남습니다.',
      tip: '반려는 해당 사실이 거짓이라고 새로 선언하는 동작이 아닙니다.',
      anchor: '../USER_GUIDE.md#검토함에서-판단하기',
    },
    {
      id: 'manage-sessions',
      course: 'manage',
      title: '실행 중 작업과 지난 결과 찾기',
      image: 'assets/sessions.png',
      focus: ['열기', '중단', '지난 기록'],
      lead: '현재 기기의 작업 상태를 확인하고 필요한 결과로 돌아갑니다.',
      actions: [
        {
          title: 'AI 세션 열기',
          text: '실제 앱에서 AI 세션을 열고 돌고 있는 작업 또는 최근 끝난 작업을 확인합니다.',
        },
        {
          title: '대상으로 이동하거나 중단',
          text: '확인할 행의 열기를 누릅니다. 실행을 멈춰야 할 때만 해당 행의 중단을 누릅니다.',
        },
        {
          title: '이전 결과 찾기',
          text: '오래된 작업은 지난 기록에서 종류 필터를 고르고 필요한 경우 더 불러오기를 사용합니다.',
        },
      ],
      expected: '해당 대화나 분석 작업을 열어 진행 상태와 저장 결과를 확인할 수 있습니다.',
      tip: '화면 이동과 창 닫기는 실행을 멈추지 않으므로 멈추려는 작업의 중단을 사용하세요.',
      anchor: '../USER_GUIDE.md#ai-작업과-지난-실행-기록-관리하기',
    },
  ],
};
