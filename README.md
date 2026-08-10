# AI Workflow Builder Backend

This repository contains the backend services for the AI Workflow Builder platform, a low‑code tool for composing agentic workflows from typed steps (LLM calls, HTTP requests, DB writes, notifications, conditional branches, and approval gates).

## Overview

The backend is built on **[Nhost](https://nhost.io)**, a open‑source backend-as-a-service that provides:

- **PostgreSQL** database
- **Hasura** for instant GraphQL APIs (with custom actions and permissions)
- **Auth** (JWT-based authentication, email/password, OAuth)
- **Storage** (S3-compatible via MinIO)
- **Serverless Functions** (Node.js) for custom business logic
- **Traefik** as a reverse proxy
- **Mailhog** for email testing in development

Additionally, a lightweight **FastAPI** listener (`listener/`) is provided to receive webhook events and store them for inspection.

## Architecture

A detailed architectural overview is available in [`AI_Workflow_Builder_Architecture.md`](AI_Workflow_Builder_Architecture.md). Key points:

- Six core entities: Organization, OrgMembers, Workflow, WorkflowStep, WorkflowTrigger, WorkflowRun, StepRun.
- Row‑level security via Hasura, enforced by joins to `org_members`.
- Privileged GraphQL Actions (`triggerWorkflowRun`, `approveStep`) implement business rules not expressible with declarative permissions.
- Workflow runs are immutable for regular users; only the privileged actions can mutate them.
- Denormalized `org_id` on steps, runs, and triggers for performance.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Database | PostgreSQL 14 |
| GraphQL Engine | Hasura v2.48.10 |
| Auth | Nhost Auth (custom) |
| Storage | Nhost Storage (MinIO backend) |
| Serverless Functions | Nhost Functions (Node.js) |
| Reverse Proxy | Traefik v3.6 |
| Email (dev) | Mailhog |
| Webhook Listener | FastAPI (Python) |
| Orchestration | Docker Compose |
| Language for scripts | Node.js (`.mjs`) |

## Getting Started

### Prerequisites

- Docker Engine ≥ 20.10
- Docker Compose V2
- Git
- Node.js ≥ 18 (for running scripts)
- Python ≥ 3.11 (for the FastAPI listener)

### 1. Clone the repository

```bash
git clone <repository-url>
cd AI-Workflow
```

### 2. Start the Nhost services

From the project root:

```bash
docker compose -f .nhost/docker-compose.yaml up -d
```

This will start all containers: auth, graphql, functions, storage, postgres, minio, mailhog, traefik, console, and dashboard.

> **Note**: The first startup may take a few minutes as images are downloaded and databases initialized.

### 3. Verify the services

- **Hasura Console**: https://local.hasura.local.nhost.run/console
- **Nhost Dashboard**: https://local.dashboard.nhost.run
- **Mailhog UI**: https://local.mailhog.local.nhost.run
- **GraphQL endpoint**: https://local.graphql.local.nhost.run/v1/graphql

### 4. Apply Hasura metadata and migrations

The repository includes scripts to export/apply Hasura metadata, create custom actions, and set up permissions.

#### Export metadata (if needed)

```bash
node scripts/hasura-export.mjs
```

#### Apply permissions

```bash
node scripts/hasura-permissions.mjs
```

#### Create custom actions (triggerWorkflowRun, approveStep)

```bash
node scripts/hasura-actions.mjs
```

#### Track tables for the event system (optional)

```bash
node scripts/hasura-track.mjs
```

### 5. Seed development data (optional)

To populate the database with sample organizations, workflows, etc.:

```bash
node scripts/seed-dev-data.mjs
```

### 6. Run the FastAPI webhook listener

The listener captures incoming webhooks and stores them in memory for inspection.

```bash
cd listener
pip install -r requirements.txt
uvicorn main:app --reload
```

The listener will be available at `http://localhost:8000`.

Key endpoints:
- `POST /hooks/workflow` – receive a workflow webhook
- `GET /last` – get the last received entry
- `GET /all` – get all received entries
- `POST /reset` – clear stored entries

## Services Overview

| Service | Container Name | Purpose |
|---------|----------------|---------|
| auth | `auth` | Authentication (JWT, email/password, OAuth) |
| graphql | `graphql` | Hasura GraphQL Engine |
| functions | `functions` | Node.js serverless functions |
| storage | `storage` | S3‑compatible file storage (MinIO) |
| postgres | `postgres` | PostgreSQL database |
| minio | `minio` | Object storage backend for Nhost Storage |
| mailhog | `mailhog` | Email testing (captures outgoing emails) |
| traefik | `traefik` | Reverse proxy and TLS termination |
| console | `console` | Hasura console (optional) |
| dashboard | `dashboard` | Nhost admin dashboard |

## Environment Variables

Most configuration is baked into `.nhost/docker-compose.yaml`. Key variables you may want to adjust:

- `HASURA_GRAPHQL_ADMIN_SECRET` – admin secret for Hasura (default: `nhost-admin-secret`)
- `AUTH_ENCRYPTION_KEY` – secret for encrypting auth data (change in production)
- `JWT` signing keys – RS256 key pair used for token verification
- `LLM_API_KEY` – API key for large language model services (used in functions)
- `NHOST_WEBHOOK_SECRET` – secret for verifying webhooks from Nhost

To override, create an `.env` file in the root (or `.nhost/.env`) and Docker Compose will pick it up.

## Development Workflow

### Backend (Hasura)

1. Make changes to the Hasura metadata via the console or by editing the `nhost/` directory (metadata, migrations, seeds).
2. Export changes to keep the repository in sync:

   ```bash
   node scripts/hasura-export.mjs
   ```

3. Update permissions or actions as needed, then run the respective scripts.

### Functions

The functions directory is mounted into the `functions` container at `/opt/project/functions`. Edit files there; they are hot‑reloaded.

### FastAPI Listener

Edit `listener/main.py` and restart the Uvicorn server to see changes.

## Testing

### Hasura

Hasura includes a GraphQL endpoint that can be queried with the admin secret:

```bash
curl -H "x-hasura-admin-secret: nhost-admin-secret" \
     https://local.graphql.local.nhost.run/v1/graphql \
     -d '{"query":"{ organization { id name } }"}'
```

### FastAPI

Run the provided tests (if any) or manually curl the endpoints.

## Deployment

For production, consider:

- Using managed PostgreSQL and MinIO (or AWS S3).
- Changing all secrets and encryption keys.
- Enabling HTTPS via a proper certificate (Traefik can automate Let's Encrypt).
- Scaling the functions and graphql replicas.
- Disabling the console and dashboard in production (`console` and `dashboard` services can be removed).

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Ensure scripts are updated if you modify Hasura metadata.
5. Open a pull request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Nhost](https://github.com/nhost/nhost) for the open-source BaaS.
- [Hasura](https://hasura.io) for the GraphQL engine.
- [FastAPI](https://fastapi.tiangolo.com) for the webhook listener.