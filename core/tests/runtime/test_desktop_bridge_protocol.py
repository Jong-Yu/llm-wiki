"""실제 macOS/POSIX 브리지→질문 CLI→격리 HTTP 서버. 모델 출력은 합성이다."""
import asyncio
from hashlib import sha256
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from core.runtime.desktop_bridge import prepare
from core.tests.runtime import test_question_cli as fixture
from tools.runtime_doctor import connection


@unittest.skipUnless(os.name == 'posix', 'POSIX real transport; not Windows certification')
class DesktopBridgeProtocolTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.QuestionCliTests.save_policy
    seed = fixture.QuestionCliTests.seed
    value = fixture.QuestionCliTests.value
    context = fixture.QuestionCliTests.context
    question = fixture.QuestionCliTests.question
    server = fixture.QuestionCliTests.server
    fake_cli = fixture.QuestionCliTests.fake_cli

    def setUp(self):
        fixture.QuestionCliTests.setUp(self)
        prepared = prepare(self.root.resolve()/'private-bridge', 'exec-12345678', self.tokens['alice'].encode())
        self.token_path = Path(prepared['token_file'])

    async def invoke(self, url, question, *, cancel=None):
        real_create = asyncio.create_subprocess_exec
        async def bridged(*args, **kwargs):
            if args[1:4] == ('-B', '-m', 'tools.question_cli'):
                args = (sys.executable, '-B', '-m', 'core.runtime.desktop_bridge', 'launch',
                        '--parent-pid', str(os.getpid()), '--', *args[1:])
            return await real_create(*args, **kwargs)
        with patch.object(asyncio, 'create_subprocess_exec', side_effect=bridged):
            return await fixture.QuestionCliTests.invoke(self,url,question,cancel=cancel)

    async def test_bridge_actual_success_and_cancel_receipts(self):
        async with self.server() as (http,url):
            for cancel in (None, 'stdin', 'signal'):
                question = await self.question(http)
                result, events = await self.invoke(url,question,cancel=cancel)
                self.assertEqual(result['saved'], cancel is None)
                self.assertEqual(result['status'], 'cancelled' if cancel else 'stored')
                if cancel: self.assertEqual(result['cancellation'],'confirmed')
                self.assertTrue(any(event['type']=='answer_preview' for event in events))

    async def test_doctor_actual_api_mcp_and_no_file_changes(self):
        async with self.server() as (_, url):
            def snapshot():
                return {str(p):sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}
            before=snapshot()
            result=await connection(url,self.token_path,'alpha','business')
            self.assertEqual(result['api']['status'],'ok')
            self.assertEqual(result['mcp']['status'],'ok')
            self.assertTrue(result['mcp']['initialized'])
            self.assertEqual(result['comparison']['status'],'ok')
            self.assertEqual(result['comparison']['backend_identity'],'not_available')
            self.assertEqual(before,snapshot())


if __name__=='__main__':unittest.main()
