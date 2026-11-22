/**
 * 회사 프록시·보안 인증서·Git Bash 위치는 터미널의 Claude와 같은 연결 조건이라 개인 실행기에 넘깁니다(D-143).
 * 개인 실행기의 위키 서버 연결은 이 값을 쓰지 않으며(trust_env=False) AI CLI 실행에만 전달됩니다.
 * 인증 키(ANTHROPIC_API_KEY 등)는 넣지 않습니다.
 */
export const AI_NETWORK_ENVIRONMENT: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CODE_GIT_BASH_PATH',
];
