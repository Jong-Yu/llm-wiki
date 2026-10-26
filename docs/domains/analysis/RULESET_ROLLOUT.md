# 규약 발행·허용·전환·되돌림

현재 서버와 개인 실행기의 D-056 진단 v2를 적용하는 관리자 절차입니다. 의미 원문·그래프 스키마를 바꾸지 않습니다. 운영 호스트, OS 관리자 권한, 기존 tenant root, 접근 정책과 규약 root/policy 경로를 먼저 확정합니다. MCP의 `read` 권한은 규약 배포 권한이 아닙니다. 경로는 심볼릭 링크 없는 절대 실제 경로를 쓰며 규약·정책·정책 이력은 tenant 자료 밖에 둡니다. 서버 관리 도구는 POSIX 실행 대상입니다.

## 1. 불변 릴리스와 실행 호환 확인

서버와 개인 PC에 이번 코드가 설치됐는지 확인합니다. 서버는 배포 시 실행 프로세스를 갱신하고 아래 옵션의 기존 값을 유지합니다. 검증기 파일이 바뀐 상태에서 이전 프로세스를 계속 쓰지 않습니다. 실제 검증기 지문·제출 스키마가 다른 릴리스는 자동 허용하거나 이름만 바꿔 재사용하지 않습니다.

```sh
.venv/bin/python -B -m tools.publish_ruleset \
  --root "$RULESET_ROOT" --tenant-root "$TENANT_ROOT" \
  --ruleset-id "$RULESET_ID" --version "$NEW_VERSION" \
  --reason '진단 v2와 별도 의미 검사 도입'

.venv/bin/python -B -m tools.transition_ruleset \
  --root "$RULESET_ROOT" --policy "$RULESET_POLICY" --tenant-root "$TENANT_ROOT" \
  inspect --tenant "$TENANT" --ruleset-id "$RULESET_ID" --version "$NEW_VERSION"
```

변수는 확인된 관리 대상에 설정합니다. 발행은 기존 ID/버전을 덮어쓰지 않으며 허용 정책을 변경하지 않습니다. inspect의 `release.diagnostics_versions=[1,2]`, `separate_semantic_check=true`, `schema_sha256`, `validator_revision`과 불변 `ruleset_revision`을 기록합니다. 이것은 로컬 코드·릴리스 호환 확인이며 원격 서버/개인 모델 실행 인증은 아닙니다. 구 v1 릴리스는 `[1]`로 표시하며 그 바이트를 수정하지 않습니다.

## 2. 허용 계획 검토와 적용

```sh
.venv/bin/python -B -m tools.transition_ruleset \
  --root "$RULESET_ROOT" --policy "$RULESET_POLICY" --tenant-root "$TENANT_ROOT" \
  plan --tenant "$TENANT" --ruleset-id "$RULESET_ID" --version "$NEW_VERSION" \
  --expected-policy-revision "$POLICY_SHA256" --reason '새 규약의 명시 허용' \
  --output "$ALLOW_PLAN"

.venv/bin/python -B -m tools.transition_ruleset \
  --root "$RULESET_ROOT" --policy "$RULESET_POLICY" --tenant-root "$TENANT_ROOT" \
  apply --plan "$ALLOW_PLAN"
```

`POLICY_SHA256`는 방금 inspect한 값입니다. **새 정책 파일을 처음 만드는 경우에만** `absent`를 씁니다. plan은 새 파일에 전후 전체 정책·규약 hash를 보존하며 아직 적용하지 않습니다. 기존 tenant에서는 `--make-default`를 생략하면 허용만 추가합니다. 실제 연결 확인 뒤 같은 plan 명령에 `--make-default`를 추가해 기본값 전환 계획을 따로 만듭니다. 신규 tenant의 첫 허용은 그 규약이 기본값입니다. 철회된 규약의 묵시적 재허용은 거부합니다.

apply는 같은 정책 잠금 아래 현재 전체 바이트의 SHA256과 계획을 대조하고, `$RULESET_POLICY.history/<event_id>/`에 전후 전체 정책과 hash manifest를 새로 보존한 다음 원자 교체합니다. 이력 실패 시 정책을 변경하지 않습니다. 같은 잠금 규칙을 따르는 관리자 도구만 정책을 수정해야 합니다. 외부 편집기의 비협조 쓰기와의 완전한 직렬화는 보장하지 않습니다.

