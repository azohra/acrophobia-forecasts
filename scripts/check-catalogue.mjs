import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'forecast-catalogue-'));
try {
  const output = join(directory, 'models.json');
  execFileSync('pnpm', ['exec', 'meteo', 'forecast', 'catalogue', '--output', output], {
    stdio: 'inherit', timeout: 10_000,
  });
  const catalogue = JSON.parse(readFileSync(output, 'utf8'));
  assert(Array.isArray(catalogue.models) && catalogue.models.length > 0, 'Expected a nonempty forecast catalogue');
  for (const model of catalogue.models) {
    assert(typeof model.slug === 'string' && model.slug.length > 0, 'Expected model slugs in the catalogue');
  }
  console.log(`check: pinned engine exported ${catalogue.models.length} forecast models`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
