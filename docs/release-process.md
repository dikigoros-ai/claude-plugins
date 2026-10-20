# Release process

How a version of the `dikigoros` plugin is released. Claude installs it from the marketplace at the repository root
(`.claude-plugin/marketplace.json`), whose one entry points at `plugins/dikigoros/`: what is committed there,
the generated bundle included, is what installed clients run.

## 1. Bump the version

Set the new version, the same in three places:

- `plugins/dikigoros/.claude-plugin/plugin.json`: `version`. The build writes it into the bundle as the server's
  version, so it changes before the build.
- `.claude-plugin/marketplace.json`: the `dikigoros` entry's `version`.
- `package.json`: `version`.

`test/plugin-manifest.test.ts` fails when the three differ. The same marketplace file also carries
`metadata.version`, the marketplace's own version; whether it moves with every plugin release is not settled (it is
`0.1.0`, like the plugin, and no test reads it).

Add the version's entry to `CHANGELOG.md`.

The production Auth0 application's client id lives in `src/config.ts` (`DEFAULT_AUTH0_CLIENT_ID`), not in the plugin
manifest: a manifest `env` would override the environment Claude starts the helper with. The first release lawyers
install sets it there; the build carries it into the bundle.

## 2. The native packages, only when their version changes

`@napi-rs/canvas` and `@napi-rs/keyring` are not bundled: the helper installs them on first use, from the tarballs
pinned in `src/native/lock.generated.json`. To move to another version of either, change it in `scripts/pin-native.ts`
(`VERSIONS`) and in `package.json`'s `devDependencies` (then `npm install`), so that the tests run the version the
lock pins, then run:

```
npm run pin-native
```

It needs the network: it asks registry.npmjs.org (`npm view`) for the tarball URL and the sha512 integrity of each
package and of its six platform packages, and rewrites the lock. Commit the new lock. Its hash names the install
directory, so installed helpers download the new packages at their first tool call after the update. Without a
native version change, skip this step: the lock stays as it is.

## 3. Build and check

```
npm run build
npm run check
claude plugin validate ./plugins/dikigoros
claude plugin validate .
```

`npm run build` regenerates `plugins/dikigoros/server/`: the bundle, its licence notices (the licence comments
esbuild keeps, and `THIRD_PARTY_NOTICES.md`: pdf.js's own notice and the licence of every package the bundle holds
code of), and pdf.js's worker, wasm decoders and standard fonts. The same inputs give the same bytes. `npm run check`
runs lint, the typecheck and the tests; the smoke test starts the bundle just built.

## 4. Commit and tag

Commit the version bump together with the regenerated `plugins/` output and the changelog: every file the build
changed or added, as the CI guard below fails on either. Release commits are signed (the repository requires it).
Tag the release commit `v<version>`, for example `v0.1.0`.

## 5. CI

`.github/workflows/ci.yml` runs on every push and pull request, with read access to the repository only and its
actions pinned to commits: `npm ci`, lint, typecheck, `npm run build`, the tests, then `git status --porcelain --
plugins/`, which must print nothing. That last step is the guard: it fails when the committed `plugins/` output
differs from a fresh build or misses a file the build made, so a change to `src/` committed without its bundle cannot
pass, and neither can a hand edit of the bundle.

## 6. How installed clients update

Installed clients pick up a new version when the marketplace entry's `version` changes: that entry is what tells them
to update, so it moves with every release (step 1).
