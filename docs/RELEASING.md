# Release operations

This runbook defines how PuckBot produces signed desktop releases, validates automatic updates, recovers local state, and updates remote agent hosts. The ordinary Verify workflow produces unsigned development artifacts. Only the Signed release workflow creates distributable packages.

## Trust chain

A release is acceptable only when all of these records refer to the same version tag and commit:

1. `package.json` version and the immutable `v<version>` Git tag
2. A macOS Developer ID signature with hardened runtime entitlements
3. Apple notarization and stapled tickets on the application and DMG
4. A Windows Authenticode signature matching the configured publisher
5. `latest*.yml` or `beta*.yml` updater metadata with SHA-512 digests
6. Release `SHA256SUMS` manifests
7. GitHub build-provenance attestations for installers, updater metadata, and checksum manifests
8. A successful native package check for the bundled Codex runtime

Never publish an artifact copied from the Verify workflow as a release.

## GitHub environments and secrets

Create protected `beta-release` and `stable-release` environments. Require a reviewer for `stable-release`. Configure the following environment secrets without printing them in workflow logs:

| Secret | Platform | Purpose |
| --- | --- | --- |
| `MAC_CSC_LINK` | macOS | Base64 or secure URL for the Developer ID certificate bundle |
| `MAC_CSC_KEY_PASSWORD` | macOS | Certificate bundle password |
| `APPLE_API_KEY_BASE64` | macOS | Base64-encoded App Store Connect API key file |
| `APPLE_API_KEY_ID` | macOS | App Store Connect key identifier |
| `APPLE_API_ISSUER` | macOS | App Store Connect issuer identifier |
| `APPLE_TEAM_ID` | macOS | Apple developer team identifier |
| `WIN_CSC_LINK` | Windows | Base64 or secure URL for the Authenticode certificate bundle |
| `WIN_CSC_KEY_PASSWORD` | Windows | Certificate bundle password |
| `WIN_PUBLISHER_NAME` | Windows | Exact subject name accepted by updater signature verification |
| `STABLE_ROLLBACK_EVIDENCE` | Stable gate | Link or identifier for the most recent completed rollback drill |

Use a hardware-backed or managed signing service when available. Rotate an exposed key, revoke the affected certificate, remove the release, and publish a security notice. Do not work around `forceCodeSigning`.

## Prepare a release

1. Start from a clean `main` branch and run `npm ci` followed by `npm run verify`.
2. Confirm the version is a strict semantic version. Stable uses `x.y.z`; beta uses `x.y.z-beta.n`.
3. Review dependency advisories and document any accepted residual risk.
4. Run the manual multi-agent operator scenario and retain trace evidence.
5. Run `npm run smoke:remote-host` on the provisioned host and retain the harness ID and terminal trace. On the reference Linux image, run `GROKKY_CHROMIUM_PATH=<path> npm run smoke:linux-screens`.
6. Exercise the rollback drill below. Store its evidence identifier in the protected `stable-release` environment before a stable tag.
7. Commit the version and release notes.
8. Create and push an exact tag, such as `v1.4.0` or `v1.4.0-beta.2`.

The workflow refuses a tag that does not exactly match `package.json`.

## What release CI verifies

The native jobs install the locked dependencies and run the full source verification suite. `npm run release:mac` and `npm run release:win` require their signing environments and enable electron-builder's forced-signing gate.

The macOS job checks:

- Hardened signature validity for `PuckBot.app`
- Signature validity for the bundled Codex executable
- Gatekeeper assessment
- Stapled notarization tickets for the application and DMG
- Matching updater version, artifact path, and SHA-512 digest

The Windows job checks:

- Authenticode validity for the installer
- Authenticode validity for the bundled Codex executable
- Matching updater version, artifact path, and SHA-512 digest

Each job then writes SHA-256 manifests, creates GitHub provenance attestations, and uploads only the verified release files. The publish job downloads both platform sets, rechecks every SHA-256 digest, enforces rollback evidence for stable, and creates the GitHub Release with generated notes.

