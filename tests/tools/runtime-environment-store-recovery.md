# Environment store recovery probe

This probe calls the production environment store and file permission code. It
uses fresh temporary directories and synthetic pairing data. It does not connect
to a server or read an existing Orca profile.

Build a standalone Node.js bundle from the repository root:

```sh
pnpm exec esbuild tests/tools/runtime-environment-store-recovery.ts --bundle --platform=node --format=cjs --target=node24 --outfile=tmp/environment-store-recovery.cjs
node tmp/environment-store-recovery.cjs
```

Copy the bundle to another host and run it with Node.js 24 or later to test that
host's filesystem and permission code. No repository dependencies are needed on
the target host.

The probe seeds a 640-byte NUL file, an empty file, and truncated JSON. For each
case, it verifies that adding a server preserves the original bytes in one backup
and writes a valid store that can be read again. It also checks an existing valid
store. The JSON report contains backup paths, lengths, and SHA-256 hashes. Keep
the temporary directories named in the report as evidence.

To verify bytes captured after a real power loss, pass `--fixture /path/to/store`.
The probe copies those bytes into a new temporary profile and verifies an exact
backup and successful save. It does not change the captured file.

For a bundle built with the store implementation before recovery was added, pass
`--expect-blocked`. The probe then requires all three corrupt inputs to block
saving and remain unchanged. A successful control run confirms the original
failure; it is not a successful recovery.

This is a deterministic recovery test. It does not test power-loss durability or
the rendered Settings screen. A power-loss comparison requires a disposable
virtual machine, completed-write records stored outside that machine, and raw
file inspection after each forced power-off, before recovery can change the
evidence. Report completed trial counts and damaged, missing, and intact files
for both writer versions. A run with no corruption in either version does not
reproduce the original durability failure.

See [the Hyper-V probe](runtime-environment-power-loss.md) for an automated
comparison that records completed writes on the host and retains raw results.
