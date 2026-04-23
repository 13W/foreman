# foreman-stack

pnpm monorepo for the Foreman agent system.

## Packages

- **`@foreman-stack/shared`** — shared types, schemas, and utilities
- **`@foreman-stack/proxy`** — ACP↔A2A protocol adapter
- **`@foreman-stack/foreman`** — head agent (Foreman)

## Requirements

- Node.js >= 24.0.0
- pnpm 10.x

## Usage

```bash
pnpm install   # install all dependencies
pnpm build     # compile all packages via tsc --build
```

## Development

```bash
# Testing
pnpm test          # run all tests once (vitest)
pnpm test:watch    # run tests in watch mode

# Linting
pnpm lint          # ESLint on all packages (flat config, eslint.config.js)

# Formatting
pnpm format        # Prettier --write on all packages
pnpm format:check  # Prettier --check (used in CI)
```

Config files at root: `eslint.config.js`, `.prettierrc.json`, `vitest.config.ts`.
