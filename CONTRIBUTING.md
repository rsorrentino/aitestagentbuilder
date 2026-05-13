# Contributing to AI Test Agent Builder

Thank you for your interest in contributing! This document explains how to get involved.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating you agree to abide by its terms.

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/aitestagentbuilder.git
   cd aitestagentbuilder
   ```
3. **Add the upstream remote** so you can pull future changes:
   ```bash
   git remote add upstream https://github.com/<org>/aitestagentbuilder.git
   ```
4. **Create a branch** for your work:
   ```bash
   git checkout -b feat/my-feature
   ```

## How to Contribute

| Type | What to do |
|------|-----------|
| Bug fix | Open an issue first (unless it's trivial), then submit a PR |
| New feature | Open a feature request issue and discuss before coding |
| Documentation | PRs welcome without a prior issue |
| Tests | PRs welcome without a prior issue |

## Development Setup

### Prerequisites

- Node.js 18+
- Python 3.10+
- PostgreSQL 14+ with the `pgvector` extension
- Docker (optional but recommended for the database)

### 1. Install dependencies

```bash
# Backend
cd backend && npm install

# Executor
cd executor && pip install -r requirements.txt
playwright install chromium
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and OPENAI_API_KEY
```

### 3. Set up the database

```bash
# Using Docker (quick)
docker run -d \
  --name pg-aitab \
  -e POSTGRES_DB=aitestagentbuilder \
  -e POSTGRES_USER=user \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  pgvector/pgvector:pg16

# Run migrations
cd backend && npm run db:migrate
```

### 4. Start the backend

```bash
cd backend && npm run dev
```

## Coding Standards

### TypeScript (backend / mcp-server / frontend)

- ESLint is configured — run `npm run lint` before committing.
- No `any` types without a comment explaining why.
- Keep functions small and single-purpose.

### Python (executor)

- Follow [PEP 8](https://pep8.org/).
- Type-annotate all public functions.
- Use `pytest` for tests (no `unittest`).

### General

- Write tests for new behaviour.
- Do not commit `.env` or any file containing secrets.
- Keep commits atomic and write meaningful commit messages (see [Conventional Commits](https://www.conventionalcommits.org/)).

## Testing

```bash
# Backend unit + integration tests
cd backend && npm test

# With coverage
cd backend && npm run test:coverage

# Executor tests
cd executor && pytest
```

All tests must pass before a PR can be merged. CI will run them automatically.

## Submitting a Pull Request

1. Make sure your branch is up to date with `upstream/main`:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```
2. Push your branch and open a PR against `main`.
3. Fill out the PR template completely.
4. Link the related issue (e.g. `Closes #42`).
5. Wait for a review — a maintainer will respond within a few days.

### PR checklist

- [ ] Tests added / updated
- [ ] `npm run lint` passes (backend)
- [ ] `pytest` passes (executor)
- [ ] Documentation updated if behaviour changed
- [ ] No secrets or environment files committed

## Reporting Issues

Use the GitHub issue tracker. Before opening a new issue, search existing ones to avoid duplicates. When reporting a bug, include:

- Steps to reproduce
- Expected vs. actual behaviour
- Version / environment (Node, Python, OS)
- Relevant logs or screenshots
