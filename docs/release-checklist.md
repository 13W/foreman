# Release checklist

Run through this before tagging a new release.

## Code state

1. **All tests pass on CI.** Verify the latest master build is green at https://github.com/13W/foreman/actions.
2. **No `TODO(release)` or `FIXME(release)` markers in code.** Search: `grep -rn "TODO(release)\|FIXME(release)" packages/`. Empty result expected.
3. **No console.log or console.error in production code paths** (test files exempt). Search and confirm.
4. **No skipped tests** unless documented with rationale linked to a follow-up issue.
5. **Build is reproducible from a clean checkout.** Verify: `git clone … && cd … && pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test`.

## Documentation

6. **README, getting-started, configuration, architecture, troubleshooting are all current** with the version being released. Especially configuration reference must list every config field actually present in the schemas.
7. **CHANGELOG.md has an entry for this version**, with date, and follows Keep a Changelog format.

## License and metadata

8. **LICENSE present and unmodified Apache 2.0 text.**
9. **All published `package.json` files have `version`, `description`, `license: "Apache-2.0"`, `repository`, `homepage`, `bugs`.**
10. **Internal packages marked `"private": true`** (currently: integration-tests).

## Tagging

11. **Tag name follows `vMAJOR.MINOR.PATCH`** matching `package.json` versions.
12. **Tag annotated** with `git tag -a vX.Y.Z -m "Release X.Y.Z"`, message references the CHANGELOG entry.
13. **Push the tag** to trigger the release workflow: `git push origin vX.Y.Z`.

## Post-release

14. **Verify release workflow ran green** on GitHub Actions.
15. **Manually create a GitHub Release** from the tag, paste CHANGELOG entry as release notes.
