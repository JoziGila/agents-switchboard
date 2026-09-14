import fs from 'node:fs';
export async function logs(opts) {
  const { resolvePaths } = await import('../paths.js');
  const file = resolvePaths().logFile;
  if (!fs.existsSync(file)) { process.stderr.write(`no log yet at ${file}\n`); return 1; }
  const n = Number(opts.n ?? 50);
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  process.stdout.write(lines.slice(-n).join('\n') + '\n');
  return 0;
}
