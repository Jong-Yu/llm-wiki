"""개인 실행 작업과 감시를 함께 기다리고 이번 호출이 만든 task를 끝까지 회수한다.

취소·사용권·원격 상태의 판단은 호출자가 전달하는 검사와 감시에 둔다.
저장 요청의 응답 확인처럼 취소해도 끝내야 하는 작업에는 사용하지 않는다.
"""

import asyncio


async def supervise(operation, *observers, check):
    """동시에 끝나도 현재 실패 신호→감시 실패→작업 결과 순서로 확인한다."""
    work, *watches = [asyncio.create_task(item) for item in (operation, *observers)]
    tasks = (work, *watches)
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        check()
        for watch in watches:
            if watch.done():
                await watch
        return await work
    finally:
        # 어댑터는 취소 처리 중 자신이 시작한 프로세스를 종료한다. 그 정리까지 기다린다.
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
