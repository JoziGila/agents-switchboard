#!/usr/bin/env node
import { run } from '../src/cli.js';
run(process.argv.slice(2)).then((code) => process.exit(code ?? 0), (e) => { console.error(e?.stack ?? e); process.exit(1); });
