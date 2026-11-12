import type { ProviderKind, SubmarineSyncItem, SyncRequest, SettingsPatch } from '../models/index.js';
import { isValidUnixSeconds, isIanaTimeZone } from './time.js';

export interface FieldError {
  field: string;
  message: string;
}

export class ValidationError extends Error {
  constructor(readonly errors: FieldError[]) {
    super('VALIDATION_ERROR');
  }
}

const PROVIDERS: readonly ProviderKind[] = ['bark', 'ntfy', 'none'];
const ADVANCE_VALUES = [0, 1, 5, 10, 15, 30];
const SLOT_INDEXES = [0, 1, 2, 3];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, field: string, maxLen: number, errors: FieldError[], options?: { allowEmpty?: boolean }): string {
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be a string' });
    return '';
  }
  const trimmed = value.trim();
  if (!options?.allowEmpty && trimmed.length === 0) errors.push({ field, message: 'must not be empty' });
  if (trimmed.length > maxLen) errors.push({ field, message: `must be <= ${maxLen} chars` });
  return trimmed;
}

export function asInt(value: unknown, field: string, min: number, max: number, errors: FieldError[]): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push({ field, message: 'must be an integer' });
    return min;
  }
  if (value < min || value > max) errors.push({ field, message: `must be between ${min} and ${max}` });
  return value;
}

export function asBool(value: unknown, field: string, errors: FieldError[]): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  errors.push({ field, message: 'must be a boolean' });
  return false;
}

export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError([{ field: 'body', message: 'invalid JSON' }]);
  }
}

export interface ParsedSync {
  request: SyncRequest;
  warnings: FieldError[];
}

export function parseSyncRequest(input: unknown): ParsedSync {
  const errors: FieldError[] = [];
  const warnings: FieldError[] = [];
  if (!isRecord(input)) throw new ValidationError([{ field: 'body', message: 'must be an object' }]);

  const characterId = asString(input.characterId, 'characterId', 32, errors, { allowEmpty: false });
  if (characterId && !/^\d{1,20}$/.test(characterId)) {
    errors.push({ field: 'characterId', message: 'must be numeric content id' });
  }
  const characterName = asString(input.characterName ?? '', 'characterName', 64, errors, { allowEmpty: true });

  let worldId: number | null = null;
  if (input.worldId !== undefined && input.worldId !== null) {
    worldId = asInt(input.worldId, 'worldId', 1, 100000, errors);
  }

  const collectedAt =
    input.collectedAt === undefined ? 0 : asInt(input.collectedAt, 'collectedAt', 0, 4102444800, errors);
  const clientTimeOffsetMs =
    input.clientTimeOffsetMs === undefined
      ? 0
      : asInt(input.clientTimeOffsetMs, 'clientTimeOffsetMs', -86400000, 86400000, errors);

  const rawList = input.submarines;
  if (!Array.isArray(rawList)) {
    errors.push({ field: 'submarines', message: 'must be an array' });
    throw new ValidationError(errors);
  }
  if (rawList.length > 4) errors.push({ field: 'submarines', message: 'at most 4 entries' });

  const seenSlots = new Set<number>();
  const submarines: SubmarineSyncItem[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const raw = rawList[i];
    const prefix = `submarines[${i}]`;
    if (!isRecord(raw)) {
      errors.push({ field: prefix, message: 'must be an object' });
      continue;
    }
    const slotIndex = asInt(raw.slotIndex, `${prefix}.slotIndex`, 0, 3, errors);
    if (seenSlots.has(slotIndex)) errors.push({ field: `${prefix}.slotIndex`, message: 'duplicate slotIndex' });
    seenSlots.add(slotIndex);
    if (!SLOT_INDEXES.includes(slotIndex)) continue;

    const name = asString(raw.name ?? '', `${prefix}.name`, 40, errors, { allowEmpty: true });
    const rank = raw.rank === undefined ? 0 : asInt(raw.rank, `${prefix}.rank`, 0, 999, errors);
    const returnAt = raw.returnAt === undefined ? 0 : asInt(raw.returnAt, `${prefix}.returnAt`, 0, 4102444800, errors);
    if (!isValidUnixSeconds(returnAt)) {
      errors.push({ field: `${prefix}.returnAt`, message: 'invalid unix seconds' });
    }

    let routePoints: number[] = [];
    if (raw.routePoints !== undefined) {
      if (!Array.isArray(raw.routePoints) || raw.routePoints.length > 5) {
        errors.push({ field: `${prefix}.routePoints`, message: 'must be array of at most 5 integers' });
      } else {
        routePoints = raw.routePoints.map((p, idx) => asInt(p, `${prefix}.routePoints[${idx}]`, 0, 65535, errors));
      }
    }

    let parts: Record<string, number> = {};
    if (raw.parts !== undefined) {
      if (!isRecord(raw.parts)) {
        errors.push({ field: `${prefix}.parts`, message: 'must be an object' });
      } else {
        for (const [key, value] of Object.entries(raw.parts)) {
          if (!['hull', 'stern', 'bow', 'bridge'].includes(key)) {
            warnings.push({ field: `${prefix}.parts.${key}`, message: 'unknown part ignored' });
            continue;
          }
          parts[key] = asInt(value, `${prefix}.parts.${key}`, 0, 65535, errors);
        }
      }
    }

    const stateRaw = raw.state;
    const state =
      stateRaw === 'sailing' || stateRaw === 'returned' || stateRaw === 'docked' || stateRaw === 'unknown'
        ? stateRaw
        : 'unknown';

    submarines.push({ slotIndex, name, rank, returnAt, routePoints, parts, state });
  }

  if (errors.length > 0) throw new ValidationError(errors);

  return {
    request: { characterId, characterName, worldId, collectedAt, clientTimeOffsetMs, submarines },
    warnings,
  };
}

