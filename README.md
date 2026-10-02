# setup-kotlin-toolchain

GitHub Action for **JetBrains Kotlin Toolchain** (formerly Amper). Installs a
versioned, checksum-verified CLI wrapper on Linux, macOS, and Windows; optionally
caches distributions, dependencies, and provisioned JDKs.

## Usage

Use a release commit SHA for immutable references, or `v1` for compatible updates.

```yaml
permissions:
  contents: read
steps:
  - uses: actions/checkout@v7
  - uses: Heapy/setup-kotlin-toolchain@v1
    with:
      version: auto
  - run: kotlin build
  - run: kotlin test
```

Check out your sources before setup. `auto` reads `kotlin` and/or `kotlin.bat` from
`working-directory` without executing them. If both exist, their versions and
distribution checksums must agree. Without wrappers it installs **0.13.0**.
An explicit version overrides the project pin for subsequent CLI invocations.
Versions before 0.12 are unsupported.

| Input | Default | Purpose |
|---|---|---|
| `version` | `auto` | Exact toolchain version, or project-wrapper detection |
| `working-directory` | `.` | Project directory relative to workspace |
| `cache` | `true` | Cache distributions, dependencies, and JDKs |
| `cache-key-suffix` | empty | Manually invalidate a cache namespace |
| `cache-read-only` | `auto` | Restore only unless the event is push, workflow_dispatch, or schedule |
| `wrapper-sha256` | empty | Trusted SHA-256 of the OS-specific wrapper |
| `verify` | `true` | Provision the CLI and run `kotlin --version` during setup |

Outputs: `version`, `bin-path`, and `cache-hit` (empty when caching is disabled).
With `verify: false`, distribution provisioning is deferred until the first CLI call.

## Behavior and security

The action downloads the versioned wrapper directly from JetBrains' Maven
repository, verifies its SHA-256, and checks its embedded distribution pin against
the project wrapper when using `auto`. The official wrapper verifies downloaded
CLI distributions on initial download. Restored extracted files are trusted cache
contents, not rehashed by this action. By default wrapper checksums come from the same upstream
repository: this detects corruption, but is not independent authentication. Supply
`wrapper-sha256` from a trusted source for stronger pinning; it differs by OS.

No remote installer is piped into a shell. Installation uses a private directory
under `RUNNER_TEMP`, prepended to `PATH`, without changing shell profiles. Inputs
are passed through environment variables, validated, and never evaluated as code.
Requires Node.js 22+ and Bash on the runner (provided by current GitHub-hosted
runners; Windows uses Git Bash for action steps and a small Node launcher for the native `.bat` wrapper).

`KOTLIN_CLI_BOOTSTRAP_CACHE_DIR` and `KOTLIN_SHARED_CACHE_DIR` are set to dedicated
runner-temporary directories. The selected version is enforced through
`KOTLIN_CLI_WRAPPER_ALWAYS_USE_INTRINSIC_VERSION` for the rest of the job; run setup
again to change versions. Existing custom cache-directory environment settings
are replaced. Cache keys include OS, architecture, CLI version, configuration
hash, distribution checksum, and your optional suffix (up to 64 letters, digits,
dots, underscores, or hyphens). Restores stay within the same version and suffix.
Only download/tool caches are stored, not project build outputs. Do not store
secrets in these caches. Set `cache: false` if caching is inappropriate.

### Feature branches and forks

Keys deliberately do not contain branch names or commit IDs. GitHub scopes caches
to branches and searches the current, PR base, and default branches as allowed by
its [cache access rules](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
This lets feature branches reuse the default branch's downloads even after their
dependency configuration changes: the fallback prefix excludes only the configuration
hash. The CLI still resolves any missing dependencies after restoration.

With `cache-read-only: auto`, all PRs (including forks) restore only; trusted
pushes, manual runs, and scheduled jobs save after successful completion. A
feature-branch push can create its own branch-scoped cache. Fork PRs running in the
parent repository can read eligible base/default caches, but cannot write through
this action by default. Pushes in a fork's own repository use that repository's
caches; GitHub does not share them with the parent repository. A cold or inaccessible
cache falls back to normal downloads. Repository approval requirements for fork
workflows still apply.

Set `cache-read-only: true` to force restore-only behavior, or `false` to allow
saving where GitHub's cache token permits it. GitHub's job-level `cache-mode`
remains authoritative. Keep a successful default-branch build to warm shared caches.
Do not use `pull_request_target` to execute untrusted fork code.

These caches cover the two Kotlin Toolchain cache roots. Separate Kotlin/Native
`~/.konan` caches are not included.

The nested cache action is pinned by SHA and updated through Dependabot.
The action does not require repository write permissions or a GitHub token input.

## Development

```sh
npm test
npm run check
```

There are no npm runtime dependencies or generated bundles. `action.yml` calls
`scripts/setup.mjs` directly. CI tests inputs on all three operating systems and
uses the action itself to build, test, and package an official JVM fixture.
Validate workflows locally with `actionlint .github/workflows/ci.yaml`.
Trusted CI runs also test a real save/restore round trip across two fresh jobs.
PR CI tests restore-only use without requiring cache-write access.

Before release, require green CI, review changes, create a versioned release, and
update the corresponding major tag deliberately. Prefer immutable releases and
SHA references for consumers. Update the fallback version and fixture wrappers
together when adopting a new Kotlin Toolchain release.

Kotlin Toolchain is alpha: see the
[upstream release notes](https://github.com/JetBrains/kotlin-toolchain/releases).

## Related actions

- [update-kotlin-toolchain](https://github.com/Heapy/update-kotlin-toolchain)
- [kotlin-toolchain-check](https://github.com/Heapy/kotlin-toolchain-check)
- [kotlin-toolchain-publish](https://github.com/Heapy/kotlin-toolchain-publish)

The Windows launcher prioritizes native system utilities and filters incompatible
Git/Strawberry Perl shims only in the toolchain child process. The runner-wide
PATH receives only the action installation directory.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party
components retain their original licenses.
