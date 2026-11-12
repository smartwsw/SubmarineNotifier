import type { Repository } from '../storage/repository.js';
import type { SubmarineSyncItem, SyncRequest } from '../models/index.js';
import { sha256Hex } from '../utils/crypto.js';
import { deriveState, validateReturnAt } from '../utils/time.js';
import { ValidationError, type FieldError } from '../utils/validation.js';

export interface SyncOutcome {
  accepted: number;
  changed: number;
  warnings: FieldError[];
  deduped: boolean;
  removed: number;
  /** 整批数据都比库里的旧（同一账号在另一处登录留下的旧快照），未写入任何内容 */
  stale: boolean;
}

/**
 * 客户端时钟与服务器相差超过这个值时，认为采集时刻不可信，退回"后到者生效"。
 * 否则一台时钟坏掉的设备会永远推不上数据。
 */
const MAX_TRUSTED_CLOCK_SKEW_SECONDS = 86400;

/**
 * 把客户端上报的采集时刻换算到服务器时间轴。
 *
 * 返回 0 表示"无法判断"（旧版客户端没上报、或本机时钟偏差过大），调用方应跳过陈旧判定。
 * 采集时刻永远不应晚于服务器当前时间，因此向上截断。
 */
export function effectiveCollectedAt(request: SyncRequest, now: number): number {
  if (request.collectedAt <= 0) return 0;
  const offsetSeconds = Math.round((request.clientTimeOffsetMs ?? 0) / 1000);
  const corrected = request.collectedAt + offsetSeconds;
  if (Math.abs(corrected - now) > MAX_TRUSTED_CLOCK_SKEW_SECONDS) return 0;
  return Math.min(corrected, now);
}

/**
 * 处理一次 submarine sync：
 *  - 内容哈希去重（7 天）；
 *  - 逐槽位 upsert，仅在 returnAt/name/rank/route 变化时视为 changed；
 *  - 采集时刻早于库中该槽位的采集时刻时判定为旧快照，跳过不覆盖；
 *  - 本次未出现的槽位标记 active=0（整批都陈旧时不做，避免旧快照误删槽位）。
 *
 * 返回 changed > 0 时，调用方需要触发批次重算。
 */
export async function applySync(
  repo: Repository,
  userId: string,
  request: SyncRequest,
  now: number,
): Promise<SyncOutcome> {
  const warnings: FieldError[] = [];
  const hash = await sha256Hex(
    JSON.stringify({
      userId,
      characterId: request.characterId,
      submarines: [...request.submarines]
        .sort((a, b) => a.slotIndex - b.slotIndex)
        .map((s) => [s.slotIndex, s.name, s.rank, s.returnAt, s.routePoints]),
    }),
  );

  const existing = await repo.listAllSubmarines(userId);
  const characterRows = existing.filter((row) => row.character_id === request.characterId);
  // 停用的行也要参与新旧比较，否则旧设备上报能把它重新激活（复活已删除的槽位）
  const byKey = new Map(characterRows.map((row) => [row.slot_index, row]));

  const collectedAt = effectiveCollectedAt(request, now);

  const isStaleSlot = (item: { slotIndex: number }): boolean => {
    const previous = byKey.get(item.slotIndex);
    return previous !== undefined && collectedAt > 0 && previous.collected_at > collectedAt;
  };

  // 内容与 7 天内的某次 sync 相同，通常可以直接跳过。
  // 但如果这次上报会"复活"某个已被停用的槽位，它就不是无操作 ——
  // 必须继续走下面的逐槽位新旧判定（旧设备的快照往往正是这种重复内容）。
  const revivesInactiveSlot = request.submarines.some((item) => byKey.get(item.slotIndex)?.active !== 1 && byKey.has(item.slotIndex));

  if (!revivesInactiveSlot && (await repo.isDuplicateSync(hash, now))) {
    return { accepted: 0, changed: 0, warnings, deduped: true, removed: 0, stale: false };
  }

  let changed = 0;
  let accepted = 0;
  let staleCount = 0;
  const seenSlots: number[] = [];

  for (const item of request.submarines) {
    const check = validateReturnAt(item.returnAt, now);
    if (!check.valid) {
      // 该槽位本次不上传，也不视为"消失"（避免把合理潜艇误标为已移除）
      warnings.push({ field: `submarines[${item.slotIndex}].returnAt`, message: check.reason ?? 'invalid' });
      seenSlots.push(item.slotIndex);
      continue;
    }

    seenSlots.push(item.slotIndex);

    const previous = byKey.get(item.slotIndex);

    // 同一账号可能在不同设备/地点同时登录：旧快照不能覆盖新数据。
    // 只有两边采集时刻都可判定时才比较，避免旧版客户端(恒为 0)被永久拒绝。
    // 停用的槽位同样适用：否则旧设备能把已删除的潜水艇重新激活。
    if (previous && isStaleSlot(item)) {
      staleCount += 1;
      warnings.push({
        field: `submarines[${item.slotIndex}].collectedAt`,
        message: `stale_snapshot: dropped, stored snapshot is newer (${previous.collected_at} > ${collectedAt})`,
      });
      continue;
    }

    accepted += 1;

    const state = deriveState(item.returnAt, now);
    const routeJson = JSON.stringify(item.routePoints);
    const partsJson = JSON.stringify(item.parts);

    const isChanged =
      !previous ||
      previous.active !== 1 ||
      previous.return_at !== item.returnAt ||
      previous.submarine_name !== item.name ||
      previous.rank !== item.rank ||
      previous.route_points !== routeJson;

    await repo.upsertSubmarine({
      userId,
      characterId: request.characterId,
      characterName: request.characterName,
      worldId: request.worldId,
      slotIndex: item.slotIndex,
      name: item.name,
      state,
      returnAt: item.returnAt,
      rank: item.rank,
      routePoints: routeJson,
      parts: partsJson,
      collectedAt: collectedAt > 0 ? collectedAt : request.collectedAt,
      now,
      existingId: previous?.id,
      active: true,
    });

    if (isChanged) changed += 1;
  }

  // 整批都是旧快照：说明这台设备读到的是过时数据，
  // 此时既不能覆盖，也不能据此把"本次没出现的槽位"当成已移除。
  const stale = staleCount > 0 && accepted === 0;

  if (stale) {
    // 哈希不记录：等设备重新采集到新数据时，相同内容仍需有机会正常入库。
    return { accepted: 0, changed: 0, warnings, deduped: false, removed: 0, stale: true };
  }

  const removed = characterRows.filter((row) => row.active === 1 && !seenSlots.includes(row.slot_index)).length;

  // 本次不再存在的槽位（或者整批为空）→ 软删除。
  // 采集时刻不可判定（旧版客户端 / 时钟离谱）时退回服务器时间，仍然记下"何时看到的"。
  await repo.deactivateSubmarinesNotIn(
    userId,
    request.characterId,
    seenSlots,
    now,
    collectedAt > 0 ? collectedAt : now,
  );
  if (removed > 0) changed += 1;

  await repo.recordSyncHash(hash, userId, now);

  return { accepted, changed, warnings, deduped: false, removed, stale: false };
}

export function normalizeItem(raw: SubmarineSyncItem): SubmarineSyncItem {
  return {
    slotIndex: raw.slotIndex,
    name: raw.name.trim().slice(0, 40),
    rank: raw.rank,
    returnAt: raw.returnAt,
    routePoints: raw.routePoints.slice(0, 5),
    parts: raw.parts,
    state: raw.state,
  };
}

export { ValidationError };
