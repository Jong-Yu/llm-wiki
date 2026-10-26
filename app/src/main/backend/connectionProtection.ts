import { safeStorage } from 'electron';
import { join } from 'node:path';
import { ProtectedConnectionStore } from './ProtectedConnectionStore';
import type { ConnectionCipher } from './ProtectedConnectionStore';

/** 앱 준비 후 OS 보호 저장을 선택하고 안전하지 않은 Linux fallback을 거부합니다. */
export function createConnectionCipher(): ConnectionCipher {
  return {
    availability: async (): ReturnType<ConnectionCipher['availability']> => {
      if (!(await safeStorage.isAsyncEncryptionAvailable()))
        return { availability: 'session_only', backend: 'unavailable' };
      if (process.platform === 'darwin')
        return { availability: 'protected', backend: 'macos_keychain' };
      if (process.platform === 'win32')
        return { availability: 'protected', backend: 'windows_dpapi' };
      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend();
        if (
          ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
            backend,
          )
        )
          return { availability: 'protected', backend: 'linux_secret_store' };
        return { availability: 'session_only', backend: 'unsafe_fallback' };
      }
      return { availability: 'session_only', backend: 'unavailable' };
    },
    encrypt: (text: string): Promise<Buffer> =>
      safeStorage.encryptStringAsync(text),
    decrypt: async (bytes: Buffer): Promise<string> => {
      const value = await safeStorage.decryptStringAsync(bytes);
      // 키 교체로 재암호화 권고가 있어도 읽기 중 기존 파일을 조용히 덮어쓰지 않습니다.
      return value.result;
    },
  };
}

/** 연결 자격 증명과 복구 저장이 동일한 OS 보호 정책을 사용합니다. */
export function createConnectionProtection(
  userDataPath: string,
): ProtectedConnectionStore {
  return new ProtectedConnectionStore(
    join(userDataPath, 'connection-protection'),
    createConnectionCipher(),
  );
}
