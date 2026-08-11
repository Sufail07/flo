import type { Request, Response } from 'express';
import { errorResponse, requireWebhookSecret } from '../_lib/auth';
import { adminGql } from '../_lib/graphql';
import { reserveQuota } from '../_lib/runner';

type Input = { token: string; payload?: Record<string, unknown> };

type TriggerRow = {
  id: string;
  workflow_id: string;
  org_id: string;
  type: string;
  is_enabled: boolean;
};

/**
 * Hasura Action: webhookTriggerRun(token, payload) — inbound endpoint for
 * external systems to start a run without a user session.
 *
 * Authorization is the trigger's webhook_token itself: the handler looks it up
 * in workflow_triggers and requires the trigger to be enabled. The run is
 * recorded as trigger_type "webhook". Because the token is the capability, a
 * forged or revoked token resolves to nothing and returns 404.
 */
export default async function handler(req: Request, res: Response) {
  try {
    requireWebhookSecret(req);

    const { input } = req.body as { input: Input };
    const { token, payload } = input;

    const trigger = await adminGql<{ workflow_triggers: TriggerRow[] }>(
      `query ($token: String!) {
         workflow_triggers(where: { webhook_token: { _eq: $token } }) {
           id workflow_id org_id type is_enabled
         }
       }`,
      { token },
    );
    const tr = trigger.workflow_triggers[0];
    if (!tr || !tr.is_enabled) {
      return res.status(404).json({ message: 'not found', code: 'not-found' });
    }

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
          trigger_type: 'webhook',
          status: 'pending',
          input: payload ?? {},
        },
      },
    );
    const runId = created.insert_workflow_runs_one.id;

    // Execution is handed to the execute-run Event Trigger so the caller is not
    // held open for the whole run.
    return res.json({
      run_id: runId,
      status: 'pending',
      paused_at_step_run_id: null,
    });
  } catch (err) {
    const r = errorResponse(err);
    return res.status(r.status).json(r.body);
  }
}
