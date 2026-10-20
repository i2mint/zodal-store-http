/**
 * The published package carries the licence text it declares (zodal#45).
 *
 * npm packs a LICENSE that sits in the package directory even when `files`
 * lists only `dist`; this test keeps the file and the `license` field in step.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('licence', () => {
  it('ships a LICENSE matching the declared licence', () => {
    expect(JSON.parse(read('package.json')).license).toBe('MIT');
    expect(read('LICENSE')).toMatch(/^MIT License\n\nCopyright \(c\) \d{4} \S/);
  });
});
