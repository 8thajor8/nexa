import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DESKTOP_ISOLATED_ARGUMENT = "--nexa-isolated";
export const DESKTOP_ORGANIC_PILOT_ARGUMENT = "--nexa-memory2-organic-synthetic-pilot";

export interface DesktopIsolationConfig {
  profilePath: string;
  memoryStorePath: string;
  organicPilot: boolean;
}

interface IsolatedAppPaths {
  setPath: (name: "userData" | "sessionData", path: string) => void;
  getPath: (name: "userData" | "sessionData") => string;
}

function isWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function resolveApprovedSyntheticRoot(localAppData: string | undefined): string | null {
  if (!localAppData) return null;
  try {
    const localRoot = realpathSync(localAppData);
    let cursor = localRoot;
    for (const segment of ["Nexa", "Temporary", "memory-desktop-01"]) {
      cursor = resolve(cursor, segment);
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || !info.isDirectory() || !isWithin(localRoot, realpathSync(cursor))) return null;
    }
    return realpathSync(cursor);
  } catch { return null; }
}

/** Return only an existing synthetic store inside the approved temporary locations. */
export function resolveSyntheticMemory2StorePath(
  configuredPath: string | undefined,
  repositoryRoot: string,
  temporaryDirectory = tmpdir(),
  localAppData = process.env.LOCALAPPDATA,
): string | null {
  if (typeof configuredPath !== "string" || !configuredPath.trim() || !isAbsolute(configuredPath)) return null;
  try {
    const sourceRoot = realpathSync(repositoryRoot);
    const temporaryRoot = realpathSync(temporaryDirectory);
    const approvedSyntheticRoot = resolveApprovedSyntheticRoot(localAppData);
    const linkInfo = lstatSync(configuredPath);
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) return null;
    const storePath = realpathSync(configuredPath);
    const inSystemTemp = isWithin(temporaryRoot, storePath);
    const inApprovedSyntheticRoot = approvedSyntheticRoot !== null && isWithin(approvedSyntheticRoot, storePath);
    if ((!inSystemTemp && !inApprovedSyntheticRoot) || isWithin(sourceRoot, storePath)
      || !basename(storePath).startsWith("nexa-memory2-synthetic-")) return null;
    return storePath;
  } catch {
    return null;
  }
}

/** Resolve the one dedicated Desktop write-test store. It may be created on
 * explicit opt-in, but may never resolve inside the repository or through a link. */
export function resolveSyntheticMemory2WriteStorePath(
  localAppData: string | undefined,
  repositoryRoot: string,
): string | null {
  if (!localAppData || !isAbsolute(localAppData)) return null;
  try {
    const localRoot = realpathSync(localAppData);
    const sourceRoot = realpathSync(repositoryRoot);
    let cursor = localRoot;
    for (const segment of ["Nexa", "Temporary", "memory-write-01"]) {
      cursor = resolve(cursor, segment);
      try {
        const info = lstatSync(cursor);
        if (info.isSymbolicLink() || !info.isDirectory() || !isWithin(localRoot, realpathSync(cursor))) return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") break;
        return null;
      }
    }
    const storePath = resolve(localRoot, "Nexa", "Temporary", "memory-write-01", "nexa-memory2-synthetic-write-v5.json");
    if (!isWithin(localRoot, storePath) || isWithin(sourceRoot, storePath)) return null;
    try {
      const info = lstatSync(storePath);
      if (!info.isFile() || info.isSymbolicLink() || realpathSync(storePath) !== storePath) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
    }
    return storePath;
  } catch {
    return null;
  }
}

/** The normal persistent Memory2 store shared with the existing Runtime CLI. */
export function resolvePersonalMemory2StorePath(repositoryRoot: string): string | null {
  try {
    const sourceRoot = realpathSync(repositoryRoot);
    const dataDirectory = resolve(sourceRoot, "data");
    try {
      const directoryInfo = lstatSync(dataDirectory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()
        || realpathSync(dataDirectory) !== dataDirectory || !isWithin(sourceRoot, dataDirectory)) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
    }
    const storePath = resolve(dataDirectory, "memory-v2.json");
    try {
      const storeInfo = lstatSync(storePath);
      if (storeInfo.isSymbolicLink() || !storeInfo.isFile() || realpathSync(storePath) !== storePath) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
    }
    return isWithin(dataDirectory, storePath) ? storePath : null;
  } catch { return null; }
}

export function isDesktopIsolationRequested(argv: readonly string[] = process.argv): boolean {
  return argv.includes(DESKTOP_ISOLATED_ARGUMENT);
}

export function isOrganicMemoryPilotRequested(argv: readonly string[] = process.argv): boolean {
  return argv.includes(DESKTOP_ORGANIC_PILOT_ARGUMENT);
}

export function desktopStartupPolicy(isolated: boolean, organicPilot = false) {
  return Object.freeze({
    loadRootEnvironment: !isolated,
    registerExternalServices: !isolated,
    registerChat: !isolated || organicPilot,
    registerMemoryMode: !isolated,
    registerAuthorization: !isolated,
    registerVoice: !isolated,
    allowRuntimeTools: !isolated,
    readSystemWallpaper: !isolated,
  });
}

