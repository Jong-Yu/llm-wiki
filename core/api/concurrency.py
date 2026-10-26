# async/await는 작업을 기다리는 동안 다른 요청도 처리할 수 있게 한다.
# 파일 저장은 요청 취소와 동시에 버리면 정리가 누락될 수 있어, 시작한 작업을 끝까지 기다린다.

"""API 요청 취소에서도 파일 작업의 소유권을 완료·정리까지 유지한다.

원본 등록·다운로드·분석 작업이 같은 대기 절차를 사용한다. 호출자가 먼저
종료되면 파일 닫기나 수신 임시 파일 정리가 끝나기 전에 자원이 반환될 수 있다.
"""

import asyncio
from anyio import to_thread


# awaitable은 나중에 완료될 비동기 작업이다. 별도 task가 그 작업을 소유하고 요청 취소 뒤에도 완료를 기다린다.
async def wait_owned(awaitable):
    """호출자 취소를 기록하되 작업을 버리지 않고 끝난 뒤 취소를 전파한다.

    AnyIO scope의 shield만으로는 asyncio.Task.cancel()을 막을 수 없다. Uvicorn의
    asyncio 실행에서 별도 소유 task를 shield하고 반복 취소에도 완료를 기다린다.
    """
    owned = asyncio.create_task(awaitable)
    cancellation = None
    while not owned.done():
        try:
            await asyncio.shield(owned)
        except asyncio.CancelledError as error:
            if owned.cancelled():
                raise
            cancellation = error
        except BaseException:
            break
    if cancellation is not None:
        # 취소 중 작업 오류도 회수하되 호출자가 요청한 취소를 유지한다.
        try:
            owned.result()
        except BaseException:
            pass
        raise cancellation
    return owned.result()


# 동기 파일 I/O를 작업 스레드에서 실행해 서버의 비동기 요청 처리를 막지 않는다.
async def run_owned_thread(operation):
    """동기 저장 작업이 끝나기까지 기다려 결과·정리의 소유권을 호출자에게 둔다."""
    return await wait_owned(to_thread.run_sync(operation))
