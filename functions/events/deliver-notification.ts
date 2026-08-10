import type { Request, Response } from 'express';
import { requireWebhookSecret } from '../_lib/auth';
import { adminGql } from '../_lib/graphql';

type EventPayload = {
  event: {
    session_variables: Record<string, string>;
    op: string;
    data: { new: Record<string, any> | null; old: Record<string, any> | null };
  };
  table: { schema: string; name: string };
  delivery_info: { current_retry: number; max_retries: number };
};

/**
 * Event-trigger handler for the notify step. The notify step's work is the
 * notifications row insert; this handler performs the (stubbed) delivery and
 * marks the row as sent. A retry re-runs this idempotently.
 */
export default async function handler(req: Request, res: Response) {
  try {
    requireWebhookSecret(req);

    const body = req.body as EventPayload;
    const notification = body.event?.data?.new;
    if (!notification?.id) {
      return res.status(200).json({ ok: true, skipped: 'no row' });
    }

    // Real delivery (Slack/email) would POST here. Stubbed for local dev.
    const channel = String(notification.channel ?? 'email');
    const target = String(notification.target ?? '');
    const subject = notification.subject ?? '';
    const bodyText = notification.body ?? '';

    console.log(
      `[notify] ${channel} -> ${target} | ${subject}\n  ${String(bodyText).slice(0, 300)}`,
    );

    await adminGql(
      `mutation ($id: uuid!) {
         update_notifications_by_pk(pk_columns: { id: $id }, _set: { status: "sent", sent_at: now, error: null }) { id }
       }`,
      { id: notification.id },
    );

    return res.json({ ok: true, status: 'sent' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('notify delivery failed', message);
    // Return 2xx so the event trigger does not retry a hopeless notification.
    return res.status(200).json({ ok: false, error: message });
  }
}