export async function validateIsolatedMemoryStore(
  storePath: string,
  openReader: (options: { storePath: string }) => Promise<{ close: () => Promise<void> }>,
): Promise<void> {
  let reader: { close: () => Promise<void> } | undefined;
  try {
    reader = await openReader({ storePath });
    if (!reader || typeof reader.close !== "function") throw new Error("invalid_reader");
    await reader.close();
  } catch {
    try { await reader?.close(); } catch { /* Preserve the sanitized startup error. */ }
    throw new Error("desktop_isolation_memory_store_invalid");
  }
}

export function prepareDesktopIsolation({
  argv = process.argv,
  env = process.env,
  app,
  repositoryRoot,
  temporaryDirectory = tmpdir(),
}: {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  app: IsolatedAppPaths;
  repositoryRoot: string;
  temporaryDirectory?: string;
}): DesktopIsolationConfig | null {
  const organicPilot = isOrganicMemoryPilotRequested(argv);
  if (!isDesktopIsolationRequested(argv)) {
    if (organicPilot) throw new Error("desktop_organic_pilot_requires_isolated_mode");
    return null;
  }

  if (env.NEXA_MEMORY_BACKEND !== "memory2-readonly") {
    throw new Error("desktop_isolation_requires_memory2_readonly");
  }
  const configuredStorePath = env.NEXA_MEMORY2_STORE_PATH;
  if (typeof configuredStorePath !== "string" || !configuredStorePath.trim() || !isAbsolute(configuredStorePath)) {
    throw new Error("desktop_isolation_requires_absolute_synthetic_memory_store");
  }

  let temporaryRoot: string;
  let sourceRoot: string;
  let approvedSyntheticRoot: string | null = null;
  let storeInfo: ReturnType<typeof lstatSync>;
  try {
    temporaryRoot = realpathSync(temporaryDirectory);
    sourceRoot = realpathSync(repositoryRoot);
    storeInfo = lstatSync(configuredStorePath);
  } catch {
    throw new Error("desktop_isolation_memory_store_invalid");
  }
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("desktop_isolation_temp_directory_not_local");
    let localAppDataRoot: string;
    try { localAppDataRoot = realpathSync(localAppData); }
    catch { throw new Error("desktop_isolation_temp_directory_not_local"); }
    if (!isWithin(localAppDataRoot, temporaryRoot)) throw new Error("desktop_isolation_temp_directory_not_local");
    approvedSyntheticRoot = resolveApprovedSyntheticRoot(localAppData);
  } else {
    approvedSyntheticRoot = resolveApprovedSyntheticRoot(env.LOCALAPPDATA ?? process.env.LOCALAPPDATA);
  }
  if (!storeInfo.isFile() || storeInfo.isSymbolicLink()) {
    throw new Error("desktop_isolation_memory_store_must_be_regular_file");
  }
  let storePath: string;
  try { storePath = realpathSync(configuredStorePath); }
  catch { throw new Error("desktop_isolation_memory_store_invalid"); }
  const inSystemTemp = isWithin(temporaryRoot, storePath);
  const inApprovedSyntheticRoot = approvedSyntheticRoot !== null && isWithin(approvedSyntheticRoot, storePath);
  if ((!inSystemTemp && !inApprovedSyntheticRoot) || isWithin(sourceRoot, storePath)
    || !basename(storePath).startsWith("nexa-memory2-synthetic-")) {
    throw new Error("desktop_isolation_memory_store_must_be_synthetic_temp_file");
  }

  let profilePath: string;
  try { profilePath = mkdtempSync(join(temporaryRoot, "nexa-desktop-isolated-")); }
  catch { throw new Error("desktop_isolation_profile_creation_failed"); }
  let resolvedProfilePath: string;
  try { resolvedProfilePath = realpathSync(profilePath); }
  catch { throw new Error("desktop_isolation_profile_path_invalid"); }
  if (!isWithin(temporaryRoot, resolvedProfilePath) || isWithin(sourceRoot, resolvedProfilePath)) {
    throw new Error("desktop_isolation_profile_path_invalid");
  }

  const sessionDataPath = join(profilePath, "session");
  try { mkdirSync(sessionDataPath); }
  catch { throw new Error("desktop_isolation_profile_creation_failed"); }
  try {
    app.setPath("userData", profilePath);
    app.setPath("sessionData", sessionDataPath);
  }
  catch { throw new Error("desktop_isolation_profile_not_applied"); }
  if (resolve(app.getPath("userData")).toLocaleLowerCase("en-US") !== resolve(profilePath).toLocaleLowerCase("en-US")
    || resolve(app.getPath("sessionData")).toLocaleLowerCase("en-US") !== resolve(sessionDataPath).toLocaleLowerCase("en-US")) {
    throw new Error("desktop_isolation_profile_not_applied");
  }

  return Object.freeze({ profilePath, memoryStorePath: storePath, organicPilot });
}
