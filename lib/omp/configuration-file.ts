import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";

declare global {
  var __ompConfigurationBaselineSecret: Buffer | undefined;
  var __ompConfigurationFileLocks: Map<string, Promise<void>> | undefined;
}

export function configurationBaseline(parts: unknown[]): string {
  const secret = globalThis.__ompConfigurationBaselineSecret ??= randomBytes(32);
  return createHmac("sha256", secret).update(JSON.stringify(parts)).digest("hex");
}

export function sameConfigurationBaseline(expected: string, actual: string): boolean {
  return /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export function configurationFileIdentity(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const canonical = join(realpathSync(existing), relative(existing, absolute));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** In-process serialization only; external editors do not participate in this lock. */
export async function serializedConfigurationWrite<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = configurationFileIdentity(path);
  const locks = globalThis.__ompConfigurationFileLocks ??= new Map();
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(key) === queued) locks.delete(key); }
}

export function replaceConfigurationFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, content, { encoding: "utf8", mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
