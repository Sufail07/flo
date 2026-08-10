import type { Request } from 'express';
import { WEBHOOK_SECRET } from './env';
import { adminGql } from './graphql';

export type OrgRole = 'owner' | 'editor' | 'viewer';

const RANK: Record<OrgRole, number> = { viewer: 0, editor: 1, owner: 2 };

export class HandlerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'bad-request',
  ) {
    super(message);
  }
}

export type SessionVariables = Record<string, string | undefined>;

export type ActionPayload<TInput> = {
  input: TInput;
  session_variables: SessionVariables;
  action: { name: string };
};

/**
 * Nhost functions are publicly routable. Without this check anyone could POST
 * a forged Action or Event payload and drive the engine directly.
 */
export function requireWebhookSecret(req: Request): void {
  const provided =
    (req.headers['nhost-webhook-secret'] as string | undefined) ??
    (req.headers['x-nhost-webhook-secret'] as string | undefined);

  if (!WEBHOOK_SECRET || provided !== WEBHOOK_SECRET) {
    throw new HandlerError('invalid webhook secret', 401, 'unauthorized');
  }
}

export function requireUserId(session: SessionVariables): string {
  const userId = session['x-hasura-user-id'];
  if (!userId) {
    throw new HandlerError('authentication required', 401, 'unauthorized');
  }
  return userId;
}

/**
 * Layer 2 of the permission model.
 *
 * Actions execute with admin rights, so Hasura's row permissions never run.
 * This re-derives the caller's ACTUAL role in the target org from org_members
 * rather than trusting x-hasura-role, which is only a claimed capability —
 * a user may be owner in one org and viewer in another.
 */
export async function requireOrgRole(
  userId: string,
  orgId: string,
  minimum: OrgRole,
): Promise<OrgRole> {
  const data = await adminGql<{
    org_members: Array<{ role: OrgRole }>;
  }>(
    `query ($userId: uuid!, $orgId: uuid!) {
       org_members(
         where: { user_id: { _eq: $userId }, org_id: { _eq: $orgId } }
         limit: 1
       ) { role }
     }`,
    { userId, orgId },
  );

  const membership = data.org_members[0];

  // Same error for "not a member" and "insufficient role" so a caller cannot
  // probe which organisations exist by comparing responses.
  if (!membership || RANK[membership.role] < RANK[minimum]) {
    throw new HandlerError(
      'not permitted for this organization',
      403,
      'forbidden',
    );
  }

  return membership.role;
}

export function errorResponse(err: unknown): {
  status: number;
  body: { message: string; code: string };
} {
  if (err instanceof HandlerError) {
    return { status: err.status, body: { message: err.message, code: err.code } };
  }
  console.error('unhandled handler error', err);
  return {
    status: 500,
    body: { message: 'internal error', code: 'internal-error' },
  };
}
