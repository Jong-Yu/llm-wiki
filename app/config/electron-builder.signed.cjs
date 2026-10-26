// 서명된 배포는 명시한 기존 identity와 키체인 공증 profile이 있을 때만 만듭니다.
const base = require('./electron-builder.json');
if (
  !process.env.CSC_NAME ||
  !process.env.APPLE_KEYCHAIN_PROFILE ||
  !process.env.APPLE_KEYCHAIN
) {
  throw new Error(
    'CSC_NAME, APPLE_KEYCHAIN and APPLE_KEYCHAIN_PROFILE are required for signed distribution.',
  );
}
module.exports = {
  ...base,
  directories: { output: 'release/signed' },
  forceCodeSigning: true,
  mac: {
    ...base.mac,
    identity: process.env.CSC_NAME,
    hardenedRuntime: true,
    notarize: true,
  },
};
