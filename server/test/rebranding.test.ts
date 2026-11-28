import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { USER_AGENT } from '../src/util/userAgent.js';
import { config } from '../src/config.js';
import { TunerHttp } from '../src/services/livetv/tuners/http.js';
import { SD_USER_AGENT } from '../src/services/livetv/epg/schedulesdirect.js';
import { userAgent } from '../src/services/metadata/http.js';
import { backupPath, createBackup, deleteBackup, listBackups } from '../src/services/backup.js';
import { SERVER_HDR } from '../src/services/dlna.js';

test('public network clients identify the product as Vibe while retaining provider overrides', () => {
  assert.equal(USER_AGENT, `Vibe/${config.version}`);
  assert.equal(new TunerHttp().userAgent, USER_AGENT);
  assert.equal(new TunerHttp({}, 'Provider-approved-agent/2').userAgent, 'Provider-approved-agent/2');
  assert.ok(SD_USER_AGENT.startsWith(USER_AGENT));
  assert.ok(userAgent().startsWith(USER_AGENT));
  assert.ok(SERVER_HDR.includes(USER_AGENT));
  assert.match(SERVER_HDR, /Kinora\//, 'already-installed Roku channels must still discover the server');
});

test('new backup filenames use Vibe and existing MediaMax archives remain accessible', () => {
  const made = createBackup();
  assert.match(made.id, /^vibe-.*-manual\.tar\.gz$/);
  const current = backupPath(made.id);
  const legacyId = made.id.replace(/^vibe-/, 'mediamax-');
  const legacy = current.replace(made.id, legacyId);
  fs.copyFileSync(current, legacy);
  assert.ok(listBackups().some((backup) => backup.id === legacyId));
  assert.equal(backupPath(legacyId), legacy);
  assert.throws(() => backupPath('../mediamax-escape.tar.gz'));
  deleteBackup(legacyId);
  deleteBackup(made.id);
});
