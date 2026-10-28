#!/usr/bin/env node
/**
 * Installs the CI workflow into `.github/workflows/`.
 *
 * CI lives in `docs/ci/ci.yml` because the GitHub App used by the coding agent is not granted the
 * `workflows` permission, so it cannot push files under `.github/workflows/`. This script makes
 * activation a single command on a machine (or token) that does have the permission:
 *
 *   npm run ci:install && git add .github/workflows/ci.yml && git commit -m "ci: activate" && git push
 */

import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'docs', 'ci', 'ci.yml');
const target = join(root, '.github', 'workflows', 'ci.yml');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`✓ ${target.replace(`${root}/`, '')}`);
console.log('  next: git add .github/workflows/ci.yml && git commit -m "ci: activate workflow"');
