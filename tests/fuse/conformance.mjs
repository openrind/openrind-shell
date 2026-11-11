#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';

const mountpoint = process.env.OPENERAL_MOUNTPOINT || '/sandbox/work';
const root = `${mountpoint}/.openeral-fuse-conformance-${process.pid}`;
const completed = [];

function check(name, run) {
  run();
  completed.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

mkdirSync(root, { mode: 0o700 });

try {
  check('whole-file durability and directory fsync', () => {
    const path = `${root}/whole`;
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeSync(fd, Buffer.from('whole-file'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(root);
    assert.equal(readFileSync(path, 'utf8'), 'whole-file');
  });

  check('partial overwrite preserves surrounding chunks', () => {
    const path = `${root}/partial`;
    const original = Buffer.alloc(600_000, 0x61);
    const patch = Buffer.alloc(32_000, 0x62);
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    try {
      assert.equal(writeSync(fd, original, 0, original.length, 0), original.length);
      assert.equal(writeSync(fd, patch, 0, patch.length, 250_000), patch.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const actual = readFileSync(path);
    assert.equal(actual.length, original.length);
    assert(actual.subarray(0, 250_000).equals(original.subarray(0, 250_000)));
    assert(actual.subarray(250_000, 282_000).equals(patch));
    assert(actual.subarray(282_000).equals(original.subarray(282_000)));
  });

  check('sparse write exposes zero-filled holes', () => {
    const path = `${root}/sparse`;
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    try {
      writeSync(fd, Buffer.from([0x7f]), 0, 1, 1024 * 1024);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assert.equal(statSync(path).size, 1024 * 1024 + 1);
    const hole = Buffer.alloc(4096, 0xff);
    const readFd = openSync(path, constants.O_RDONLY);
    try {
      assert.equal(readSync(readFd, hole, 0, hole.length, 512 * 1024), hole.length);
    } finally {
      closeSync(readFd);
    }
    assert(hole.equals(Buffer.alloc(hole.length)));
  });

  check('truncate grows with zeroes and shrinks exactly', () => {
    const path = `${root}/truncate`;
    writeFileSync(path, 'abcdef', { mode: 0o600 });
    const fd = openSync(path, constants.O_RDWR);
    try {
      ftruncateSync(fd, 8192);
      fsyncSync(fd);
      assert.equal(statSync(path).size, 8192);
      const grown = readFileSync(path);
      assert.equal(grown.subarray(0, 6).toString(), 'abcdef');
      assert(grown.subarray(6).equals(Buffer.alloc(8192 - 6)));
      ftruncateSync(fd, 3);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(path, 'utf8'), 'abc');
  });

  check('O_TRUNC on existing file truncates to zero immediately', () => {
    const path = `${root}/open-trunc`;
    writeFileSync(path, 'initial-content-before-trunc', { mode: 0o600 });
    assert.equal(statSync(path).size, 'initial-content-before-trunc'.length);
    const fd = openSync(path, constants.O_WRONLY | constants.O_TRUNC);
    try {
      assert.equal(statSync(path).size, 0);
      writeSync(fd, Buffer.from('fresh'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(path, 'utf8'), 'fresh');
    assert.equal(statSync(path).size, 5);
  });

  check('rename replacement flushes a dirty source and preserves its inode', () => {
    const source = `${root}/rename-source`;
    const destination = `${root}/rename-destination`;
    writeFileSync(destination, 'old-value', { mode: 0o600 });
    const fd = openSync(source, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    try {
      writeSync(fd, Buffer.from('new-value'));
      const sourceInode = statSync(source).ino;
      renameSync(source, destination);
      assert.equal(statSync(destination).ino, sourceInode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(destination, 'utf8'), 'new-value');
  });

  check('open-unlinked file remains usable until final close', () => {
    const path = `${root}/open-unlinked`;
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    try {
      writeSync(fd, Buffer.from('before'), 0, 6, 0);
      unlinkSync(path);
      writeSync(fd, Buffer.from('after'), 0, 5, 6);
      const actual = Buffer.alloc(11);
      assert.equal(readSync(fd, actual, 0, actual.length, 0), actual.length);
      assert.equal(actual.toString(), 'beforeafter');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assert.throws(() => statSync(path), { code: 'ENOENT' });
  });

  check('symlink and non-UTF8 directory entry round-trip', () => {
    const target = `${root}/symlink-target`;
    const link = `${root}/symlink`;
    writeFileSync(target, 'target-data', { mode: 0o600 });
    symlinkSync('symlink-target', link);
    assert.equal(readFileSync(link, 'utf8'), 'target-data');

    const parent = Buffer.from(`${root}/`, 'utf8');
    const rawPath = Buffer.concat([parent, Buffer.from([0x66, 0x6f, 0x80])]);
    writeFileSync(rawPath, Buffer.from('raw-name'), { mode: 0o600 });
    assert.equal(readFileSync(rawPath, 'utf8'), 'raw-name');
    unlinkSync(rawPath);
  });

  check('mode changes and nested directory rename are durable', () => {
    const first = `${root}/tree`;
    const second = `${root}/tree-renamed`;
    mkdirSync(`${first}/nested`, { recursive: true, mode: 0o700 });
    const path = `${first}/nested/file`;
    writeFileSync(path, 'nested', { mode: 0o600 });
    chmodSync(path, 0o640);
    const inode = lstatSync(path).ino;
    renameSync(first, second);
    const renamed = `${second}/nested/file`;
    assert.equal(lstatSync(renamed).ino, inode);
    assert.equal(lstatSync(renamed).mode & 0o777, 0o640);
    assert.equal(readFileSync(renamed, 'utf8'), 'nested');
    fsyncDirectory(`${second}/nested`);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
  fsyncDirectory(mountpoint);
}

process.stdout.write(`Conformance complete: ${completed.length} checks passed\n`);
