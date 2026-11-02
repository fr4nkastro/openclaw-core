---
doc-schema-version: 1
summary: "Build fork hotfix tarballs on GitHub without publishing to npm or deploying"
title: "Fork hotfix release build"
read_when:
  - Building a hotfix artifact for the fr4nkastro fork
---

# Fork hotfix release build

`.github/workflows/fork-hotfix-release.yml` runs only in
`fr4nkastro/openclaw-core`, on GitHub-hosted `ubuntu-24.04` runners with a
180-minute job limit. It does not use self-hosted runners, production state,
repository secrets, npm credentials, deployment environments, or npm publication.
Only the separate release-asset job receives a temporary `contents: write` token;
it never checks out or executes package code. Build checkout credentials are not
persisted.

## Run

After review, put the workflow on the fork's default branch so manual dispatch is
available. The released commit must also contain this workflow to handle its
release event. Nothing is committed, pushed, dispatched, or released merely by
adding these files locally.

For an artifact-only trial, open **Actions → Fork hotfix release build → Run
workflow** and set `ref` to the exact reviewed fork commit SHA. A branch or tag
also works; provenance records the resolved SHA rather than claiming the moving
name is immutable. From the CLI:

```bash
gh workflow run fork-hotfix-release.yml --repo fr4nkastro/openclaw-core \
  --ref main -f ref=REVIEWED_FULL_COMMIT_SHA
```

Replace `main` with the fork's default branch if different. Manual runs never
upload release assets. Publishing a GitHub release (including a prerelease)
automatically builds its event SHA and attaches assets only after validation.
Use a tag exactly matching `v` plus `package.json`'s version, for example
`v2026.10.10-99`. The uploader verifies the release ID and that the tag still
resolves to the built SHA. Do not move release tags or reuse a version for changed
bytes. Prefer a prerelease until representative canary evidence is accepted.

## Package contract

The workflow pins Node `24.22.2`, enables Corepack, and uses the checkout's full
`packageManager` pin (currently pnpm `12.15.0`, including its integrity hash).
Installation uses `pnpm install --frozen-lockfile`. `pnpm build:package` runs with
`NODE_OPTIONS=--max-old-space-size=6144`, full declaration emission, and no build
cache. The package profile includes the Control UI and build metadata.

### Same-SHA Slack cohort (fork issue #1)

The build selects `OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS=slack`, so the
unified host compiler emits the external Slack runtime from the same checkout.
After build, `scripts/fork-slack-cohort.mjs stage <root> <full-source-sha>`
requires `dist/build-info.json.commit` to match that SHA and calls the existing
`stampDesktopRuntimePlugins` owner to record
`stagedOfficialPlugins: { commit, pluginIds: ["slack"] }`. Despite that historical
field name, this is **bundled distribution provenance**, not registry trust.
The fork deliberately uses explicit composition even for a tagged private build;
it does not use the desktop release planner, which excludes published plugins.

Canonical `--bundle-plugin slack` composition then includes Slack files and
runtime dependencies, sets the built package's `openclaw.build.bundledDist` to
true, and regenerates the dist inventory so installation does not prune it.
Neither marking a raw source plugin as official nor installing a separate npm
tarball establishes this contract. No heartbeat compatibility shim is supplied.
Explicit source composition accepts a private prerelease host inside Slack's
declared API range (`2026.10.10-102` versus `>=2026.10.9`); otherwise default
semver prerelease exclusion rejects this fork before packing. This packaging-only
host-peer check retains range bounds and leaves third-party peers strict. It
changes no plugin discovery, registry trust, or migration authorization checks.

`src/plugins/dev-source-root.ts` gives this commit-matched staged bundle source
priority over a tracked global npm generation. An absent/mismatched SHA receives
no such priority; explicit `plugins.load.paths` overrides remain intentional
overrides and must be audited before deployment. Regression tests exercise the
real manifest-registry builder with a retained `@openclaw/slack@2026.10.9`
candidate, check the selected root and bundled trust, and preserve routing/config
and install records. They do not modify production or execute migrations.

