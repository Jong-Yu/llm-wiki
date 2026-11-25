import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { conversionPartStoredSchema } from './sourceConversionProtocol';
import type { conversionStoredSchema } from './sourceConversionProtocol';

type StoredConversion = z.infer<typeof conversionStoredSchema>['data'];
type ConversionUnits = NonNullable<StoredConversion['manifest']['units']>;

/** Python canonical JSON과 같은 순서로 검증된 JSON manifest의 바이트를 만든다. */
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item: unknown): string => canonical(item)).join(',')}]`;
  if (typeof value !== 'object') throw new Error('invalid_manifest_value');
  return `{${Object.entries(value)
    .filter(([, item]: [string, unknown]): boolean => item !== undefined)
    .sort(([left]: [string, unknown], [right]: [string, unknown]): number =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    .map(
      ([key, item]: [string, unknown]): string =>
        `${JSON.stringify(key)}:${canonical(item)}`,
    )
    .join(',')}}`;
}

/** 부분 hash·순서·출처·내용 지문까지 확인하고 나서 전체 보고를 UI에 전달한다. */
export async function readConversionParts(
  data: StoredConversion,
  read: (partId: string) => Promise<unknown>,
): Promise<{ units: ConversionUnits; components: Record<string, string> }> {
  const manifest = data.manifest;
  if (!manifest.parts) {
    if (!manifest.units) throw new Error('conversion_units_missing');
    return { units: manifest.units, components: data.components };
  }
  if (
    !manifest.parts.length ||
    Object.keys(data.components).length ||
    createHash('sha256')
      .update(canonical(manifest) + '\n')
      .digest('hex') !== data.revision
  )
    throw new Error('conversion_manifest_mismatch');
  const units: ConversionUnits = [];
  const components: Record<string, string> = {};
  const locations = new Set<string>();
  let size = 0;
  for (let index = 0; index < manifest.parts.length; index++) {
    const reference = manifest.parts[index];
    if (!reference) throw new Error('conversion_part_missing');
    const { data: part } = conversionPartStoredSchema.parse(
      await read(reference.part_id),
    );
    const details = part.manifest;
    if (
      part.revision !== reference.part_revision ||
      createHash('sha256')
        .update(canonical(details) + '\n')
        .digest('hex') !== reference.part_revision ||
      details.id !== reference.part_id ||
      details.conversion_request_id !== manifest.request_id ||
      details.part_index !== index ||
      details.user_id !== manifest.user_id ||
      details.tenant !== manifest.tenant ||
      canonical(details.source_ref) !== canonical(manifest.source_ref) ||
      canonical(part.access) !== canonical(data.access) ||
      ['method', 'complete', 'unread_ranges', 'warnings'].some(
        (field: string): boolean =>
          canonical(details[field]) !== canonical(manifest[field]),
      )
    )
      throw new Error('conversion_part_mismatch');
    for (const unit of details.units) {
      const content = part.components[unit.unit_id];
      const descriptor = details.components[unit.unit_id];
      const location = canonical(unit.location);
      if (
        content === undefined ||
        !descriptor ||
        unit.unit_id in components ||
        locations.has(location) ||
        Buffer.byteLength(content) !== descriptor.size_bytes ||
        createHash('sha256').update(content).digest('hex') !== descriptor.sha256
      )
        throw new Error('conversion_part_content_mismatch');
      size += descriptor.size_bytes;
      if (size > 20 * 1024 * 1024 || units.length >= 10000)
        throw new Error('conversion_total_limit');
      units.push(unit);
      components[unit.unit_id] = content;
      locations.add(location);
    }
    if (Object.keys(part.components).length !== details.units.length)
      throw new Error('conversion_part_content_mismatch');
  }
  if (units.length !== manifest.unit_count || size !== manifest.text_bytes)
    throw new Error('conversion_total_mismatch');
  return { units, components };
}
