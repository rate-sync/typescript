# Contributing to rate-sync

Thanks for your interest in contributing! This guide will help you get started.

## Quick Start

```bash
git clone https://github.com/rate-sync/typescript.git
cd typescript
pnpm install
pnpm test
```

## Development Workflow

### 1. Create a Branch

```bash
git checkout -b feat/your-feature
```

### 2. Make Changes

- Write code with TypeScript strict mode
- Add tests for new functionality
- Update JSDoc comments (Google style)

### 3. Verify

```bash
pnpm test                    # Run tests
pnpm run typecheck           # Type check
```

### 4. Commit

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add sliding window support for memory engine
fix: correct token calculation on edge case
docs: clarify Redis configuration options
test: add coverage for composite limiter
refactor: extract validation logic
```

### 5. Submit PR

- Push your branch
- Open a PR against `main`
- Fill in the PR template
- Ensure CI passes

## Code Style

We use **TypeScript strict mode** with ESM imports. Key conventions:

| Convention | Example |
|------------|---------|
| TypeScript | Strict mode, no implicit any |
| Naming | `camelCase` functions, `PascalCase` classes |
| Docstrings | JSDoc (Google style) |
| Imports | ESM with `.js` extension (`import { foo } from './bar.js'`) |

All public functions need JSDoc comments:

```typescript
/**
 * Acquire a rate limit slot.
 *
 * @param timeout - Max milliseconds to wait. Omit to try once without waiting.
 * @returns True if acquired, false if timed out or limit exceeded.
 */
async tryAcquire(timeout?: number): Promise<boolean> {
```

## Testing

### Run Tests

```bash
# Unit tests only (fast)
pnpm test

# Watch mode
pnpm run test:watch

# Specific file
pnpm test tests/unit/rate-limiter.test.ts
```

### Integration Tests

Require external services (Redis):

```bash
docker compose up -d
export REDIS_URL="redis://localhost:6379/0"
pnpm test tests/integration
```

### Write Tests

```typescript
import { describe, it, expect } from 'vitest';

describe('Feature', () => {
  it('basic case', async () => {
    // Arrange
    const limiter = new RateLimiter({ id: 'test', store, storeId: 'test-store', ratePerSecond: 10 });
    await limiter.initialize();

    // Act
    const result = await limiter.checkLimit();

    // Assert
    expect(result.allowed).toBe(true);
  });
});
```

## PR Checklist

Before submitting:

- [ ] Tests pass locally (`pnpm test`)
- [ ] Formatting is clean
- [ ] Linting passes
- [ ] Type check passes (`pnpm run typecheck`)
- [ ] Public APIs have JSDoc comments
- [ ] Coverage for new code

## What to Contribute

- **Good first issues**: Check [issues labeled `good-first-issue`](https://github.com/rate-sync/typescript/issues?q=label%3Agood-first-issue)
- **New engines**: See the [engines/](src/engines/) directory for the `RateLimitStore` interface (e.g., adding a PostgreSQL engine)
- **Bug fixes**: Always welcome
- **Documentation**: Improvements and examples

## Getting Help

- **Questions**: [GitHub Issues](https://github.com/rate-sync/typescript/issues)
- **Bugs**: [GitHub Issues](https://github.com/rate-sync/typescript/issues)
- **Security**: Email security@rate-sync.dev (do not open public issue)

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be respectful and constructive.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
