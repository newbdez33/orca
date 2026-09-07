# Environment store power-loss probe

The probe uses the production environment-store API and Windows permission code.
Each write creates a separate temporary profile with synthetic pairing data and
an exact 640-byte store by default. No filesystem calls are mocked. It does not
read an existing Orca profile or connect to a server.

The Hyper-V controller cuts power to a disposable VM while the writer runs. All
unsaved work in that VM can be lost. Select the VM by both name and ID. The host
keeps completion records and hashes outside the VM before each power-off. After
boot, the inspector reads raw bytes without calling the recovery API.

## Build the comparison

From the repository root, save the control store source and build both bundles:

```sh
mkdir -p tmp/environment-power-loss
git show e2b70a5eba68:src/shared/runtime-environment-store.ts > tmp/environment-power-loss/control-store.ts
node tests/tools/build-runtime-environment-power-loss.mjs tmp/environment-power-loss/control-store.ts tmp/environment-power-loss
```

The named revision is the store before durable writes were enabled. The builder
replaces only that module in the control bundle. Both variants use the current
probe and dependencies. `bundle-manifest.json` records source and bundle hashes.
On Windows, save the control source as UTF-8; Windows PowerShell 5.1 redirection
otherwise produces UTF-16.

## Run on Hyper-V

Stage `node.exe` from Node.js 24 or later and the two bundles in one directory in
the guest. Copy `runtime-environment-power-loss.ps1` to the Hyper-V host. Use an
existing `PSCredential` CLIXML file that the current host account can decrypt.
PowerShell Direct must accept the guest credential before the test starts.

Run from an elevated PowerShell session on the host. Replace the paths and VM ID:

```powershell
.\runtime-environment-power-loss.ps1 `
  -VmId '00000000-0000-0000-0000-000000000000' `
  -VmName 'disposable-test' `
  -CredentialPath 'C:\Test\guestcred.xml' `
  -GuestRoot 'C:\Test\environment-power-loss' `
  -Pairs 2 -PayloadBytes 640 -CompletedBeforeCut 8
```

Each pair tests both variants; later pairs reverse their order. The host waits
until the guest has been up for 90 seconds before starting a writer. It waits
for successful API returns, then uses `Stop-VM -TurnOff`, confirms `Off`, and boots
the VM. It preserves events, a manifest, raw inspection JSON, and a summary in a
unique directory beside the controller. It leaves the VM running. A write has
to return successfully before it counts in the durability comparison; in-flight
writes are recorded separately. The writer stops after 500 writes or 120 seconds
if it is not interrupted.

Use `-Writers before` or `-Writers after` to repeat one variant. If Windows enters
its recovery screen, the controller stops when PowerShell Direct times out.
Restore normal guest boot and inspect the saved manifest before counting that
trial or starting another one.

The inspector compares each acknowledged file with the expected length and hash
computed from the API result. Its report separates intact, missing, unreadable,
empty, NUL-filled, invalid-JSON, and changed-JSON files. Readable files include
their complete bytes as base64. Preserve these artifacts before testing recovery.

## Dry run and recovery

This writer command limits a local run to four writes:

```sh
node tmp/environment-power-loss/power-loss-after.cjs write 640 4
```

To inspect, save those JSON lines in a manifest with `root` from the `ready`
event and an `events` array, then pass it to `power-loss-after.cjs inspect`.
To verify backup and subsequent saves using a captured corrupt file, run the
[recovery probe](runtime-environment-store-recovery.md) with `--fixture`.

## Scope

This test covers the first save into a fresh profile on the selected guest
filesystem. It does not exercise the rendered Settings screen, overwrite
durability in an existing profile, or loss of power to the physical Hyper-V host.
Report file counts for each variant and each payload size. A run with no damage
in either variant does not reproduce the original failure. A passing fixed run
is evidence for this experiment, not a guarantee for every storage device or
failure point.
