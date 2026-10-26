import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { RecoveryService } from '../../src/main/backend/RecoveryService';
import { ProtectedRecoveryStore } from '../../src/main/backend/ProtectedRecoveryStore';
import type { ConnectionCipher } from '../../src/main/backend/ProtectedConnectionStore';
import type { ConnectionService } from '../../src/main/backend/ConnectionService';

/** 디스크 복구는 실제 모듈로 시험하고 OS cipher만 격리 키로 주입합니다. native 보호 검증이 아닙니다. */
export function processRecoveryFixture(
  connection: Pick<ConnectionService, 'analysisContext' | 'isAnalysisCurrent'>,
  directory: string,
): RecoveryService {
  const key = randomBytes(32);
  const cipher: ConnectionCipher = {
    availability: async (): ReturnType<ConnectionCipher['availability']> => ({
      availability: 'protected',
      backend: 'macos_keychain',
    }),
    encrypt: async (text: string): Promise<Buffer> => {
      const nonce = randomBytes(12);
      const encoder = createCipheriv('aes-256-gcm', key, nonce);
      const data = Buffer.concat([
        encoder.update(text, 'utf8'),
        encoder.final(),
      ]);
      return Buffer.concat([nonce, encoder.getAuthTag(), data]);
    },
    decrypt: async (value: Buffer): Promise<string> => {
      const decoder = createDecipheriv(
        'aes-256-gcm',
        key,
        value.subarray(0, 12),
      );
      decoder.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([
        decoder.update(value.subarray(28)),
        decoder.final(),
      ]).toString('utf8');
    },
  };
  return new RecoveryService(
    connection,
    new ProtectedRecoveryStore(directory, cipher),
  );
}
