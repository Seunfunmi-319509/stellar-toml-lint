import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { XMLValidator } from 'fast-xml-parser';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const fixture = (name: string): string => join(here, 'fixtures', name);

/** Runs the built CLI, capturing the exit code instead of throwing. */
function cli(
  args: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// These exercise the built artifact, so they depend on `npm run build`.
describe('cli', () => {
  it('exits 0 on a valid file', async () => {
    const { code, stdout } = await cli([fixture('valid.toml')]);
    expect(code).toBe(0);
    expect(stdout).toContain('No SEP-1 issues found');
  });

  it('exits 1 on a broken file', async () => {
    const { code, stdout } = await cli([fixture('broken.toml')]);
    expect(code).toBe(1);
    expect(stdout).toContain('error');
  });

  it('exits 2 when the file does not exist', async () => {
    const { code, stderr } = await cli(['./definitely-not-here.toml']);
    expect(code).toBe(2);
    expect(stderr).toContain('Could not find');
  });

  it('exits 2 on an unknown option', async () => {
    const { code, stderr } = await cli(['--nonsense']);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown option');
  });

  it('rejects an unknown rule id and suggests alternatives', async () => {
    const { code, stderr } = await cli(['--off', 'general/versionz']);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown rule');
  });

  it('prints usage for --help', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('EXIT CODES');
    expect(stdout).toContain('--check-contracts');
    expect(stdout).toContain('--soroban-rpc');
  });

  it('prints the version', async () => {
    const { code, stdout } = await cli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('lists every rule', async () => {
    const { code, stdout } = await cli(['--list-rules']);
    expect(code).toBe(0);
    expect(stdout).toContain('currencies/issuance-exclusive');
    expect(stdout).toContain('currencies/regulated-missing-auth-required-flag');
    expect(stdout).toContain('currencies/regulated-missing-auth-revocable-flag');
    expect(stdout).toContain('soroban/contract-ttl-expiring-soon');
    expect(stdout).toContain('soroban/contract-expired');
    expect(stdout).toMatch(/^\d+ rules/);
  });

  it('accepts severity overrides on the network-bound rules', async () => {
    const accepted = await cli([
      fixture('valid.toml'),
      '--off',
      'soroban/contract-expired',
      '--error',
      'currencies/regulated-missing-auth-revocable-flag',
    ]);
    expect(accepted.code).toBe(0);
  });

  it('rejects --soroban-rpc without a value', async () => {
    const { code, stderr } = await cli(['--check-contracts', '--soroban-rpc']);
    expect(code).toBe(2);
    expect(stderr).toContain('expects a value');
  });

  it('emits parseable JSON', async () => {
    const { stdout } = await cli([fixture('broken.toml'), '-f', 'json']);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('emits parseable SARIF', async () => {
    const { stdout } = await cli([fixture('broken.toml'), '-f', 'sarif']);
    expect(JSON.parse(stdout).version).toBe('2.1.0');
  });

  it('emits parseable JUnit XML', async () => {
    const { stdout } = await cli([fixture('broken.toml'), '-f', 'junit']);
    expect(XMLValidator.validate(stdout)).toBe(true);
    expect(stdout).toContain('<testsuites');
    expect(stdout).toContain('<failure');
  });

  it('honours --off', async () => {
    const { stdout } = await cli([
      fixture('broken.toml'),
      '-f',
      'json',
      '--off',
      'general/version',
    ]);
    const rules = JSON.parse(stdout).diagnostics.map((d: { rule: string }) => d.rule);
    expect(rules).not.toContain('general/version');
  });

  it('fails a warning-only file under --strict', async () => {
    const clean = await cli([fixture('valid.toml'), '--strict']);
    expect(clean.code).toBe(0);

    // display_decimals warning only — no errors.
    const warned = await cli([fixture('warnings-only.toml')]);
    expect(warned.code).toBe(0);

    const strict = await cli([fixture('warnings-only.toml'), '--strict']);
    expect(strict.code).toBe(1);
  });

  it('honours --max-warnings', async () => {
    const under = await cli([fixture('warnings-only.toml'), '--max-warnings', '99']);
    expect(under.code).toBe(0);

    const over = await cli([fixture('warnings-only.toml'), '--max-warnings', '0']);
    expect(over.code).toBe(1);
  });

  it('shows only errors under --quiet', async () => {
    const { stdout } = await cli([fixture('broken.toml'), '--quiet', '-f', 'json']);
    const severities = JSON.parse(stdout).diagnostics.map((d: { severity: string }) => d.severity);
    expect(new Set(severities)).toEqual(new Set(['error']));
  });

  it('--fix rewrites mechanically safe findings in place and reports them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stllint-'));
    const file = join(dir, 'stellar.toml');
    const before = [
      'NETWORK_PASSPHRASE="Public Global Stellar Network  ;  September 2015"',
      'TRANSFER_SERVER="https://anchor.com/sep6/"',
      '[DOCUMENTATION]',
      'ORG_TWITTER="@stellarOrg"',
      '',
    ].join('\n');
    await writeFile(file, before, 'utf8');

    // The whitespace passphrase is an error, so the file fails before the fix.
    const original = await cli([file]);
    expect(original.code).toBe(1);

    const { code, stderr } = await cli([file, '--fix']);
    expect(code).toBe(0);
    expect(stderr).toContain('Fixed NETWORK_PASSPHRASE');
    expect(stderr).toContain('Fixed TRANSFER_SERVER');
    expect(stderr).toContain('Fixed DOCUMENTATION.ORG_TWITTER');
    expect(await readFile(file, 'utf8')).toBe(
      [
        'NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"',
        'TRANSFER_SERVER="https://anchor.com/sep6"',
        '[DOCUMENTATION]',
        'ORG_TWITTER="stellarOrg"',
        '',
      ].join('\n'),
    );

    // A second run finds nothing to fix and rewrites nothing.
    const again = await cli([file, '--fix']);
    expect(again.code).toBe(0);
    expect(again.stderr).not.toContain('Fixed');
  });

  it('--fix leaves a file with nothing to fix untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stllint-'));
    const file = join(dir, 'stellar.toml');
    const content = 'VERSION="2.7.0"\nTRANSFER_SERVER="https://anchor.com/sep6"\n';
    await writeFile(file, content, 'utf8');

    const { code, stderr } = await cli([file, '--fix']);
    expect(code).toBe(0);
    expect(stderr).not.toContain('Fixed');
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('rejects --fix on stdin', async () => {
    const { code, stderr } = await cli(['--fix', '-'], 'TRANSFER_SERVER="https://a.com/x/"\n');
    expect(code).toBe(2);
    expect(stderr).toContain('cannot rewrite stdin');
  });

  it('rejects --fix in --domain mode', async () => {
    const { code, stderr } = await cli(['--domain', 'example.com', '--fix']);
    expect(code).toBe(2);
    expect(stderr).toContain('cannot edit a file fetched over the network');
  });
});
