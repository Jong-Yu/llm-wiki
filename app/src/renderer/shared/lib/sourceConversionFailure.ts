export type SourceConversionFailureExplanation = {
  body: string;
  next: string;
};

/** 기록에 있는 안전한 진단 코드만 해석하며 없는 중단 원인을 추정하지 않습니다. */
export function conversionFailureExplanation(
  codes: readonly string[],
): SourceConversionFailureExplanation | null {
  const has = (...values: string[]): boolean =>
    values.some((value: string): boolean => codes.includes(value));
  if (has('report_save_unconfirmed', 'conversion_receipt_mismatch'))
    return {
      body: '변환 결과가 서버에 저장되었는지 확인하지 못했습니다. 저장 실패로 확정할 수 없습니다.',
      next: '같은 요청의 결과를 먼저 조회해 주세요. 확인 전에는 새 변환을 시작하지 않습니다.',
    };
  if (has('conversion_memory_failed', 'conversion_resources_failed'))
    return {
      body: '문자 변환에 필요한 메모리 또는 실행 자원이 부족해 처리가 중단됐습니다.',
      next: '이 기기의 여유 메모리와 실행 중인 프로그램을 확인한 뒤 변환을 다시 시작해 주세요.',
    };
  if (has('conversion_checkpoint_locked'))
    return {
      body: '변환 중간 기록의 저장이 접근 거부 또는 파일 잠금으로 차단됐습니다.',
      next: '작업 폴더의 접근 권한과 다른 프로그램의 파일 사용 여부를 확인해 주세요.',
    };
  if (has('conversion_checkpoint_write_failed', 'conversion_worker_io_failed'))
    return {
      body: '이 기기에서 변환 중간 기록이나 작업 파일을 읽고 쓰지 못했습니다.',
      next: '작업 폴더의 접근 권한과 디스크 여유 공간을 확인해 주세요.',
    };
  if (
    has('converter_unavailable') ||
    codes.some((code: string): boolean =>
      code.startsWith('dependency_missing_'),
    )
  )
    return {
      body: '문자 변환 프로그램 또는 필요한 실행 구성 요소를 사용할 수 없습니다.',
      next: '설정에서 이 기기의 실행 준비 상태를 확인해 주세요.',
    };
  if (has('conversion_start_failed'))
    return {
      body: '이 기기에서 문자 변환 프로그램을 시작하지 못했습니다.',
      next: '설정의 실행 준비 상태와 작업 폴더의 접근 권한을 확인해 주세요.',
    };
  if (has('conversion_timeout', 'conversion_idle_timeout'))
    return {
      body: has('conversion_idle_timeout')
        ? '문자 변환에서 일정 시간 동안 새 진행이 확인되지 않아 중단됐습니다.'
        : '문자 변환 시간이 실행 한도를 넘어 중단됐습니다.',
      next: '기록된 처리 범위와 원본 상태를 확인해 주세요. 다시 변환하면 원본의 처음부터 읽습니다.',
    };
  if (has('source_download_failed'))
    return {
      body: '문자 변환에 필요한 원본을 서버에서 가져오지 못했습니다.',
      next: '서버 연결과 원본 접근 권한을 확인해 주세요.',
    };
  if (has('source_hash_mismatch', 'source_basis_changed'))
    return {
      body: '변환에 사용할 원본이 등록된 판본과 일치하지 않습니다.',
      next: '현재 원본 판본을 확인하고 변환할 대상을 다시 선택해 주세요.',
    };
  if (
    has(
      'conversion_output_limit',
      'conversion_unit_limit',
      'converter_output_limit',
    )
  )
    return {
      body: '변환된 내용이 한 번에 처리할 수 있는 범위를 넘었습니다.',
      next: '보관된 변환 내용과 읽지 못한 범위를 확인해 주세요. 같은 원본을 반복 변환해도 이 한도가 달라지지는 않습니다.',
    };
  if (has('encrypted_pdf_not_read'))
    return {
      body: '암호로 보호된 PDF의 내용을 읽지 못했습니다.',
      next: '열 수 있는 원본을 준비한 뒤 파일 교체를 선택해 주세요.',
    };
  if (
    has(
      'conversion_worker_crashed',
      'conversion_worker_terminated',
      'conversion_worker_exception',
      'invalid_converter_output',
    )
  )
    return {
      body: has('conversion_worker_terminated')
        ? '문자 변환 프로세스가 종료 신호를 받아 중단됐습니다. 종료를 요청한 주체는 이 기록에서 확인되지 않습니다.'
        : '문자 변환 프로그램이 비정상 종료되었거나 올바른 결과를 반환하지 못했습니다.',
      next: '이 기기의 실행 준비 상태와 실패 기록을 확인해 주세요. 다시 변환하면 원본의 처음부터 읽습니다.',
    };
  if (has('worker_failed'))
    return {
      body: '변환 프로그램이 중단되어 나머지 원본을 읽지 못했습니다. 이 기록에는 구체적인 중단 원인이 남아 있지 않습니다.',
      next: '이 기기의 실행 준비 상태와 실패 기록을 먼저 확인해 주세요. 다시 변환하면 원본의 처음부터 읽습니다.',
    };
  return null;
}
