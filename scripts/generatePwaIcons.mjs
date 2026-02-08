import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const projectRoot = process.cwd()
const publicDir = path.join(projectRoot, 'public')
const srcSvg = path.join(publicDir, 'favicon.svg')
const outDir = path.join(publicDir, 'icons')

if (!fs.existsSync(srcSvg)) {
  console.error(`[generatePwaIcons] Missing source icon: ${srcSvg}`)
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })

const targets = [
  { size: 192, file: 'icon-192.png' },
  { size: 512, file: 'icon-512.png' },
]

for (const { size, file } of targets) {
  const outPath = path.join(outDir, file)
  // Render SVG to PNG at target size.
  // transparent background keeps neon look nicer on most launchers.
  await sharp(srcSvg, { density: 512 })
    .resize(size, size)
    .png()
    .toFile(outPath)

  const stats = fs.statSync(outPath)
  if (!stats.size) {
    console.error(`[generatePwaIcons] Failed to write: ${outPath}`)
    process.exit(1)
  }
}

console.log('[generatePwaIcons] OK')
