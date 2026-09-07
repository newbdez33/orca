import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const [controlPath, outputPath] = process.argv.slice(2)
if (!controlPath || !outputPath) {
  throw new Error(
    'Usage: node build-runtime-environment-power-loss.mjs control-store.ts output-dir'
  )
}
const storePath = resolve(import.meta.dirname, '../../src/shared/runtime-environment-store.ts')
const outputDirectory = resolve(outputPath)
mkdirSync(outputDirectory, { recursive: true })
const manifest = {}
for (const variant of ['before', 'after']) {
  const source = readFileSync(variant === 'before' ? controlPath : storePath, 'utf8')
  const outfile = resolve(outputDirectory, `power-loss-${variant}.cjs`)
  await build({
    entryPoints: [resolve(import.meta.dirname, 'runtime-environment-power-loss.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    plugins: [
      {
        name: 'store-version',
        setup(build) {
          build.onLoad({ filter: /[\\/]runtime-environment-store\.ts$/ }, () => ({
            contents: source,
            resolveDir: dirname(storePath),
            loader: 'ts'
          }))
        }
      }
    ]
  })
  manifest[variant] = {
    storeSha256: createHash('sha256').update(source).digest('hex'),
    bundleSha256: createHash('sha256').update(readFileSync(outfile)).digest('hex')
  }
}
writeFileSync(resolve(outputDirectory, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify(manifest))
