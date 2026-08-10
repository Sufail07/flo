// Prefer the container-internal URL. NHOST_GRAPHQL_URL points at the
// host-routed address (local.graphql.local.nhost.run) which resolves to the
// container itself from inside the functions service and 404s every call.
export const GRAPHQL_URL =
  process.env.HASURA_GRAPHQL_GRAPHQL_URL ??
  process.env.NHOST_GRAPHQL_URL ??
  'http://graphql:8080/v1/graphql';

export const ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET ?? '';

export const WEBHOOK_SECRET = process.env.NHOST_WEBHOOK_SECRET ?? '';

// Base URL of the functions service, used when a handler needs to re-enter
// itself (e.g. resuming a run after an approval).
export const FUNCTIONS_URL =
  process.env.NHOST_FUNCTIONS_URL ?? 'http://functions:3000/v1';

export const LLM_BASE_URL =
  process.env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1';

export const LLM_API_KEY = process.env.LLM_API_KEY ?? '';

export const LLM_DEFAULT_MODEL =
  process.env.LLM_DEFAULT_MODEL ?? 'llama-3.3-70b-versatile';

// When no API key is configured the llm_call step falls back to a stubbed
// response with an artificial delay, as the assignment permits.
export const LLM_STUBBED = LLM_API_KEY === '';
