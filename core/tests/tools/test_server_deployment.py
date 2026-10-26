"""배포 생성/읽기 진단 시험. Linux/WSL2/systemd 실행 인증은 아니다."""
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import server_deployment as deploy
from core.runtime.server_filesystem import mount_type, check_linux_paths


def configuration():
    return {"schema_version":1, "service_name":"wiki-test", "service_user":"wiki",
        "proxy_user":"caddy", "project_dir":"/srv/wiki code", "tenant_root":"/srv/wiki-data",
        "access_config":"/srv/wiki-private/access.json", "https_host":"wiki.example.test",
        "listen_address":"192.0.2.10", "tls_cert":"/etc/wiki/fullchain.pem", "tls_key":"/etc/wiki/private.pem",
        "wsl_distribution":"Ubuntu-24.04", "wsl_user":"wiki"}


class DeploymentTests(unittest.TestCase):
    def test_new_bundle_hashes_no_overwrite_and_no_auto_apply(self):
        with tempfile.TemporaryDirectory(prefix="wiki-deployment-") as temporary:
            output=Path(temporary)/"bundle"
            result=deploy.prepare(configuration(), output)
            self.assertFalse(result['applied'])
            manifest=json.loads((output/'manifest.json').read_text())
            for name,digest in manifest['files'].items():
                self.assertEqual(sha256((output/name).read_bytes()).hexdigest(),digest)
            original=(output/'Caddyfile').read_bytes()
            with self.assertRaises(FileExistsError): deploy.prepare(configuration(),output)
            self.assertEqual((output/'Caddyfile').read_bytes(),original)
            self.assertFalse(manifest['secrets_included'])

    def test_tls_loopback_host_and_service_sandbox_contract(self):
        files=deploy.render(configuration())
        caddy=files['Caddyfile'];service=files['wiki-test.service']
        self.assertIn('auto_https off',caddy)
        self.assertIn('header_up Host 127.0.0.1:8766',caddy)
        self.assertNotIn('header_up -Origin',caddy)
        self.assertIn('bind 192.0.2.10',caddy)
        self.assertIn('"/srv/wiki code/.venv/bin/python"',service)
        self.assertIn('KillMode=control-group',service)
        self.assertIn('ReadWritePaths="/srv/wiki-data"',service)
        self.assertIn('--exec /bin/sleep infinity',files['startup-wsl.ps1'])

    def test_invalid_injected_or_windows_configuration_rejected(self):
        for change in [{'service_user':'root'}, {'service_name':'bad\nExecStart=evil'},
            {'project_dir':'/srv/x%u'}, {'project_dir':'/mnt/c/wiki'}, {'project_dir':'/a/../b'},
            {'listen_address':'0.0.0.0'}, {'https_host':'x { abort }'},
            {'ruleset_root':'/srv/rules'}, {'access_config':'/srv/wiki-data/access.json'},
            {'port':True}, {'wsl_user':'x; touch /a'}, {'extra':'unexpected'}]:
            with self.subTest(change=change), self.assertRaises((ValueError,TypeError)):
                deploy.validate({**configuration(),**change})

    def test_duplicate_keys_and_read_only_inspect(self):
        with tempfile.TemporaryDirectory(prefix="wiki-deploy-check-") as temporary:
            path=Path(temporary)/'config.json'
            path.write_text('{"schema_version":1,"schema_version":2}')
            with self.assertRaises(ValueError): deploy.load(path)
        with patch.object(deploy.subprocess,'run',side_effect=OSError('unavailable')):
            value=deploy.inspect(configuration())
        self.assertFalse(value['ok']);self.assertFalse(value['changed'])
        self.assertIn('remote_api_mcp_connection',value['not_verified'])

    def test_mount_uses_actual_most_specific_filesystem_not_path_prefix(self):
        with tempfile.TemporaryDirectory(prefix="wiki-mount-") as temporary:
            path=Path(temporary).resolve()
            mounts=f'1 0 0:1 / / rw - ext4 root rw\n2 1 0:2 / {path} rw - 9p windows rw\n'
            self.assertEqual(mount_type(path,mounts),'9p')
            with patch('core.runtime.server_filesystem.sys.platform','linux'), patch('core.runtime.server_filesystem.Path.read_text',return_value=mounts):
                with self.assertRaisesRegex(ValueError,'persistent_linux_filesystem_required'):check_linux_paths([path])
            self.assertEqual(mount_type(path,'1 0 0:1 / / rw - ext4 root rw'),'ext4')


if __name__=='__main__':unittest.main()
