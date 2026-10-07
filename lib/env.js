// Reads settings from the .env file. Windows editors save text in several ways
// (plain, with an invisible byte-order mark, or as UTF-16 from Notepad or
// PowerShell), and pasted keys often carry quotes or invisible characters, so
// all of those are handled here instead of failing with a confusing "bad key".

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MODEL = 'openai/gpt-oss-120b';

/** Turns the raw bytes of a .env file into text, whichever way it was saved. */
export function decodeEnvBytes(bytes) {
  const b = Buffer.from(bytes);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return swapBytes(b.subarray(2)).toString('utf16le');
  // UTF-16 without a byte-order mark: every other byte of plain text is zero.
  if (b.length >= 4 && b[0] !== 0 && b[1] === 0 && b[3] === 0) return b.toString('utf16le');
  if (b.length >= 4 && b[0] === 0 && b[1] !== 0 && b[2] === 0) return swapBytes(b).toString('utf16le');
  return b.toString('utf8');
}

function swapBytes(b) {
  const copy = Buffer.from(b.subarray(0, b.length - (b.length % 2)));
  return copy.swap16();
}

/** KEY=value lines → object. Skips blanks and # comments; accepts `export KEY=value` and quotes. */
export function parseEnvText(text) {
  const values = {};
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    values[key] = value;
  }
  return values;
}

/** Cleans a pasted key: quotes, spaces, a "Bearer " prefix and invisible characters. */
export function cleanSecret(value) {
  return String(value ?? '')
    .replace(/[​-‍⁠﻿ ]/g, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/[^\x21-\x7E]/g, '');
}

/** Loads .env into process.env without overriding values that are already set. */
export function loadEnvFile(file) {
  if (!fs.existsSync(file)) return { found: false, keys: [] };
  const values = parseEnvText(decodeEnvBytes(fs.readFileSync(file)));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { found: true, keys: Object.keys(values) };
}

/** The app's settings, cleaned up, from an environment object. */
export function readSettings(env = process.env) {
  const port = Number.parseInt(env.PORT, 10);
  return {
    nvidiaKey: cleanSecret(env.NVIDIA_API_KEY),
    model: cleanSecret(env.AI_MODEL) || DEFAULT_MODEL,
    githubToken: cleanSecret(env.GITHUB_TOKEN),
    claimCheck: !/^(off|false|0|no)$/i.test(String(env.CLAIM_CHECK ?? '').trim()),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000,
  };
}

/**
 * True when this file was started with `node <file>`, not imported. Compares real
 * paths, ignoring letter case on Windows, where "c:\\users" and "C:\\Users" are the same folder.
 */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  const normal = (file) => {
    let real = file;
    try {
      real = fs.realpathSync(file);
    } catch {
      // Keep the path as given.
    }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return normal(process.argv[1]) === normal(fileURLToPath(metaUrl));
}