export interface ParsedSettings {
  patch: SettingsPatch;
  errors: FieldError[];
}

export function parseSettingsPatch(input: unknown): ParsedSettings {
  const errors: FieldError[] = [];
  const patch: SettingsPatch = {};
  if (!isRecord(input)) {
    return { patch, errors: [{ field: 'body', message: 'must be an object' }] };
  }

  if (input.mergeWindowMinutes !== undefined) {
    patch.mergeWindowMinutes = asInt(input.mergeWindowMinutes, 'mergeWindowMinutes', 0, 120, errors);
  }
  if (input.advanceNotificationMinutes !== undefined) {
    const value = asInt(input.advanceNotificationMinutes, 'advanceNotificationMinutes', 0, 60, errors);
    if (!ADVANCE_VALUES.includes(value)) {
      errors.push({ field: 'advanceNotificationMinutes', message: `must be one of ${ADVANCE_VALUES.join(',')}` });
    } else {
      patch.advanceNotificationMinutes = value;
    }
  }
  if (input.notificationEnabled !== undefined) {
    patch.notificationEnabled = asBool(input.notificationEnabled, 'notificationEnabled', errors);
  }
  if (input.provider !== undefined) {
    if (typeof input.provider !== 'string' || !PROVIDERS.includes(input.provider as ProviderKind)) {
      errors.push({ field: 'provider', message: `must be one of ${PROVIDERS.join(',')}` });
    } else {
      patch.provider = input.provider as ProviderKind;
    }
  }
  if (input.providerServerUrl !== undefined) {
    const url = asString(input.providerServerUrl, 'providerServerUrl', 512, errors, { allowEmpty: true });
    if (url && !isHttpUrl(url)) errors.push({ field: 'providerServerUrl', message: 'must be http(s) URL' });
    patch.providerServerUrl = url;
  }
  if (input.providerTopic !== undefined) {
    const topic = asString(input.providerTopic, 'providerTopic', 64, errors, { allowEmpty: true });
    if (topic && !/^[A-Za-z0-9_-]+$/.test(topic)) {
      errors.push({ field: 'providerTopic', message: 'only letters, digits, - and _' });
    }
    patch.providerTopic = topic;
  }
  if (input.providerToken !== undefined) {
    patch.providerToken = asString(input.providerToken, 'providerToken', 512, errors, { allowEmpty: true });
  }
  if (input.notifyTitle !== undefined) patch.notifyTitle = asString(input.notifyTitle, 'notifyTitle', 120, errors);
  if (input.notifyBodyTemplate !== undefined) {
    patch.notifyBodyTemplate = asString(input.notifyBodyTemplate, 'notifyBodyTemplate', 2000, errors, { allowEmpty: true });
  }
  if (input.notifyGroup !== undefined) patch.notifyGroup = asString(input.notifyGroup, 'notifyGroup', 64, errors, { allowEmpty: true });
  if (input.notifySound !== undefined) patch.notifySound = asString(input.notifySound, 'notifySound', 64, errors, { allowEmpty: true });
  if (input.notifyIcon !== undefined) {
    const icon = asString(input.notifyIcon, 'notifyIcon', 512, errors, { allowEmpty: true });
    if (icon && !isHttpUrl(icon)) errors.push({ field: 'notifyIcon', message: 'must be http(s) URL' });
    patch.notifyIcon = icon;
  }
  if (input.notifyPriority !== undefined) patch.notifyPriority = asString(input.notifyPriority, 'notifyPriority', 32, errors);
  if (input.timezone !== undefined) {
    const tz = asString(input.timezone, 'timezone', 64, errors);
    if (tz && !isIanaTimeZone(tz)) errors.push({ field: 'timezone', message: 'unknown IANA time zone' });
    patch.timezone = tz;
  }

  return { patch, errors };
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 推送 URL 安全校验：生产环境只允许 https；
 * 开发环境额外允许 localhost 白名单内的 http（便于本地联调）。
 */
export function validatePushUrl(raw: string, allowHosts: readonly string[], environment: string): { ok: boolean; reason?: string; url?: URL } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase();
    if (environment !== 'dev') return { ok: false, reason: 'https_required' };
    if (!allowHosts.map((h) => h.toLowerCase()).includes(host)) {
      return { ok: false, reason: 'http_host_not_allowed' };
    }
    return { ok: true, url };
  }
  return { ok: false, reason: 'unsupported_protocol' };
}
