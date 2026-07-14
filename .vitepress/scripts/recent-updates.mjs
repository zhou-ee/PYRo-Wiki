import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dynamically import gray-matter (it's a CJS module, but works with createRequire or dynamic import)
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUTPUT = join(ROOT, 'public', 'recent-updates.json');
const MAX_ENTRIES = 8;

/**
 * URL path segment → Chinese display name.
 * Each segment of a file's directory path is translated independently,
 * then joined with " / " to form a breadcrumb.
 *
 * e.g. "Course/others/git_submodules.md"
 *      → dir segments: ["Course", "others"]
 *      → translated:   ["教程",   "其他"]
 *      → breadcrumb:   "教程 / 其他"
 *
 * Segments not in this map are kept as-is (e.g. "Algorithm").
 */
const SEGMENT_NAMES = {
  // Top-level
  // PYRo-uCtrl-Unity is kept as its original name (no translation)
  'Course':            '教程',
  'about_us':          '关于我们',
  // Course sub-sections
  'embedded':   '嵌入式',
  'front-end':  '前端',
  'others':     '其他',
  // Course/embedded sub-sections
  'dev_tools':  '开发工具',
  'vscode':     'Vscode工作流',
  'third_party': '第三方库',
  // PYRo-uCtrl-Unity sub-sections
  'notice_before_start': '开发须知',
};

function fileToSection(file) {
  // "Course/others/git_submodules.md" → ["Course", "others"]
  const parts = file.replace(/\\/g, '/').replace(/\.md$/, '').split('/');
  // Drop the filename, keep only directory segments
  const dirs = parts.slice(0, -1);
  if (dirs.length === 0) return '';

  const translated = dirs.map((seg) => SEGMENT_NAMES[seg] || seg);
  return translated.join(' / ');
}

// Exclude: index.md (homepage), about_us/index.md (another home layout page)
const EXCLUDE_PATTERNS = [
  /^index\.md$/,
  /^about_us\/index\.md$/,
];

/**
 * Simple frontmatter parser — extracts the "title" field from YAML-like frontmatter.
 * Falls back to gray-matter if available, otherwise uses a basic regex.
 */
function extractTitle(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');

    // Try to extract frontmatter title with a simple regex first
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const titleMatch = fmMatch[1].match(/^title:\s*(.+)$/m);
      if (titleMatch) {
        return titleMatch[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }

    // Fall back to the first # heading
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      return headingMatch[1].trim();
    }
  } catch {
    // If file can't be read, skip it
    return null;
  }

  // Last resort: use the filename without extension
  const basename = filePath.replace(/^.*[\\/]/, '').replace(/\.md$/, '');
  return basename;
}

/**
 * Convert a file path (relative to repo root) to a VitePress URL.
 * - Remove .md extension
 * - index.md becomes directory root
 * - Normalize backslashes to forward slashes
 */
function fileToUrl(file) {
  return '/' + file
    .replace(/\\/g, '/')
    .replace(/(^|\/)index\.md$/, '$1')
    .replace(/\.md$/, '');
}

function getRecentDocs() {
  try {
    // git log: get commit timestamps (UNIX epoch) and changed file names
    // --diff-filter=AM: only Added or Modified files
    // Using %at for UNIX timestamp (simpler to parse)
    const format = '--pretty=format:%at';
    const output = execSync(
      `git log ${format} --name-only --diff-filter=AM -- "*.md"`,
      { cwd: ROOT, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );

    // Parse output: each commit starts with a timestamp line, followed by file names
    const fileTimestamps = new Map();
    let currentTimestamp = 0;

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      // Check if this line is a UNIX timestamp (all digits, 10 chars for epoch)
      if (/^\d{10}$/.test(trimmed)) {
        currentTimestamp = parseInt(trimmed, 10) * 1000; // Convert to milliseconds
      } else if (currentTimestamp > 0 && trimmed.endsWith('.md')) {
        // Only record the FIRST (most recent) timestamp for each file
        if (!fileTimestamps.has(trimmed)) {
          fileTimestamps.set(trimmed, currentTimestamp);
        }
      }
    }

    const results = [];
    for (const [file, ts] of fileTimestamps) {
      // Skip excluded files
      if (EXCLUDE_PATTERNS.some((p) => p.test(file))) continue;

      const fullPath = join(ROOT, file);
      const title = extractTitle(fullPath);
      if (!title) continue; // Skip unreadable files

      results.push({
        title,
        url: fileToUrl(file),
        file,
        section: fileToSection(file),
        lastModified: ts,
      });
    }

    // Sort by most recently modified first
    results.sort((a, b) => b.lastModified - a.lastModified);
    return results.slice(0, MAX_ENTRIES);
  } catch (err) {
    console.error('[recent-updates] Error running git log:', err.message);
    return [];
  }
}

const data = getRecentDocs();
writeFileSync(OUTPUT, JSON.stringify(data, null, 2), 'utf-8');
console.log(`[recent-updates] Generated ${data.length} entries -> ${OUTPUT}`);
