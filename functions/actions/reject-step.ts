import type { Request, Response } from 'express';
import {
  type ActionPayload,
  errorResponse,
  requireUserId,
  requireOrgRole,
  requireWebhookSecret,
} from '../_lib/auth';
import { adminGql } from '../_lib/graphql';

type Input = { step_run_id: string; note?: string | null };

type StepRunRow = {
  id: string;
  workflow_run_id: string;
  position: number;
  type: string;
  status: string;
  workflow_run: { org_id: string; workflow_id: string };
};

/**
 * Hasura Action: rejectStep(step_run_id, note) — fails an awaiting approval gate.
 *
 * Reuses the approval columns already present on step_runs (approved_by,
 * approved_at, approval_note). No schema migration is required: a reject writes
 * status = "failed" on the step run AND the parent workflow run, records the
 * rejecter + note, and does NOT resume execution.
 */
export default async function handler(req: Request, res: Response) {
  try {
    requireWebhookSecret(req);

    const body = req.body as ActionPayload<Input>;
    const userId = requireUserId(body.session_variables);
    const { step_run_id, note } = body.input;

    const stepRun = await adminGql<{ step_runs_by_pk: StepRunRow | null }>(
      `query ($stepRunId: uuid!) {
         step_runs_by_pk(id: $stepRunId) {
           id workflow_run_id position type status
           workflow_run { org_id workflow_id }
         }
       }`,
      { stepRunId: step_run_id },
    );
    const sr = stepRun.step_runs_by_pk;
    if (!sr) {
      return res.status(404).json({ message: 'not found', code: 'not-found' });
    }

    const orgId = sr.workflow_run.org_id;

    // Layer-2: the rejecter must currently hold owner/editor in that org.
    await requireOrgRole(userId, orgId, 'editor');

    if (sr.type !== 'approval_gate' || sr.status !== 'awaiting_approval') {
      return res
        .status(409)
        .json({ message: 'step is not awaiting approval', code: 'not-awaiting-approval' });
    }

    // Mark the gate failed and record who rejected it + why.
    await adminGql(
      `mutation ($id: uuid!, $userId: uuid!, $note: String, $status: step_run_statuses_enum!) {
         update_step_runs_by_pk(
           pk_columns: { id: $id }
           _set: {
             status: $status
             approved_by: $userId
             approved_at: now
             approval_note: $note
           }
         ) { id }
       }`,
      { id: sr.id, userId, note: note ?? null, status: 'failed' },
    );

    // Fail the parent workflow run and close it out.
    await adminGql(
      `mutation ($runId: uuid!, $status: run_statuses_enum!) {
         update_workflow_runs_by_pk(pk_columns: { id: $runId }, _set: { status: $status, finished_at: now }) { id }
       }`,
      { runId: sr.workflow_run_id, status: 'failed' },
    );

    return res.json({
      run_id: sr.workflow_run_id,
      status: 'failed',
      rejected_by: userId,
    });
  } catch (err) {
    const r = errorResponse(err);
    return res.status(r.status).json(r.body);
  }
}
