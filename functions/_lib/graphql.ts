import { ADMIN_SECRET, GRAPHQL_URL } from './env';

type GqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

/**
 * Admin-context GraphQL call. Every handler runs as admin and is therefore
 * responsible for its own authorisation checks — see requireOrgRole().
 */
export async function adminGql<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as GqlResponse<T>;
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join('; '));
  }
  if (!body.data) {
    throw new Error('GraphQL response contained no data');
  }
  return body.data;
}
