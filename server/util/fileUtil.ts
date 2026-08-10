import fs from 'node:fs';
import {promises as fsp} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

import config from '../../config';

export const accessDeniedError = () => {
  const error = new Error('Permission denied') as NodeJS.ErrnoException;
  error.code = 'EACCES';
  return error;
};

export const fileNotFoundError = () => {
  const error = new Error('No such file or directory') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
};

/**
 * Is `candidate` the same path as `allowed`, or inside it?
 *
 * Both sides are normalised first. `allowedPaths` arrives verbatim from
 * `--allowedpath` / `FLOOD_OPTION_ALLOWEDPATH` and is never normalised, while
 * the candidate has been through `path.resolve()` and `fs.realpath()` — which
 * strip any trailing separator. A plain `startsWith` therefore rejected a
 * perfectly good configuration: `FLOOD_OPTION_ALLOWEDPATH=/data/` never matched
 * the resolved `/data`, and every add returned 403 Permission denied with no
 * indication why.
 *
 * The comparison is also component-wise rather than a raw string prefix, so
 * permitting `/data` no longer also permits `/database`.
 */
export const isPathWithin = (candidate: string | null, allowed: string): boolean => {
  if (candidate == null) {
    return false;
  }

  const normalisedCandidate = path.resolve(candidate);
  const normalisedAllowed = path.resolve(allowed);

  if (normalisedCandidate === normalisedAllowed) {
    return true;
  }

  // path.relative() gives '..'-prefixed output when the candidate sits outside,
  // and an absolute path when the two share no root at all.
  const relative = path.relative(normalisedAllowed, normalisedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export const isAllowedPath = (resolvedPath: string) => {
  if (config.allowedPaths == null) {
    return true;
  }

  let realPath: string | null = null;
  let parentPath: string = resolvedPath;
  while (realPath == null) {
    try {
      realPath = fs.realpathSync(parentPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        parentPath = path.resolve(parentPath, '..');
      } else {
        return false;
      }
    }
  }

  return config.allowedPaths.some((allowedPath) => isPathWithin(realPath, allowedPath));
};

export async function isAllowedPathAsync(resolvedPath: string) {
  if (config.allowedPaths == null) {
    return true;
  }

  let realPath: string | null = null;
  let parentPath: string = resolvedPath;
  while (realPath == null) {
    try {
      realPath = await fsp.realpath(parentPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        parentPath = path.resolve(parentPath, '..');
      } else {
        return false;
      }
    }
  }

  return config.allowedPaths.some((allowedPath) => isPathWithin(realPath, allowedPath));
}

export async function existAsync(path: string): Promise<boolean> {
  try {
    await fsp.stat(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }

  return true;
}

export async function cleanupEmptyDirectories(directory: string): Promise<boolean> {
  if (!isAllowedPath(directory)) {
    return false;
  }

  let entries: fs.Dirent[];

  try {
    entries = await fsp.readdir(directory, {withFileTypes: true});
  } catch {
    return false;
  }

  let isEmpty = true;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const childPath = path.join(directory, entry.name);
      const wasRemoved = await cleanupEmptyDirectories(childPath);

      if (!wasRemoved) {
        isEmpty = false;
      }
    } else {
      isEmpty = false;
    }
  }

  if (!isEmpty) {
    return false;
  }

  try {
    await fsp.rmdir(directory);
    return true;
  } catch {
    return false;
  }
}

export const sanitizePath = (input?: string): string => {
  if (typeof input !== 'string') {
    throw accessDeniedError();
  }

  // eslint-disable-next-line no-control-regex
  const controlRe = /[\x00-\x1f\x80-\x9f]/g;

  return path.resolve(input.replace(/^~/, homedir()).replace(controlRe, ''));
};