## Clean-machine install and update smoke

Before promoting beta to stable, exercise both operating systems on clean test accounts or clean virtual machines:

1. Install the previous stable release from its GitHub Release.
2. Create a disposable conversation, a queued task, an unsent composer draft, and a test workspace backup.
3. Select the candidate channel and check for updates.
4. Confirm release details open externally without changing the draft or active task context.
5. Start a local run and an integration, then download the update.
6. Confirm restart lists the active run and integration as blockers and does not quit.
7. Reach safe checkpoints, resolve approvals and integration state, and retry restart.
8. Confirm the operating system accepts the new signature without a warning exception.
9. Confirm the application opens, migrates the prior database, preserves the conversation and task state, and can run the packaged Codex runtime.
10. Confirm stable rejects a beta candidate, beta rejects unrelated prerelease labels, and neither channel accepts a downgrade.

Record the release tag, source commit, operating-system versions, installer digests, attestation verification, before and after database schema versions, and test results.

## Desktop rollback drill

Exercise this once before each stable release family and after any storage migration change:

1. Close PuckBot and protect a copy of the application data.
2. Install the candidate over the previous stable version and launch it once.
3. Verify `conversations.sqlite3.pre-migration-backup` exists and is private.
4. Simulate a startup failure using a disposable database copy, never a user's only database.
5. Confirm startup stops with the backup recovery path and does not create empty replacement state.
6. Reinstall the prior stable application.
7. With both applications closed, move the failed candidate database aside and restore the pre-migration backup to `conversations.sqlite3`.
8. Launch the prior stable version and confirm conversations, tasks, traces, teams, and workspace recovery references are present.
9. Record the evidence identifier in `STABLE_ROLLBACK_EVIDENCE`.

Do not delete a failed database. Preserve it for diagnosis until recovery has been verified.

## Emergency desktop rollback

If a release is unsafe:

1. Mark the GitHub Release as a draft or remove it from publication.
2. Do not reuse or move the affected tag.
3. Publish a new higher patch version because the updater refuses downgrades.
4. Restore from `conversations.sqlite3.pre-migration-backup` only with PuckBot closed.
5. If signing trust is affected, revoke and rotate the certificate before the replacement build.
6. Add the failure as a deterministic regression test and link the incident evidence in the new release.

## Remote agent-host updates

Desktop and host packages have separate lifecycles. The desktop updater must never replace a host binary or restart a host job.

A host deployment tool must call the host update coordinator in this order:

1. Stop accepting new jobs and let active jobs checkpoint or reach a terminal state.
2. Create a versioned backup of the host binary, spool, pairing credential, and configuration.
3. Install the candidate host package.
4. Start it and run an authenticated health check.
5. Negotiate the remote protocol.
6. Resume new jobs only when health is good and the protocol major is compatible.
7. Restore the backup on failed health or incompatible major protocol.

Compatible minor skew may keep operating and should be removed during the next maintenance window. Incompatible major skew blocks submission and control of new jobs, but export and recovery endpoints stay available so work is not trapped.

## Evidence checklist

- [ ] Exact version tag matches `package.json`
- [ ] Full verification suite passed on the tagged source
- [ ] macOS signature, Gatekeeper, notarization, and stapling checks passed
- [ ] Windows Authenticode checks passed
- [ ] Bundled Codex runtime passed on both native packages
- [ ] Updater metadata points to the matching version and release files
- [ ] SHA-256 manifests verified after artifact download
- [ ] GitHub provenance attestations are visible for every release subject
- [ ] Clean-machine install and update smoke passed on both platforms
- [ ] Restart blockers preserved active work and unsent context
- [ ] Database migration backup and recovery drill passed
- [ ] Host compatibility, health check, and rollback path passed when host code changed
- [ ] Manual multi-agent operator scenario produced trace evidence