Packing uses the existing canonical owner:

```bash
node scripts/package-openclaw-for-docker.mjs \
  --skip-build --pnpm-pack --allow-unreleased-changelog \
  --bundle-plugin slack \
  --output-dir "$RUNNER_TEMP/fork-pack"
```

This is deliberately not a bare `pnpm pack`: `scripts/openclaw-prepack.ts`
rejects plain source packing with `@openclaw/ai: workspace:*`, because pnpm would
rewrite the dependency without bundling it. The canonical helper prepares the
docs map, changelog, package manifest, worker bundle, and dist inventory, bundles
the workspace AI runtime, invokes **pnpm pack**, normalizes missing bundle links
when needed, restores source mutations, and runs the package-tarball checker
with `--require-bundled-workspace-deps`. It internally disables automatic pack
scripts because it explicitly owns those lifecycle operations, unlike a bare
`npm pack --ignore-scripts` that skips preparation entirely. The workflow also
runs the built bundled-channel entry smoke used by prepack.

`--allow-unreleased-changelog` explicitly permits this fork's package version
without an upstream release changelog section. It does not bypass archive,
dependency, version, or CLI checks. Do not set `OPENCLAW_PREPACK_PREPARED=1` as a
shortcut around the workspace dependency guard.

## Evidence and handoff

Successful validation checks the exact archive filename, embedded package
name/version, prepared UI/docs/worker files, bundled AI manifest, and absence of
workspace runtime dependency specs. It installs the tgz with normal npm install
scripts into an isolated temporary global prefix and runs `openclaw --version`
and `--help` with isolated home, config, state, and cache paths. No Gateway is
started and no production configuration is copied.

Archive checks also require matching core/staged Slack SHAs, Slack distribution
ownership, and `dist/extensions/slack/runtime-api.js`. On the isolated installed
artifact, the cohort smoke imports both Slack's entry and **runtime-api** (the
monitor/provider graph that a lazy entry-only smoke misses) on plain Node. It
does not call `monitorSlackProvider`, start Socket Mode, or send a message.
`plugins list --json` must independently discover exactly one Slack, with bundled
origin and the installed artifact's root. Real representative-state migration
authority, retained-generation convergence, connected-channel startup and delivery
remain separate canary/deployment gates; a clean-home import is not those gates.

Every run attempts to retain a 30-day Actions artifact named
`fork-hotfix-RUN_ID-RUN_ATTEMPT`, including available build/install/pack logs.
A setup failure before evidence exists can leave no artifact. Failed build or
smoke evidence is diagnostic, not a qualified package. Successful evidence adds:

- `openclaw-VERSION.tgz`, copied into the artifact only after CLI smoke passes.
- `SHA256SUMS`, covering the tgz, provenance, source-SHA receipt, and Slack receipt.
- `provenance.json`, recording exact source SHA, requested ref, workflow identity,
  run ID/attempt/URL, package version, toolchain, tarball hash, and validation status.
- `SOURCE_SHA.txt`, containing the full source commit SHA.
- `slack-cohort.json`, recording the matching SHA, bundled relative path, runtime
  import result, and explicitly false official registry provenance. The enclosing
  `provenance.json.slack_cohort` additionally records installed discovery success;
  `plugins-list.json` is retained as diagnostic evidence in the Actions artifact.

Release runs upload only these five deliverables, not diagnostic logs, then
download the assets and verify the checksum manifest and bytes. Provenance is a
plain build receipt, **not** a signed GitHub/SLSA attestation. No OIDC permission
is requested. Existing assets are never silently overwritten: upload omits
`--clobber`, so collisions or partial prior uploads require operator review.

Download a successful run or release, inspect provenance, and run
`sha256sum --check SHA256SUMS` before canary installation. Registry dependencies
can still be downloaded during npm install; the tgz is not a fully offline
bundle of every third-party dependency. A CLI smoke pass is not proof of lease
stability or production readiness. Keep production deployment manual and blocked
until the representative isolated canary passes for the **same tgz checksum and
source SHA**. A previous failed canary is not superseded by a green build alone.
