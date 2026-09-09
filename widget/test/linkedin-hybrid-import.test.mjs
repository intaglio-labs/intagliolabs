import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const widget = join(dirname(fileURLToPath(import.meta.url)), '..');
const bridge = readFileSync(join(widget, 'src', 'Bridge.swift'), 'utf8');
const importer = readFileSync(join(widget, 'src', 'LinkedInArchiveImport.swift'), 'utf8');
const connections = readFileSync(join(widget, 'ui', 'connections.js'), 'utf8');
const connectorTile = readFileSync(join(widget, 'ui', 'connector-tile.js'), 'utf8');

test('the LinkedIn card exposes archive import before live connection', () => {
  assert.match(connections, /hzPost\('importLinkedInArchive'/u);
  assert.match(connections, /kindOf\(src\.id\) !== 'linkedin'/u,
    'an unconnected LinkedIn tile must open the hybrid card instead of starting login immediately');
});

test('both LinkedIn surfaces keep archive import visible in the bridge-status card', () => {
  for (const [name, source] of [
    ['Settings', connections],
    ['People shelf', connectorTile],
  ]) {
    const calls = source.match(/appendLinkedInArchive\(tip\);/gu) ?? [];
    assert.equal(calls.length, 2,
      `${name} must append archive controls in both its ordinary and bridge-status renderers`);
  }
});

test('both LinkedIn surfaces show the persisted last-import time', () => {
  for (const [name, source] of [
    ['Settings', connections],
    ['People shelf', connectorTile],
  ]) {
    assert.match(source, /src\.archiveImportedAt/u, `${name} must read the persisted import status`);
    assert.match(source, /last imported/u, `${name} must label the import time plainly`);
  }
});

test('native import accepts only the two archive files and stores them owner-only', () => {
  assert.match(bridge, /case "importLinkedInArchive":/u);
  assert.match(importer, /Connections\.csv/u);
  assert.match(importer, /messages\.csv/u);
  assert.match(importer, /posixPermissions: 0o600/u);
  assert.doesNotMatch(importer, /ditto|tar\s|unzip", arguments: \["-o"/u,
    'the importer must not recursively unpack arbitrary archive paths');
});

test('ZIP import stops before an expanded CSV can exceed its byte limit', (t) => {
  if (process.platform !== 'darwin') return t.skip('the widget importer is macOS-only');
  const dir = mkdtempSync(join(tmpdir(), 'linkedin-import-limit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inputDir = join(dir, 'input');
  const destination = join(dir, 'destination');
  mkdirSync(inputDir);
  mkdirSync(destination);
  const csv = join(inputDir, 'messages.csv');
  const archive = join(dir, 'archive.zip');
  writeFileSync(csv, 'x'.repeat(4_096));
  const zipped = spawnSync('/usr/bin/zip', ['-j', archive, csv], { encoding: 'utf8' });
  assert.equal(zipped.status, 0, zipped.stderr);

  const harness = join(dir, 'main.swift');
  const executable = join(dir, 'import-test');
  const moduleCache = join(tmpdir(), 'intaglio-swift-test-module-cache');
  mkdirSync(moduleCache, { recursive: true });
  writeFileSync(harness, `
import Foundation

enum HarnessFailure: Error { case acceptedOversize, leftPartialFile }

@main
struct ImportHarness {
  static func main() throws {
    let archive = URL(fileURLWithPath: CommandLine.arguments[1])
    let destination = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    do {
      _ = try LinkedInArchiveImport.installFromZip(
        archive,
        in: destination,
        maximumBytes: 32
      )
      throw HarnessFailure.acceptedOversize
    } catch HarnessFailure.acceptedOversize {
      throw HarnessFailure.acceptedOversize
    } catch let error {
      _ = error
      let leftovers = try FileManager.default.contentsOfDirectory(atPath: destination.path)
      if !leftovers.isEmpty { throw HarnessFailure.leftPartialFile }
    }
  }
}
`);
  const compiled = spawnSync(
    '/usr/bin/swiftc',
    ['-parse-as-library', join(widget, 'src', 'LinkedInArchiveImport.swift'), harness, '-o', executable],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: moduleCache,
        SWIFT_MODULE_CACHE_PATH: moduleCache,
      },
    },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  const ran = spawnSync(executable, [archive, destination], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
});
