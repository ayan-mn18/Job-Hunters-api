import { cp, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Site skills keep their playbook in a SKILL.md next to the code that uses it,
 * because it is prose meant to be edited as prose. `tsc` only emits
 * JavaScript, so without this step the compiled build has skills whose
 * `playbook()` throws ENOENT — and it throws at apply time, on a real
 * application, rather than at build time.
 */

const source = path.resolve('src/skills')
const target = path.resolve('dist/skills')

const entries = await readdir(source, { withFileTypes: true, recursive: true })
let copied = 0

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.md')) continue
  const from = path.join(entry.parentPath ?? entry.path, entry.name)
  const to = path.join(target, path.relative(source, from))
  await mkdir(path.dirname(to), { recursive: true })
  await cp(from, to)
  copied += 1
}

console.log(`copied ${copied} skill playbook${copied === 1 ? '' : 's'} to dist/skills`)
