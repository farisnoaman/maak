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
const workflows = ['ci.yml', 'notify.yml'];

await mkdir(join(root, '.github', 'workflows'), { recursive: true });
for (const file of workflows) {
  const target = join(root, '.github', 'workflows', file);
  await copyFile(join(root, 'docs', 'ci', file), target);
  console.log(`✓ ${target.replace(`${root}/`, '')}`);
}

console.log('  next: git add .github/workflows && git commit -m "ci: activate workflows"');
console.log(
  '  then: set MAAK_API_URL and MAAK_WORKER_TOKEN as repository secrets for the notify workflow,',
);
