/** 같은 작업의 시작만 잠그고 전체 종료는 모든 시작이 정리될 때까지 기다립니다. */
export class ExecutionStarts {
  #pending = new Map<string, Promise<void>>();

  /** await 이전에 키를 등록해 연속 클릭의 중복 실행을 막습니다. */
  begin(key: string): (() => void) | null {
    if (this.#pending.has(key)) return null;
    let finish: (() => void) | undefined;
    this.#pending.set(
      key,
      new Promise<void>((resolve: () => void): void => {
        finish = resolve;
      }),
    );
    return (): void => {
      this.#pending.delete(key);
      finish?.();
    };
  }

  /** 현재 접수 중인 실행 수이며 계정 사용량과는 별개입니다. */
  get size(): number {
    return this.#pending.size;
  }

  /** 종료 요청 이전에 접수한 모든 시작의 정리를 기다립니다. */
  async settled(): Promise<void> {
    await Promise.all(this.#pending.values());
  }
}
