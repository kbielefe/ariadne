// Partial edits to a node body, so an update doesn't have to re-send the whole thing.
//
// A section is a markdown heading line plus everything up to the next heading of the same or a higher level
// (headings inside ``` fences don't count).

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;

/** "## Log" → { level: 2, text: "Log" }; plain "Log" means a level-2 heading. */
function parseHeading(heading: string): { level: number; text: string; line: string } {
  const h = heading.trim();
  const m = HEADING.exec(h);
  if (m) return { level: m[1]!.length, text: m[2]!, line: `${m[1]} ${m[2]}` };
  return { level: 2, text: h, line: `## ${h}` };
}

/** Joins two chunks of markdown with one blank line between them. */
function join(a: string, b: string): string {
  const head = a.replace(/\s+$/, '');
  const tail = b.replace(/^\s*\n/, '').replace(/\s+$/, '');
  if (!head) return tail;
  if (!tail) return head;
  return `${head}\n\n${tail}`;
}

/** [start, end) line range of the section's content (after its heading line), or null if there is no such heading. */
function findSection(lines: string[], level: number, text: string): { heading: number; end: number } | null {
  let fenced = false;
  let found = -1;
  for (const [i, line] of lines.entries()) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = HEADING.exec(line);
    if (!m) continue;
    if (found >= 0 && m[1]!.length <= level) return { heading: found, end: i };
    if (found < 0 && m[1]!.length === level && m[2] === text) found = i;
  }
  return found >= 0 ? { heading: found, end: lines.length } : null;
}

export interface BodyPatch {
  /** Replace the whole body, or with `section` that section's content. */
  body?: string;
  /** Append to the end of the body, or with `section` to the end of that section. */
  append?: string;
  /** A heading such as "## Log". Created at the end of the body if it isn't there. */
  section?: string;
}

/** The new body, or undefined when the patch doesn't touch the body. */
export function patchBody(current: string, p: BodyPatch): string | undefined {
  if (p.body != null && p.append != null) throw new Error('give body or append, not both');
  if (p.section == null) return p.append != null ? join(current, p.append) : p.body;
  if (p.body == null && p.append == null) throw new Error('section needs body (replace it) or append');
  const h = parseHeading(p.section);
  const lines = current.split('\n');
  const s = findSection(lines, h.level, h.text);
  if (!s) return join(current, `${h.line}\n\n${(p.body ?? p.append!).trim()}`.trim());
  const content = lines.slice(s.heading + 1, s.end).join('\n');
  const next = p.body != null ? p.body : join(content, p.append!);
  const section = join(lines[s.heading]!, next);
  const after = lines.slice(s.end).join('\n');
  return join(join(lines.slice(0, s.heading).join('\n'), section), after);
}
