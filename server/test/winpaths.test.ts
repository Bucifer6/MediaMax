/**
 * Windows network paths: reading mapped drives from `reg query` output, recognising \\server\share paths, and the
 * hints added to "Folder not found" errors for network paths and drive letters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUncPath, uncShareRoot, parseRegNetwork, networkPathHint, mappedDrives } from '../src/util/winpaths.ts';

test('parseRegNetwork reads drive letters and their shares from reg query output', () => {
  const out = [
    '',
    'HKEY_USERS\\S-1-5-21-111-222-333-1001\\Network\\m',
    '    ConnectionType    REG_DWORD    0x1',
    '    RemotePath    REG_SZ    \\\\nas\\media',
    '    UserName    REG_SZ    ',
    '',
    'HKEY_USERS\\S-1-5-21-111-222-333-1001\\Network\\Z',
    '    RemotePath    REG_SZ    \\\\192.168.1.20\\Films & TV',
    '',
  ].join('\r\n');
  assert.deepEqual(parseRegNetwork(out), [
    { letter: 'M', remotePath: '\\\\nas\\media' },
    { letter: 'Z', remotePath: '\\\\192.168.1.20\\Films & TV' },
  ]);
  assert.deepEqual(parseRegNetwork('ERROR: The system was unable to find the specified registry key or value.'), []);
});

test('UNC paths and their share roots', () => {
  assert.equal(isUncPath('\\\\nas\\media'), true);
  assert.equal(isUncPath('\\\\nas\\media\\Movies'), true);
  assert.equal(isUncPath('//nas/media'), true);
  assert.equal(isUncPath('\\\\nas'), false, 'a bare server is not a folder');
  assert.equal(isUncPath('D:\\Movies'), false);
  assert.equal(uncShareRoot('\\\\nas\\media\\Movies\\2024'), '\\\\nas\\media');
  assert.equal(uncShareRoot('D:\\Movies'), null);
});

test('networkPathHint explains network paths and drive letters on Windows only', () => {
  const sys = networkPathHint('\\\\nas\\media', 'win32', 'SYSTEM');
  assert.match(sys, /runs as \(SYSTEM\)/);
  assert.match(sys, /choose a Windows account/);
  const user = networkPathHint('\\\\nas\\media\\Movies', 'win32', 'PC\\nasuser');
  assert.match(user, /Check that PC\\nasuser can open \\\\nas\\media in File Explorer/);
  const letter = networkPathHint('Z:\\Movies', 'win32', 'SYSTEM');
  assert.match(letter, /If Z: is a mapped network drive, use its network path/);
  assert.equal(networkPathHint('C:\\Media', 'win32', 'SYSTEM'), '', 'C: is never a mapped drive');
  assert.equal(networkPathHint('/mnt/media', 'linux', 'root'), '');
  assert.equal(networkPathHint('\\\\nas\\media', 'linux', 'root'), '');
});

test('mappedDrives is empty off Windows', async () => {
  if (process.platform !== 'win32') assert.deepEqual(await mappedDrives(), []);
});
