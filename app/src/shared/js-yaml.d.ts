/** 설치된 YAML 파서에서 사용하는 안전한 읽기 API만 선언합니다. 외부 값은 검증 전까지 unknown입니다. */
declare module 'js-yaml' {
  export const JSON_SCHEMA: object;
  export function load(input: string, options?: { schema?: object }): unknown;
}
