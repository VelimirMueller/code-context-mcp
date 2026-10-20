import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isDeniedFileName,
  isDeniedPath,
  isLaravelStorage,
  maxFileBytes,
  looksBinary,
  isDeniedDirPath,
} from '../src/server/index-policy.js';

describe('index policy: hard default deny', () => {
  afterEach(() => {
    delete process.env.CODE_CONTEXT_MAX_FILE_KB;
  });

  it('denies lockfiles, minified bundles, source maps, binaries and dotfiles', () => {
    for (const n of [
      'package-lock.json',
      'yarn.lock',
      'composer.lock',
      'pnpm-lock.yaml',
      'Cargo.lock',
      'app.min.js',
      'site.min.css',
      'bundle.js.map',
      'logo.png',
      'font.woff2',
      'data.sqlite',
      '.env',
      '.DS_Store',
    ]) {
      expect(isDeniedFileName(n), n).toBe(true);
    }
    for (const n of [
      'index.ts',
      'composer.json',
      'package.json',
      'README.md',
      'app.js',
      'Controller.php',
    ]) {
      expect(isDeniedFileName(n), n).toBe(false);
    }
  });

  it('denies files under dependency, build and dot directories below the root', () => {
    const root = '/r';
    for (const p of [
      '/r/node_modules/x/index.js',
      '/r/vendor/laravel/a.php',
      '/r/dist/a.js',
      '/r/build/a.js',
      '/r/.next/a.js',
      '/r/coverage/a.js',
      '/r/.worktrees/T-1/src/a.ts',
      '/r/a/storage/framework/views/x.php',
    ]) {
      expect(isDeniedPath(p, root), p).toBe(true);
    }
    expect(isDeniedPath('/r/src/vendors.ts', root)).toBe(false);
    expect(isDeniedPath('/r/src/a.ts', root)).toBe(false);
  });

  it('judges only segments below the root (a repo may live under a dot-dir)', () => {
    expect(isDeniedPath('/home/u/.config/repo/src/a.ts', '/home/u/.config/repo')).toBe(false);
    expect(isDeniedPath('/home/u/.config/repo/src/a.ts', '/')).toBe(true);
  });

  it('applies the size cap, overridable with CODE_CONTEXT_MAX_FILE_KB', () => {
    expect(maxFileBytes()).toBe(512 * 1024);
    expect(isDeniedPath('/r/a.ts', '/r', 600 * 1024)).toBe(true);
    process.env.CODE_CONTEXT_MAX_FILE_KB = '1024';
    expect(isDeniedPath('/r/a.ts', '/r', 600 * 1024)).toBe(false);
  });

  it('skips storage/ only where a Laravel artisan file sits next to it', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-lara-')));
    try {
      mkdirSync(path.join(root, 'laravel/storage/app'), { recursive: true });
      mkdirSync(path.join(root, 'android/storage'), { recursive: true });
      writeFileSync(path.join(root, 'laravel/artisan'), '#!/usr/bin/env php');
      expect(isLaravelStorage(path.join(root, 'laravel/storage'))).toBe(true);
      expect(isLaravelStorage(path.join(root, 'android/storage'))).toBe(false);
      expect(isDeniedPath(path.join(root, 'laravel/storage/app/x.json'), root)).toBe(true);
      expect(isDeniedPath(path.join(root, 'android/storage/Db.kt'), root)).toBe(false);
      expect(isDeniedDirPath(path.join(root, 'laravel/storage/app'), root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sniffs NUL bytes as binary', () => {
    expect(looksBinary(Buffer.from([0x50, 0x00, 0x41]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
  });
});

describe('index policy: secret-shaped files', () => {
  afterEach(() => {
    delete process.env.CODE_CONTEXT_INDEX_ALLOW;
  });

  it('denies secret extensions, including the multi-dot tfstate backup', () => {
    for (const n of [
      'app.pem',
      'server.key',
      'keystore.p12',
      'cert.pfx',
      'trust.jks',
      'ca.keystore',
      'key.asc',
      'key.gpg',
      'terraform.tfstate',
      'terraform.tfstate.backup',
      'vault.kdbx',
      'vpn.ovpn',
    ]) {
      expect(isDeniedFileName(n), n).toBe(true);
    }
    for (const n of ['app.pom', 'server.py', 'terraform.tf', 'data.kdb', 'notes.txt']) {
      expect(isDeniedFileName(n), n).toBe(false);
    }
  });

  it('denies secret basenames: ssh keys, credentials, secrets, service accounts, tfvars, oauth', () => {
    for (const n of [
      'id_rsa',
      'id_rsa.pub',
      'id_dsa',
      'id_ecdsa',
      'id_ed25519',
      'id_rsa_old',
      'credentials',
      'credentials.json',
      'credentials.yml',
      'credentials.yaml',
      'secrets.yml',
      'secrets.yaml',
      'secrets.json',
      'service-account.json',
      'service-account-prod.json',
      'my-service-account-prod.json',
      'terraform.tfvars',
      'staging.tfvars',
      'token.json',
      'oauth.json',
      'oauth-token.json',
      'known_hosts',
      'authorized_keys',
    ]) {
      expect(isDeniedFileName(n), n).toBe(true);
    }
    for (const n of [
      'id.rsa',
      'credential.json',
      'secret.yml',
      'account.json',
      'oauth.py',
      'token.ts',
    ]) {
      expect(isDeniedFileName(n), n).toBe(false);
    }
  });

  it('matches case-insensitively', () => {
    for (const n of ['ID_RSA', 'App.PEM', 'Credentials.JSON', 'Terraform.TFSTATE.BACKUP']) {
      expect(isDeniedFileName(n), n).toBe(true);
    }
  });

  it('CODE_CONTEXT_INDEX_ALLOW opts a name back in (basename or *.ext glob)', () => {
    process.env.CODE_CONTEXT_INDEX_ALLOW = '*.pem, id_rsa, credentials.json';
    for (const n of ['app.pem', 'id_rsa', 'credentials.json']) {
      expect(isDeniedFileName(n), n).toBe(false);
    }
    for (const n of ['server.key', 'id_dsa', 'secrets.json', 'known_hosts']) {
      expect(isDeniedFileName(n), n).toBe(true);
    }
  });

  it('CODE_CONTEXT_INDEX_ALLOW never opts a dotfile back in', () => {
    process.env.CODE_CONTEXT_INDEX_ALLOW = '.env, .netrc, *.pem';
    for (const n of ['.env', '.netrc', '.npmrc']) {
      expect(isDeniedFileName(n), n).toBe(true);
    }
  });
});
