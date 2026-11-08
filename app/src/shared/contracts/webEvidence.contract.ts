import { z } from 'zod';

/** 공개 웹 근거에만 쓰는 주소입니다. 앱·파일·계정 URL과 로컬 주소를 허용하지 않습니다. */
export function isPublicWebUrl(value: string): boolean {
  try {
    if (
      value.length > 2048 ||
      /[\s\\]/u.test(value) ||
      Array.from(value).some(
        (char: string): boolean =>
          char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      return false;
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !['80', '443'].includes(url.port)) ||
      !host.includes('.') ||
      host.includes(':') ||
      /^\d+\.\d+\.\d+\.\d+$/u.test(host) ||
      host
        .split('.')
        .some(
          (label: string): boolean =>
            !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
        ) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|lan|home)$/u.test(
        host,
      )
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

const webEvidenceBaseSchema = z.strictObject({
  query: z.string().trim().min(1).max(200),
  status: z.enum(['complete', 'partial', 'empty', 'unavailable']),
  sources: z
    .array(
      z.strictObject({
        url: z.string().min(1).max(2048).refine(isPublicWebUrl),
        // Python의 문자 한도와 맞춰 이모지의 UTF-16 두 글자를 한 문자로 셉니다.
        title: z
          .string()
          .min(1)
          .max(600)
          .refine((value: string): boolean => Array.from(value).length <= 300),
        content: z
          .string()
          .min(1)
          .max(24000)
          .refine(
            (value: string): boolean => Array.from(value).length <= 12000,
          ),
        content_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        retrieved_at: z.iso.datetime({ offset: true }),
      }),
    )
    .max(5),
  warnings: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(10),
});
export const webEvidenceInputSchema = webEvidenceBaseSchema.refine(
  (value: z.infer<typeof webEvidenceBaseSchema>): boolean =>
    (['complete', 'partial'].includes(value.status)
      ? value.sources.length > 0
      : value.sources.length === 0) &&
    (value.status !== 'complete' || value.warnings.length === 0),
);
