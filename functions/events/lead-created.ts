import type { Request, Response } from 'express';
import { requireWebhookSecret } from '../_lib/auth';
import { adminGql } from '../_lib/graphql';
import { reserveQuota } from '../_lib/runner';

type EventPayload = {
  event: {
    session_variables: Record<string, string>;
    op: string;
    data: { new: Record<string, any> | null; old: Record<string, any> | null };
  };
  table: { schema: string; name: string };
  delivery_info: { current_retry: number; max_retries: number };
};

type TriggerRow = {
  id: string;
  workflow_id: string;
  org_id: string;
  is_enabled: boolean;
};

/**
 * Event-trigger handler for the database_event trigger type. Fires when a
 * leads row is inserted: finds an enabled database_event trigger in that org
 * and starts a run. Execution is handed to the execute-run Event Trigger (the
 * run is inserted as 'pending' and this handler returns immediately), matching
 * the manual and webhook trigger paths.
 */
export default async function handler(req: Request, res: Response) {
  try {
    requireWebhookSecret(req);

    const body = req.body as EventPayload;
    const lead = body.event?.data?.new;
    if (!lead?.org_id) {
      return res.status(200).json({ ok: true, skipped: 'no org' });
    }

    const triggers = await adminGql<{ workflow_triggers: TriggerRow[] }>(
      `query ($orgId: uuid!, $type: trigger_types_enum!) {
         workflow_triggers(
           where: { org_id: { _eq: $orgId }, type: { _eq: $type }, is_enabled: { _eq: true } }
         ) { id workflow_id org_id is_enabled }
       }`,
      { orgId: lead.org_id, type: 'database_event' },
    );

    if (triggers.workflow_triggers.length === 0) {
      return res.status(200).json({ ok: true, skipped: 'no database_event trigger' });
    }

    const tr = triggers.workflow_triggers[0];

    const reserved = await reserveQuota(tr.org_id);
    if (!reserved) {
      return res
        .status(429)
        .json({ message: 'organization quota exhausted', code: 'quota-exhausted' });
    }

    const created = await adminGql<{ insert_workflow_runs_one: { id: string } }>(
      `mutation ($obj: workflow_runs_insert_input!) {
         insert_workflow_runs_one(object: $obj) { id }
       }`,
      {
        obj: {
          workflow_id: tr.workflow_id,
          org_id: tr.org_id,
          trigger_id: tr.id,
          trigger_type: 'database_event',
          status: 'pending',
          input: { lead_id: lead.id, email: lead.email ?? null },
        },
      },
    );
    const runId = created.insert_workflow_runs_one.id;

    return res.json({
      run_id: runId,
      status: 'pending',
      paused_at_step_run_id: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('lead-created handler failed', message);
    // Return 2xx so a transient handler bug does not pin the event in retry.
    return res.status(200).json({ ok: false, error: message });
  }
}
