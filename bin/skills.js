#!/usr/bin/env node
'use strict'

const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')

const REPO = { owner: 'aldirrss', name: 'dev-skills', branch: 'main' }
const SKILLS_ROOT = 'skills'
const DEFAULT_INSTALL_DIR = path.join(os.homedir(), '.claude', 'skills')

// ── ANSI colors (disabled when not TTY) ───────────────────────────────────────
const t = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', blue: '\x1b[34m', yellow: '\x1b[33m',
  red: '\x1b[31m', gray: '\x1b[90m', cyan: '\x1b[36m',
}
const col = (str, ...codes) =>
  process.stdout.isTTY ? codes.join('') + str + t.reset : str
const err = (str, ...codes) =>
  process.stderr.isTTY ? codes.join('') + str + t.reset : str

// ── HTTP request (follows redirects, optional GITHUB_TOKEN) ───────────────────
function request(url) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': '@aldirrss/skills' }
    if (process.env.GITHUB_TOKEN)
      headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`

    https.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return request(res.headers.location).then(resolve).catch(reject)

      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        if (res.statusCode === 403 && res.headers['x-ratelimit-remaining'] === '0')
          reject(new Error(
            'GitHub API rate limit exceeded. Set the GITHUB_TOKEN env var to increase limits.'
          ))
        else if (res.statusCode >= 400)
          reject(new Error(`HTTP ${res.statusCode} → ${url}`))
        else
          resolve(Buffer.concat(chunks))
      })
    }).on('error', reject)
  })
}

// ── Fetch the full repo file tree ─────────────────────────────────────────────
async function fetchTree() {
  const url =
    `https://api.github.com/repos/${REPO.owner}/${REPO.name}/git/trees/${REPO.branch}?recursive=1`
  const buf = await request(url)
  const data = JSON.parse(buf.toString())
  if (data.truncated)
    process.stderr.write(err('⚠  repo tree was truncated\n', t.yellow))
  return data.tree || []
}

// ── Build skill map: { 'odoo-18': { category: 'odoo', files: [...] }, ... } ──
function buildSkillMap(tree) {
  const map = {}
  for (const item of tree) {
    if (item.type !== 'blob') continue
    const parts = item.path.split('/')
    // expects: skills/<category>/<skill-name>/<...localPath>
    if (parts[0] !== SKILLS_ROOT || parts.length < 4) continue
    const [, category, name, ...rest] = parts
    if (!map[name]) map[name] = { category, files: [] }
    map[name].files.push({ repoPath: item.path, localPath: rest.join('/') })
  }
  return map
}

function groupByCategory(skillMap) {
  const cats = {}
  for (const [name, { category }] of Object.entries(skillMap))
    (cats[category] = cats[category] || []).push(name)
  return cats
}

