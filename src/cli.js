import { createServer } from './server.js';

const HELP = `agents-switchboard — subagents on DeepSeek Flash for Codex and Claude Code

usage: switchboard <command> [options]

  install [--codex] [--claude] [--port N] [--pro]   configure detected clients, store the key, start the service
  uninstall [--purge]                               restore clients from backup, remove the service
  serve [--port N]                                  run the router in the foreground
  doctor                                            check service, config, auth, upstreams, versions
  test                                              spawn a real subagent on each client and prove the route
  status                                            routes, failover state, tokens, cache hit ratio, spend
  logs [-n N]                                       tail the request log
  roles [--pro] [--reset]                           rewrite role files
  failover on|off|reset                             control quota failover
`;

export async function run(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  switch (cmd) {
    case 'serve': return serve(opts);
    case 'status': return (await import('./commands/status.js')).status(opts);
    case 'logs': return (await import('./commands/logs.js')).logs(opts);
    case 'install': return (await import('./commands/install.js')).install(opts);
    case 'uninstall': return (await import('./commands/install.js')).uninstall(opts);
    case 'doctor': return (await import('./commands/doctor.js')).doctor(opts);
    case 'test': return (await import('./commands/test.js')).testCommand(opts);
    case 'roles': return (await import('./commands/roles.js')).roles(opts);
    case 'failover': return (await import('./commands/failover.js')).failover(opts);
    case undefined: case 'help': case '--help': case '-h': process.stdout.write(HELP); return 0;
    case '--version': case 'version': { const { readFileSync } = await import('node:fs'); process.stdout.write(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version + '\n'); return 0; }
    default: process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`); return 2;
  }
}

export function parseArgs(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = args[i + 1]; if (v !== undefined && !v.startsWith('-')) { o[k] = v; i++; } else o[k] = true; }
    else if (a.startsWith('-') && a.length === 2) { o[a.slice(1)] = args[++i]; }
    else o._.push(a);
  }
  return o;
}

async function serve(opts) {
  const { loadConfig, resolveDeepSeekKey, listenAddress } = await import('./config.js');
  const { resolvePaths } = await import('./paths.js');
  const paths = resolvePaths();
  const config = loadConfig(paths);
  if (opts.port) config.listen = `127.0.0.1:${opts.port}`;
  const { host, port } = listenAddress(config);
  if (host !== '127.0.0.1' && host !== 'localhost' && !opts['allow-remote']) throw new Error(`refusing to listen on ${host} without --allow-remote`);
  let cachedKey = null;
  const deepseekKey = async () => (cachedKey ??= await resolveDeepSeekKey(config));
  const log = (line) => process.stderr.write(`[switchboard] ${new Date().toISOString()} ${line}\n`);
  const server = createServer({ config, deepseekKey, logFile: paths.logFile, log });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  log(`listening on http://${host}:${server.address().port} (codex: /backend-api/codex, claude: /anthropic, status: /switchboard/)`);
  await new Promise((resolve) => { for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.close(resolve)); });
  return 0;
}

export function splitListen(listen) {
  const i = listen.lastIndexOf(':');
  return [listen.slice(0, i) || '127.0.0.1', Number(listen.slice(i + 1)) || 4141];
}
