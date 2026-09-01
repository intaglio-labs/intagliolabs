#!/usr/bin/env node

import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) {
  throw new Error('usage: check-staged-connectors.mjs <staged-connectors-directory>');
}

const staged = resolve(root);
const daemon = await import(pathToFileURL(join(staged, 'daemon.mjs')).href);
const sources = await daemon.loadSources(join(staged, 'sources'));

process.stdout.write(`staged connector roster: ${sources.length} unique sources\n`);
