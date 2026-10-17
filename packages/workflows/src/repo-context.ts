/**
 * Repository conventions for a local model (ADR-045, phase 1).
 *
 * A cloud planner reads the repository through its CLI's tools; a local model has no tools and
 * sees only its prompt. This picks the few passages of the repository's own guidance that are most
 * relevant to the objective - its agent rules, contributing notes, README and package scripts - and
 * hands them over as context, so a local plan can name the real scripts and follow the real
 * conventions instead of guessing.
 *
 * Retrieval is lexical (term overlap weighted by rarity), not embeddings: an embedding model would
 * have the coordinator calling the model server directly, which the security model does not allow
 * (ollama is reached only through a worker job). The scoreboard decides whether that is enough.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type RepositoryFile = { path: string; content: string };
export type ContextSection = { label: string; content: string };

/** The files read for conventions, in priority order. Missing files are skipped. */
export const CONVENTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'README.md',
  'docs/CONTRIBUTING.md',
  'package.json',
] as const;

const DEFAULT_MAX_CHARS = 6_000;
const MAX_CHUNK_CHARS = 1_500;
const STOPWORDS = new Set(
  'the and for with that this from into your are was were will have has had not but you all any can its our use used using each when what which who how why than then them they their there here also only must should may such more most other some these those very just over under about after before while where would could does doing done'.split(
    ' ',
  ),
);

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter(
    (term) => !STOPWORDS.has(term),
  );
}

/** Markdown splits at headings; anything else into fixed windows. */
function chunk(file: RepositoryFile): ContextSection[] {
  if (file.path.endsWith('package.json')) {
    try {
      const parsed = JSON.parse(file.content) as { scripts?: Record<string, string> };
      if (!parsed.scripts) return [];
      return [
        {
          label: `${file.path} scripts`,
          content: Object.entries(parsed.scripts)
            .map(([name, command]) => `${name}: ${command}`)
            .join('\n'),
        },
      ];
    } catch {
      return [];
    }
  }
  const sections: ContextSection[] = [];
  let heading = file.path;
  let lines: string[] = [];
  const flush = () => {
    const content = lines.join('\n').trim();
    if (content.length > 0)
      for (let at = 0; at < content.length; at += MAX_CHUNK_CHARS)
        sections.push({ label: heading, content: content.slice(at, at + MAX_CHUNK_CHARS) });
    lines = [];
  };
  for (const line of file.content.split(/\r?\n/)) {
    const match = /^#{1,4}\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = `${file.path} - ${match[1]!.trim()}`;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

/**
 * The most relevant passages for `query`, within `maxChars`. Package scripts always come first
 * when present, because the checks a plan names have to be the repository's real ones.
 */
export function selectRepositoryContext(
  files: readonly RepositoryFile[],
  query: string,
  maxChars = DEFAULT_MAX_CHARS,
): ContextSection[] {
  const sections = files.flatMap(chunk);
  if (sections.length === 0) return [];
  const scripts = sections.filter((section) => section.label.endsWith(' scripts'));
  const prose = sections.filter((section) => !section.label.endsWith(' scripts'));
  const documentFrequency = new Map<string, number>();
  const sectionTerms = prose.map(
    (section) => new Set(terms(`${section.label} ${section.content}`)),
  );
  for (const set of sectionTerms)
    for (const term of set) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const queryTerms = new Set(terms(query));
  const scored = prose
    .map((section, index) => {
      let score = 0;
      for (const term of queryTerms)
        if (sectionTerms[index]!.has(term))
          score += Math.log(1 + prose.length / (documentFrequency.get(term) ?? 1));
      return { section, score, index };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: ContextSection[] = [];
  let used = 0;
  for (const section of [...scripts, ...scored.map((entry) => entry.section)]) {
    if (used + section.content.length > maxChars) continue;
    chosen.push(section);
    used += section.content.length;
  }
  return chosen;
}

/** Reads the convention files from a worktree; a missing or unreadable file is skipped. */
export async function readConventionFiles(workspace: string): Promise<RepositoryFile[]> {
  const files: RepositoryFile[] = [];
  for (const path of CONVENTION_FILES) {
    try {
      files.push({ path, content: await readFile(join(workspace, path), 'utf8') });
    } catch {
      // not every repository has every file
    }
  }
  return files;
}
