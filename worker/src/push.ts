// Web Push (browser/mobile notifications delivered even with the tab closed).
// Subscriptions are stored per device; dispatchPush() resolves which devices
// match a notification's audience and sends to each, using the same
// audience_type/audience_value vocabulary as notifications.ts.

import { buildPushPayload, type PushMessage, type PushSubscription as WebPushSubscription, type VapidKeys } from '@block65/webcrypto-web-push';
import type { Env } from './types';

export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

type SubscriberType = 'staff' | 'student';

export async function savePushSubscription(db: D1Database, subscriberType: SubscriberType, subscriberId: string, sub: SubscriptionInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO push_subscriptions (subscriber_type, subscriber_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET subscriber_type = excluded.subscriber_type, subscriber_id = excluded.subscriber_id,
         p256dh = excluded.p256dh, auth = excluded.auth`,
    )
    .bind(subscriberType, subscriberId, sub.endpoint, sub.p256dh, sub.auth)
    .run();
}

export async function deletePushSubscription(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
}

type SubRow = { endpoint: string; p256dh: string; auth: string };

async function getStaffSubscriptions(db: D1Database, audienceType: string, audienceValue: string | null): Promise<SubRow[]> {
  if (audienceType === 'all_staff') {
    const { results } = await db.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE subscriber_type = 'staff'`).all<SubRow>();
    return results ?? [];
  }
  if (audienceType === 'role' && audienceValue) {
    const { results } = await db
      .prepare(
        `SELECT ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps
         JOIN staff st ON st.identity = ps.subscriber_id COLLATE NOCASE
         WHERE ps.subscriber_type = 'staff' AND st.is_admin = ?`,
      )
      .bind(audienceValue === 'admin' ? 1 : 0)
      .all<SubRow>();
    return results ?? [];
  }
  if (audienceType === 'staff_identity' && audienceValue) {
    const { results } = await db
      .prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE subscriber_type = 'staff' AND subscriber_id = ? COLLATE NOCASE`)
      .bind(audienceValue)
      .all<SubRow>();
    return results ?? [];
  }
  return [];
}

async function getStudentSubscriptions(db: D1Database, audienceType: string, audienceValue: string | null): Promise<SubRow[]> {
  if (audienceType === 'all_students') {
    const { results } = await db.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE subscriber_type = 'student'`).all<SubRow>();
    return results ?? [];
  }
  if (audienceType === 'student' && audienceValue) {
    const { results } = await db
      .prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE subscriber_type = 'student' AND subscriber_id = ? COLLATE NOCASE`)
      .bind(audienceValue)
      .all<SubRow>();
    return results ?? [];
  }
  return [];
}

async function sendPush(db: D1Database, row: SubRow, message: PushMessage, vapid: VapidKeys): Promise<void> {
  const subscription: WebPushSubscription = { endpoint: row.endpoint, expirationTime: null, keys: { p256dh: row.p256dh, auth: row.auth } };
  try {
    const payload = await buildPushPayload(message, subscription, vapid);
    const res = await fetch(subscription.endpoint, { method: payload.method, headers: payload.headers, body: payload.body });
    // 404/410 means the push service considers this endpoint gone for good
    // (uninstalled, permission revoked) — stop trying it.
    if (res.status === 404 || res.status === 410) {
      await deletePushSubscription(db, row.endpoint);
    }
  } catch {
    // Best-effort: one unreachable device must never affect notification
    // creation or any other recipient.
  }
}

export interface DispatchPushInput {
  audienceType: string;
  audienceValue?: string | null;
  title: string;
  body?: string | null;
  linkUrl?: string | null;
}

export async function dispatchPush(env: Env, input: DispatchPushInput): Promise<void> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return; // push not configured on this deployment
  const db = env.DB;
  const audienceValue = input.audienceValue ?? null;

  let subs: SubRow[];
  if (input.audienceType === 'all') {
    const [staff, students] = await Promise.all([
      getStaffSubscriptions(db, 'all_staff', null),
      getStudentSubscriptions(db, 'all_students', null),
    ]);
    subs = [...staff, ...students];
  } else if (input.audienceType === 'all_staff' || input.audienceType === 'role' || input.audienceType === 'staff_identity') {
    subs = await getStaffSubscriptions(db, input.audienceType, audienceValue);
  } else if (input.audienceType === 'all_students' || input.audienceType === 'student') {
    subs = await getStudentSubscriptions(db, input.audienceType, audienceValue);
  } else {
    subs = [];
  }
  if (!subs.length) return;

  const vapid: VapidKeys = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const message: PushMessage = {
    data: { title: input.title, body: input.body ?? '', url: input.linkUrl || '/' },
    options: { ttl: 60 * 60 * 24, urgency: 'normal' },
  };

  await Promise.allSettled(subs.map((row) => sendPush(db, row, message, vapid)));
}
