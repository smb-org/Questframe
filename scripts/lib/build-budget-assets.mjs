import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const sumDirectoryBytes = async (directory) => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  const sizes = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sumDirectoryBytes(entryPath);
    return (await stat(entryPath)).size;
  }));
  return sizes.reduce((total, size) => total + size, 0);
};
