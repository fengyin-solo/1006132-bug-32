/* 出厂口径自检的启动器：用 esbuild 的 JS API 打包 scripts/ 下的自检文件再执行。
   走 JS API 是因为它会按当前平台挑二进制，直接调 .bin/esbuild 可能拿到别的平台的。 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const checks = ['verify-segment-release', 'verify-release-rollback']
const outdir = mkdtempSync(join(tmpdir(), 'segment-release-verify-'))

let failed = 0
for (const name of checks) {
  const entry = new URL(`./${name}.ts`, import.meta.url).pathname
  const outfile = join(outdir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@': new URL('../src', import.meta.url).pathname },
    outfile,
    logLevel: 'silent',
  })
  console.log(`\n== ${name} ==`)
  try {
    await import(pathToFileURL(outfile).href)
  } catch (error) {
    failed += 1
    console.error(error)
  }
}
process.exit(failed === 0 ? 0 : 1)
