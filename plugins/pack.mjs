#!/usr/bin/env node
// Package plugins as .tar.gz and write a repository index (plugins/dist/repository.json).
//   node plugins/pack.mjs [baseUrl]   e.g. https://github.com/<owner>/<repo>/releases/download/plugins
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, 'dist');
const base = (process.argv[2] ?? 'http://127.0.0.1:18790').replace(/\/+$/, '');
fs.mkdirSync(out, { recursive: true });
const plugins = [];
for (const name of fs.readdirSync(path.join(here, 'examples'))) {
  const dir = path.join(here, 'examples', name);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  const file = `${m.id}-${m.version}.tar.gz`;
  execFileSync('tar', ['-czf', path.join(out, file), '-C', dir, '.']);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex');
  plugins.push({ id: m.id, name: m.name, description: m.description, author: m.author, homepage: m.homepage, versions: [{ version: m.version, url: `${base}/${file}`, sha256, minServerVersion: m.minServerVersion }] });
  console.log(`packed ${file} ${sha256.slice(0, 12)}…`);
}
fs.writeFileSync(path.join(out, 'repository.json'), JSON.stringify({ name: 'MediaMax example plugins', plugins }, null, 2));
console.log(`wrote ${path.join(out, 'repository.json')}`);