`ruleset_conflict`면 현재 정책과 계획을 대조한 뒤 새 계획을 만듭니다. 오래된 계획의 revision만 바꾸지 않습니다. `ruleset_busy`는 같은 계획으로 나중에 재시도할 수 있습니다. `applied=true`에 `durability_warning`이 있으면 교체는 완료됐고 디렉터리 동기화 확인이 실패한 것이므로 자동 재적용하지 않습니다. 예외의 정리 오류는 원래 실패와 별도입니다.

## 3. 실제 서버·기존 작업 확인

기존 인증 API/MCP 서버에 `--ruleset-root`와 `--ruleset-policy`를 명시합니다. `access_context`로 자기 소속과 권한을 확인한 뒤 `extraction_rules_read(tenant, ruleset_id, ruleset_version)`의 revision을 발행 값과 비교합니다. 새 MCP 초기화도 확인합니다. 관리 대상에 없는 인증·경로·권한으로 실패를 우회하지 않습니다.

격리 원본으로 새 작업→claim→고정 입력→진단 제출→`analysis_job_result_query`와 HTTP `/api/v1/tenants/{tenant}/analysis-jobs/{job_id}/results/{request_id}` 조회를 확인합니다. v2 별도 보고는 기존 `analysis_job_ontology_generate(save=false, diagnostics=...)`에 새 request ID로 제출합니다. `submission_ref.payload_hash`는 전체 요청 hash, `validation_report.basis.submission_sha256`와 `diagnostics.basis.submission_hash`는 원시 그래프 hash, `diagnostics.report_hash`는 보고서 hash입니다. job/run/bundle/revision/document/source/ruleset 참조도 대조합니다. 초안·검사 의견을 실제 canonical 저장이나 사람 승인으로 처리하지 않습니다.

기본값 변경 후에도 기존 작업은 고정한 구 규약을 상속합니다. 바꾸려면 최신 작업 조회와 원문·규약 대조 후 `analysis_job_input_prepare(stage="read_source", ruleset_id=..., ruleset_version=..., rebase=true, rebase_reason=..., expected_job_revision=...)`를 명시합니다. 기존 bundle/결과는 보존되고 새 기준으로 준비합니다. 새 릴리스를 허용했다고 옛 규약을 철회하지 않습니다. 옛 규약이 철회되면 그 입력의 계속 실행은 거부하지만 본인의 기존 결과 영수증은 read로 조회할 수 있습니다.

## 4. 되돌림과 응답 유실

```sh
.venv/bin/python -B -m tools.transition_ruleset \
  --root "$RULESET_ROOT" --policy "$RULESET_POLICY" --tenant-root "$TENANT_ROOT" \
  status --event-id "$EVENT_ID"

.venv/bin/python -B -m tools.transition_ruleset \
  --root "$RULESET_ROOT" --policy "$RULESET_POLICY" --tenant-root "$TENANT_ROOT" \
  rollback --event-id "$EVENT_ID" --expected-policy-revision "$CURRENT_POLICY_SHA256" \
  --reason '규약 전환 되돌림' --output "$ROLLBACK_PLAN"

.venv/bin/python -B -m tools.transition_ruleset \
  --root "$RULESET_ROOT" --policy "$RULESET_POLICY" --tenant-root "$TENANT_ROOT" \
  apply --plan "$ROLLBACK_PLAN"
```

status는 현재 바이트가 해당 전환의 전/후 정책과 같은지만 보고합니다. 응답 유실 때 자동 재실행하지 말고 inspect·status·이력을 대조합니다. rollback은 해당 event의 적용 후 전체 정책이 현재와 정확히 같을 때만 계획을 만듭니다. 중간 변경이 있으면 거부합니다. 기존 정책은 원래 전체 바이트로 복원하고 되돌림도 새 이벤트로 보존합니다. 최초 설치를 되돌릴 때는 파일 삭제 대신 빈 유효 정책으로 남깁니다. 발행 규약·작업·원문·위키·이력·결과 영수증을 삭제하지 않습니다.

실제 운영 적용에 필요한 입력은 관리 호스트/접속 방법, 관리자 실행 권한, 기존 프로젝트·tenant·규약 root/policy 경로, 대상 tenant와 새 릴리스 ID/버전, 기본값 전환 여부, 서버 업데이트/재시작 방법입니다. 그 값이 없으면 위 절차와 격리 산출물까지만 준비합니다. 격리 서버 통과와 실제 모델 의미 정확도·운영 완료는 별도로 기록합니다.
