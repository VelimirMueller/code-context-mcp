/**
 * The text index_directory returns (CCA-06, #121). One stats line per
 * directory: the auto description ends with "N files, L lines." (indexer.ts
 * generateDirDescription), so that suffix is dropped and the numbers are
 * printed once, in the heading. Languages print as names, not as the stored
 * JSON, and only when the description does not already name them.
 */
import path from "path";
import type Database from "better-sqlite3";

export interface IndexCounts {
  files: number;
  exports: number;
  deps: number;
  prunedFiles?: number;
  prunedDirs?: number;
}

/** The auto-description stats suffix: "3 files, 1,204 lines." (any locale grouping). */
const AUTO_STATS = /(?:^|\.\s)\d[\d.,'\s]* files?, \d[\d.,'\s]* lines\.$/;

/** A directory description without the auto-generated stats suffix. */
export function stripDirStats(desc: string | null | undefined): string {
  const d = (desc ?? "").trim();
  return d.replace(AUTO_STATS, (m) => (m.startsWith(".") ? "." : "")).trim();
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Language names from the stored breakdown JSON, most files first. */
function languages(breakdown: string | null): string[] {
  if (!breakdown) return [];
  try {
    const list = JSON.parse(breakdown) as { lang: string; count: number }[];
    return list.map((l) => l.lang).filter((l) => l && l !== "unknown");
  } catch {
    return [];
  }
}

export function formatIndexSummary(db: Database.Database, root: string, counts: IndexCounts): string {
  const out: string[] = [];
  const pf = counts.prunedFiles ?? 0;
  const pd = counts.prunedDirs ?? 0;
  const pruned = pf || pd ? `; pruned ${plural(pf, "deleted file", "deleted files")}, ${plural(pd, "directory", "directories")}` : "";
  out.push(`# Indexed ${plural(counts.files, "file", "files")}, ${plural(counts.exports, "export", "exports")}, ${plural(counts.deps, "dependency", "dependencies")}${pruned}`);

  const filesIn = db.prepare(`
    SELECT path, summary, description FROM files
    WHERE path LIKE ? AND path NOT LIKE ? ORDER BY path
  `);
  const dirsIn = db.prepare(`
    SELECT path, name, description, file_count, total_lines, language_breakdown
    FROM directories WHERE parent_path = ? ORDER BY name
  `);
  type FileRow = { path: string; summary: string | null; description: string | null };
  type DirRow = { path: string; name: string; description: string | null; file_count: number; total_lines: number; language_breakdown: string | null };
  const fileLine = (f: FileRow) => {
    const desc = f.description ?? f.summary ?? "";
    return `- ${path.basename(f.path)}${desc ? ` — ${desc}` : ""}`;
  };

  const topDirs = dirsIn.all(root) as DirRow[];
  if (topDirs.length > 0) {
    out.push("", "## Directories");
    for (const dir of topDirs) {
      const desc = stripDirStats(dir.description);
      const langs = languages(dir.language_breakdown).filter((l) => !desc.toLowerCase().includes(l.toLowerCase()));
      const stats = dir.file_count
        ? ` — ${plural(dir.file_count, "file", "files")}, ${plural(dir.total_lines || 0, "line", "lines")}${langs.length ? ` (${langs.join(", ")})` : ""}`
        : "";
      out.push(`### ${dir.name}/${stats}`);
      if (desc) out.push(desc);
      for (const f of filesIn.all(dir.path + "/%", dir.path + "/%/%") as FileRow[]) out.push(fileLine(f));
      for (const sub of dirsIn.all(dir.path) as DirRow[]) {
        const sd = stripDirStats(sub.description);
        out.push(`- ${sub.name}/ (${plural(sub.file_count, "file", "files")})${sd ? ` — ${sd}` : ""}`);
      }
    }
  }

  const rootFiles = filesIn.all(root + "/%", root + "/%/%") as FileRow[];
  if (rootFiles.length > 0) {
    out.push("", "## Root files");
    for (const f of rootFiles) out.push(fileLine(f));
  }
  return out.join("\n");
}
