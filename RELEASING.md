# Releasing

The package is published to npm by GitHub Actions when a version tag is pushed
(`.github/workflows/publish.yml`). It is built in CI and published with an npm provenance
statement. Never publish from a local machine.

## Authentication

The package is `@rate-sync/rate-sync`, in the npm organization `rate-sync` (the unscoped name
`rate-sync` is refused by npm as too similar to `ratesync`).

Preferred: npm **Trusted Publishing** (OIDC), no stored secret. On npmjs.com open the package
settings, section Trusted Publisher, choose GitHub Actions and enter owner `rate-sync`,
repository `typescript` and workflow file `publish.yml`. Leave the environment empty and leave the
`NPM_TOKEN` repository secret unset. npm only allows this once the package exists.

Done for this package: `0.2.1` was published with a short-lived token (deleted afterwards) and
Trusted Publishing is configured for `rate-sync/typescript`, workflow `publish.yml`, so releases
need no secret. If the configuration ever has to be recreated, it needs the security key of the npm
account owner.

## Release checklist

1. Move the `[Unreleased]` entries of `CHANGELOG.md` under a new `## [X.Y.Z] - date` heading and set
   `version` in `package.json` to `X.Y.Z`.
2. Verify locally:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run typecheck
   pnpm run build
   REDIS_URL=redis://localhost:6379 pnpm test   # without Redis the Redis store tests skip
   ```

3. Commit, tag and push:

   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: bump version to X.Y.Z"
   git push origin main
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

   The workflow checks that the tag equals `v` plus the `package.json` version, runs the tests
   against a real Redis, builds, publishes with `npm publish --provenance --access public` and
   creates the GitHub release.

4. Verify:

   ```bash
   npm view @rate-sync/rate-sync version
   npm view @rate-sync/rate-sync dist.tarball
   ```

   The package page on npmjs.com shows the provenance badge.

## Versioning

- Major (X.0.0): breaking changes
- Minor (0.X.0): new features, backward compatible (while the major is 0, a minor may carry
  small behaviour changes, documented in the changelog)
- Patch (0.0.X): bug fixes

## Rollback

`npm deprecate @rate-sync/rate-sync@X.Y.Z "reason"` (a published version cannot be replaced), then publish a
fixed patch release. `npm unpublish` is only possible in the first 72 hours.
