import { extname } from 'node:path';
import type { SourceFormat } from '@contracts/documents.contract';

/** 서버가 허용한 원본 확장자만 사용하며 파일 내용을 실행하지 않습니다. */
export function sourceFileFormat(filename: string): SourceFormat | null {
  const extension = extname(filename).toLowerCase();
  if (extension === '.md') return 'md';
  if (extension === '.txt') return 'txt';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.xlsx') return 'xlsx';
  if (extension === '.docx') return 'docx';
  if (extension === '.png') return 'png';
  if (extension === '.jpg') return 'jpg';
  if (extension === '.jpeg') return 'jpeg';
  if (extension === '.gif') return 'gif';
  if (extension === '.webp') return 'webp';
  if (extension === '.bmp') return 'bmp';
  if (extension === '.tif') return 'tif';
  if (extension === '.tiff') return 'tiff';
  return null;
}
/** UTF-8 검사와 문자열 미리보기는 텍스트 원본에만 적용합니다. */
export function isTextSource(format: SourceFormat): format is 'md' | 'txt' {
  return format === 'md' || format === 'txt';
}
/** 서버 다운로드와 업로드에서 동일한 원본 MIME을 사용합니다. */
export function sourceMediaType(format: SourceFormat): string {
  switch (format) {
    case 'md':
      return 'text/markdown';
    case 'txt':
      return 'text/plain';
    case 'pdf':
      return 'application/pdf';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    case 'png':
    case 'gif':
    case 'webp':
    case 'bmp':
      return `image/${format}`;
  }
}
/** 텍스트에만 명시 UTF-8 charset이 있는 서버 파일 응답을 대조합니다. */
export function sourceContentType(format: SourceFormat): string {
  const media = sourceMediaType(format);
  return isTextSource(format) ? `${media}; charset=utf-8` : media;
}
/** 서버와 같은 최소 파일 서명을 확인하며 PDF·압축·문서 코드는 해석하거나 실행하지 않습니다. */
export function sourceSignatureMatches(
  format: SourceFormat,
  bytes: Uint8Array,
): boolean {
  if (format === 'pdf')
    return (
      bytes.length >= 5 &&
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46 &&
      bytes[4] === 0x2d
    );
  if (format === 'xlsx' || format === 'docx')
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04
    );
  // OOXML 패키지 내부 검증은 서버가 수행합니다. 이미지는 최소 서명만 확인합니다.
  const begins = (prefix: number[]): boolean =>
    bytes.length >= prefix.length &&
    prefix.every(
      (byte: number, index: number): boolean => bytes[index] === byte,
    );
  if (format === 'png') return begins([137, 80, 78, 71, 13, 10, 26, 10]);
  if (format === 'jpg' || format === 'jpeg') return begins([255, 216, 255]);
  if (format === 'gif')
    return begins([71, 73, 70, 56, 55, 97]) || begins([71, 73, 70, 56, 57, 97]);
  if (format === 'bmp') return begins([66, 77]);
  if (format === 'tif' || format === 'tiff')
    return begins([73, 73, 42, 0]) || begins([77, 77, 0, 42]);
  if (format === 'webp')
    return (
      begins([82, 73, 70, 70]) &&
      bytes.length >= 12 &&
      bytes[8] === 87 &&
      bytes[9] === 69 &&
      bytes[10] === 66 &&
      bytes[11] === 80
    );
  return isTextSource(format);
}
/** BOM·CRLF도 원문 바이트의 일부이므로 자동 제거하거나 줄바꿈을 바꾸지 않습니다. */
export function sourceText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}
