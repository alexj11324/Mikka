// Lists the folders of this machine for the app's repository picker
// (ADR 0037). Only folder names and whether each is a git repo leave the
// device, never file contents. The device's owner is the only person who can
// ask (the server checks), and the owner already owns every folder here.
import { execFile } from "node:child_process"
import type { Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"

import {
  FS_MAX_ENTRIES,
  type FsBrowseRequest,
  type FsEntry,
  type FsResult,
} from "@mikka/protocol/device"

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], {
      timeout: 5_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The git repo around `path` and its remote (`origin`, else the first). */
async function repoAround(path: string) {
  const top = await git(path, ["rev-parse", "--show-toplevel"])
  if (!top) return null
  const origin = await git(top, ["config", "--get", "remote.origin.url"])
  const first = origin
    ? null
    : ((await git(top, ["remote"]))?.split("\n")[0] ?? null)
  const remoteUrl =
    origin ??
    (first ? await git(top, ["config", "--get", `remote.${first}.url`]) : null)
  return { path: top, remoteUrl }
}

export async function browseFolder(
  request: FsBrowseRequest
): Promise<FsResult> {
  const home = homedir()
  const wanted = request.path ?? home
  if (!isAbsolute(wanted))
    return {
      ok: false,
      code: "not_found",
      message: "Expected an absolute path.",
    }
  const path = resolve(wanted)
  if (!(await exists(path)))
    return { ok: false, code: "not_found", message: `${path} does not exist.` }
  if (!(await isDir(path)))
    return {
      ok: false,
      code: "not_a_directory",
      message: `${path} is not a folder.`,
    }
  let names: Dirent[]
  try {
    names = await readdir(path, { withFileTypes: true })
  } catch (error) {
    const denied = (error as NodeJS.ErrnoException).code
    return denied === "EACCES" || denied === "EPERM"
      ? {
          ok: false,
          code: "denied",
          message: `Mikka may not read ${path}. Allow access in system settings.`,
        }
      : { ok: false, code: "failed", message: `Could not read ${path}.` }
  }
  const folders: FsEntry[] = []
  let truncated = false
  const dirs = names
    // A symlink to a folder is a folder here.
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .filter((e) => request.showHidden || !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of dirs) {
    const full = join(path, entry.name)
    if (entry.isSymbolicLink() && !(await isDir(full))) continue
    if (folders.length >= FS_MAX_ENTRIES) {
      truncated = true
      break
    }
    folders.push({
      name: entry.name,
      path: full,
      isRepo: await exists(join(full, ".git")),
    })
  }
  const parent = dirname(path)
  return {
    ok: true,
    path,
    parent: parent === path || basename(path) === "" ? null : parent,
    home,
    platform: platform(),
    entries: folders,
    truncated,
    repo: await repoAround(path),
  }
}