// ── Download and write one skill folder to destDir ───────────────────────────
async function installSkill(name, info, destDir) {
  const skillDir = path.join(destDir, name)
  const exists = fs.existsSync(skillDir)

  process.stdout.write(
    col(`  ${exists ? '↻' : '+'}`, exists ? t.yellow : t.green) +
    ` ${col(name, t.cyan)}\n`
  )

  fs.mkdirSync(skillDir, { recursive: true })

  for (const { repoPath, localPath } of info.files) {
    const rawUrl =
      `https://raw.githubusercontent.com/${REPO.owner}/${REPO.name}/${REPO.branch}/${repoPath}`
    const content = await request(rawUrl)
    const dest = path.join(skillDir, localPath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, content)
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
async function cmdList(args, skillMap) {
  const cats = groupByCategory(skillMap)
  const filter = args.find(a => !a.startsWith('-'))

  if (filter && !cats[filter]) {
    process.stderr.write(
      err(`Category "${filter}" not found.\n`, t.red) +
      `Available: ${Object.keys(cats).sort().join(', ')}\n`
    )
    process.exit(1)
  }

  const view = filter ? { [filter]: cats[filter] } : cats
  const installedDir = DEFAULT_INSTALL_DIR

  console.log()
  for (const [cat, names] of Object.entries(view)) {
    console.log(col(`  ${cat}/`, t.bold + t.blue))
    for (const name of names.sort()) {
      const installed = fs.existsSync(path.join(installedDir, name))
      const marker = installed ? col(' ✓', t.green) : ''
      console.log(`    ${col(name, t.cyan)}${marker}`)
    }
  }

  const total = Object.values(view).reduce((s, a) => s + a.length, 0)
  const catCount = Object.keys(view).length
  console.log()
  console.log(col(
    `  ${total} skill(s) across ${catCount} categor${catCount === 1 ? 'y' : 'ies'}  ` +
    `(${col('✓', t.green + t.reset + t.gray)} = installed)`,
    t.gray
  ))
  console.log()
}

async function cmdAdd(args, skillMap, destDir) {
  const cats = groupByCategory(skillMap)
  const installAll = args.includes('--all')
  const target = args.find(a => !a.startsWith('-'))

  let names
  if (installAll) {
    names = Object.keys(skillMap)
  } else if (!target) {
    process.stderr.write(err('Usage: skills add <skill-name|category> [--all]\n', t.red))
    process.exit(1)
  } else if (skillMap[target]) {
    names = [target]
  } else if (cats[target]) {
    names = cats[target]
  } else {
    process.stderr.write(
      err(`"${target}" is not a known skill or category.\n`, t.red) +
      `Run ${col('npx @aldirrss/skills list', t.cyan)} to see available skills.\n`
    )
    process.exit(1)
  }

  console.log()
  console.log(col(`Installing ${names.length} skill(s) → ${destDir}`, t.bold))
  console.log()

  fs.mkdirSync(destDir, { recursive: true })
  for (const name of names)
    await installSkill(name, skillMap[name], destDir)

  console.log()
  console.log(col(`✓ Done — ${names.length} skill(s) installed`, t.bold + t.green))
  console.log()
}

async function cmdRemove(args, destDir) {
  const name = args[0]
  if (!name) {
    process.stderr.write(err('Usage: skills remove <skill-name>\n', t.red))
    process.exit(1)
  }
  const skillDir = path.join(destDir, name)
  if (!fs.existsSync(skillDir)) {
    process.stderr.write(
      err(`"${name}" is not installed at ${destDir}\n`, t.red)
    )
    process.exit(1)
  }
  fs.rmSync(skillDir, { recursive: true, force: true })
  console.log(col(`✓ Removed ${name}`, t.green))
}

async function cmdInfo(args, skillMap) {
  const name = args[0]
  if (!name) {
    process.stderr.write(err('Usage: skills info <skill-name>\n', t.red))
    process.exit(1)
  }
  if (!skillMap[name]) {
    process.stderr.write(
      err(`Skill "${name}" not found.\n`, t.red) +
      `Run ${col('npx @aldirrss/skills list', t.cyan)} to see available skills.\n`
    )
    process.exit(1)
  }
  const skillFile = skillMap[name].files.find(f => f.localPath === 'SKILL.md')
  if (!skillFile) { process.stderr.write('SKILL.md not found in repo\n'); process.exit(1) }

  const raw = await request(
    `https://raw.githubusercontent.com/${REPO.owner}/${REPO.name}/${REPO.branch}/${skillFile.repoPath}`
  )
  process.stdout.write(raw)
  process.stdout.write('\n')
}

// ── Help ──────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
${col('skills', t.bold + t.cyan)} — Claude Code skill manager for aldirrss/dev-skills

${col('Usage:', t.bold)}
  npx @aldirrss/skills <command> [options]

${col('Commands:', t.bold)}
  ${col('list', t.green)} [category]           List available skills (${col('✓', t.green)} = installed)
  ${col('add', t.green)} <skill|category>      Install to ~/.claude/skills/
  ${col('add', t.green)} --all                 Install all skills
  ${col('remove', t.green)} <skill>            Uninstall a skill
  ${col('info', t.green)} <skill>              Print SKILL.md content

${col('Options:', t.bold)}
  ${col('--target <dir>', t.yellow)}            Override install directory
  ${col('--help', t.yellow)}                    Show this help

${col('Examples:', t.bold)}
  npx @aldirrss/skills list
  npx @aldirrss/skills list odoo
  npx @aldirrss/skills add odoo-18
  npx @aldirrss/skills add odoo
  npx @aldirrss/skills add --all
  npx @aldirrss/skills add odoo-18 --target .claude/skills
  npx @aldirrss/skills remove odoo-16
  npx @aldirrss/skills info odoo-18

${col('Tip:', t.bold)} Set ${col('GITHUB_TOKEN', t.yellow)} env var to avoid API rate limits.
`)
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2)

  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    return
  }

  // strip --target <value> from args
  const tIdx = argv.indexOf('--target')
  const destDir = tIdx !== -1 ? path.resolve(argv[tIdx + 1]) : DEFAULT_INSTALL_DIR
  const cleanArgs = argv.filter((_, i) => i !== tIdx && i !== tIdx + 1)

  const [cmd, ...cmdArgs] = cleanArgs

  const needsTree = new Set(['list', 'add', 'info'])
  let skillMap = {}

  if (needsTree.has(cmd)) {
    process.stderr.write(col('Fetching skill catalog…\n', t.gray))
    skillMap = buildSkillMap(await fetchTree())
  }

  switch (cmd) {
    case 'list':   return cmdList(cmdArgs, skillMap)
    case 'add':    return cmdAdd(cmdArgs, skillMap, destDir)
    case 'remove': return cmdRemove(cmdArgs, destDir)
    case 'info':   return cmdInfo(cmdArgs, skillMap)
    default:
      process.stderr.write(err(`Unknown command: ${cmd}\n`, t.red))
      printHelp()
      process.exit(1)
  }
}

main().catch(e => {
  process.stderr.write(err(`\nError: ${e.message}\n`, t.red))
  process.exit(1)
})
