# Enterprise features and roadmap

## Available now

| Area | What you get | Where |
|---|---|---|
| **Projects & RBAC** | Many projects in one installation; members with viewer / editor / admin / owner roles; all data project-scoped; archived projects are read-only | Projects page, `/projects` API |
| **Accounts** | User administration, temporary passwords with forced change, password policy, lockout after failed sign-ins, deactivation | Admin → Users, `/admin/users` |
| **API keys** | Per project, with a maximum role; for CI pipelines and the CLI | Account page, `/auth/api-keys` |
| **Audit log** | Every change and sign-in with actor, IP and details; filters and CSV export; retention | Audit Log page, `/audit` |
| **Secrets** | Agent secrets and Salesforce persona credentials encrypted with AES-256-GCM, write-only, masked in logs, `{{secrets.NAME}}` in steps | Agent page |
| **Salesforce personas** | Test as administrators and low-privilege users: UI password, TOTP MFA, OAuth JWT bearer + frontdoor, OAuth password, Log in as; identity checks; persona matrix runs; object / field / record access assertions | [salesforce-guide.md](salesforce-guide.md) |
| **Automation** | Cron schedules with time zones; CI trigger with `wait` (exit status from the API); notifications to webhooks (HMAC-signed), Slack, Teams and email | Schedules, Settings → Notifications |
| **Insights** | Pass rate trends, flaky tests (status flips, passed on retry), top failures, slowest tests | Analytics page, `/analytics` |
| **Security** | Signed, expiring screenshot URLs; authenticated WebSockets; SSRF guard for outbound notifications; rate limiting; versioned, advisory-locked migrations | — |
| **Operations** | OpenAPI 3.1 spec and interactive docs at `/api/docs`; health/readiness endpoints; Prometheus metrics; data retention; Docker images and a full-stack compose file | [RUNNING.md](../RUNNING.md) |

## Roadmap (not implemented yet)

1. **Single sign-on and provisioning** — OIDC / SAML login (Entra ID, Okta, Google) with group → project-role mapping; SCIM 2.0 user provisioning; enforce SSO-only sign-in per organisation.
2. **Horizontal scale-out** — run execution in a worker pool fed by a queue (e.g. PostgreSQL `SKIP LOCKED` or Redis), so API replicas and browser workers scale independently; parallel tests inside a run.
3. **Object storage** — screenshots, traces and videos in S3 / Azure Blob / GCS with pre-signed URLs instead of the local volume.
4. **Observability** — OpenTelemetry traces across API, executor and LLM calls; structured log shipping.
5. **Change control** — approvals for changes to agents and test cases in protected projects; test-case version diff and restore.
6. **Secrets management** — external key management (AWS KMS, Azure Key Vault, HashiCorp Vault) instead of a single `SECRETS_ENCRYPTION_KEY`; key rotation tooling.
7. **Salesforce** — persona credentials from a vault, automatic creation and clean-up of test users and permission set assignments in sandboxes, Experience Cloud (community) user logins, permission set group and muting-aware admin-side checks.
8. **Compliance** — tenant-level data residency, audit log streaming to a SIEM, configurable session timeouts and IP allow-lists.
