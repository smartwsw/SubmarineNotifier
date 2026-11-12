export type ProviderKind = 'bark' | 'ntfy' | 'none';

export type SubmarineState = 'unknown' | 'sailing' | 'returned' | 'docked';

export type BatchStatus = 'pending' | 'sent' | 'cancelled' | 'failed';

export type LogEventType = 'advance' | 'returned' | 'test' | 'next' | 'sync' | 'error';

export type LogStatus = 'sending' | 'sent' | 'failed' | 'skipped';

export interface UserRow {
  id: string;
  created_at: number;
  updated_at: number;
  status: string;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  device_name: string;
  created_at: number;
  last_seen_at: number;
  status: string;
}

export interface ApiTokenRow {
  id: string;
  user_id: string;
  device_id: string | null;
  token_hash: string;
  token_prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  rotated_from: string | null;
}

export interface SubmarineRow {
  id: string;
  user_id: string;
  character_id: string;
  character_name: string;
  world_id: number | null;
  slot_index: number;
  submarine_name: string;
  state: SubmarineState;
  return_at: number;
  rank: number;
  route_points: string;
  parts: string;
  collected_at: number;
  last_uploaded_at: number;
  updated_at: number;
  active: number;
}

export interface UserSettingsRow {
  user_id: string;
  merge_window_minutes: number;
  advance_notification_minutes: number;
  notification_enabled: number;
  provider: ProviderKind;
  provider_server_url: string;
  provider_token_enc: string;
  provider_topic: string;
  notify_title: string;
  notify_body_template: string;
  notify_group: string;
  notify_sound: string;
  notify_icon: string;
  notify_priority: string;
  timezone: string;
  updated_at: number;
}

export interface BatchRow {
  id: string;
  user_id: string;
  anchor_return_at: number;
  latest_return_at: number;
  notify_at: number;
  advance_notify_at: number | null;
  status: BatchStatus;
  advanced_sent_at: number | null;
  sent_at: number | null;
  attempt_count: number;
  next_retry_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface BatchItemRow {
  batch_id: string;
  submarine_id: string;
  return_at: number;
}

export interface NotificationLogRow {
  id: string;
  user_id: string;
  batch_id: string | null;
  event_type: LogEventType;
  event_key: string;
  status: LogStatus;
  provider: string;
  attempts: number;
  error_message: string | null;
  created_at: number;
}

// ---------- wire DTOs ----------

export interface SubmarineSyncItem {
  slotIndex: number;
  name: string;
  rank: number;
  returnAt: number;
  routePoints: number[];
  parts: Record<string, number>;
  state: SubmarineState;
}

export interface SyncRequest {
  characterId: string;
  characterName: string;
  worldId: number | null;
  collectedAt: number;
  clientTimeOffsetMs: number;
  submarines: SubmarineSyncItem[];
}

export interface SettingsPatch {
  mergeWindowMinutes?: number;
  advanceNotificationMinutes?: number;
  notificationEnabled?: boolean;
  provider?: ProviderKind;
  providerServerUrl?: string;
  providerTopic?: string;
  providerToken?: string;
  notifyTitle?: string;
  notifyBodyTemplate?: string;
  notifyGroup?: string;
  notifySound?: string;
  notifyIcon?: string;
  notifyPriority?: string;
  timezone?: string;
}

export interface PushTarget {
  provider: ProviderKind;
  serverUrl: string;
  token: string;
  topic: string;
}

export interface PushMessage {
  title: string;
  body: string;
  group: string;
  sound: string;
  icon: string;
  priority: string;
  clickUrl?: string;
  topic: string;
}

export interface PushResult {
  delivered: boolean;
  provider: string;
  latencyMs: number;
  statusCode?: number;
  error?: string;
}

export interface MergeEvent {
  submarineId: string;
  returnAt: number;
}

export interface MergeBatch {
  items: MergeEvent[];
  anchorReturnAt: number;
  latestReturnAt: number;
  notifyAt: number;
}
