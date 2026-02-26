import { readFile, writeFile, readdir, unlink, mkdir } from 'fs/promises';
import { join } from 'path';

export interface MemoryNote {
  id: string;
  tags: string[];
  source: string;
  strength: number;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  content: string;
}

export interface WriteOptions {
  id: string;
  content: string;
  tags: string[];
  source: string;
}

export interface ReadOptions {
  reinforce?: boolean;
}

function serializeNote(note: MemoryNote): string {
  const frontmatter = [
    '---',
    `id: ${note.id}`,
    `tags: [${note.tags.join(', ')}]`,
    `source: ${note.source}`,
    `strength: ${note.strength.toFixed(4)}`,
    `createdAt: ${note.createdAt}`,
    `lastAccessed: ${note.lastAccessed}`,
    `accessCount: ${note.accessCount}`,
    '---',
  ].join('\n');
  return `${frontmatter}\n\n${note.content}\n`;
}

function parseNote(raw: string): MemoryNote {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error('Invalid note format: missing frontmatter');
  }

  const frontmatter = fmMatch[1];
  const content = fmMatch[2].trimEnd();

  const get = (key: string): string => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  const tagsRaw = get('tags');
  const tagsMatch = tagsRaw.match(/\[([^\]]*)\]/);
  const tags = tagsMatch
    ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
    : [];

  return {
    id: get('id'),
    tags,
    source: get('source'),
    strength: parseFloat(get('strength')),
    createdAt: get('createdAt'),
    lastAccessed: get('lastAccessed'),
    accessCount: parseInt(get('accessCount'), 10),
    content,
  };
}

export class MemoryStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.md`);
  }

  async write(options: WriteOptions): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const note: MemoryNote = {
      id: options.id,
      tags: options.tags,
      source: options.source,
      strength: 1.0,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
      content: options.content,
    };
    await writeFile(this.filePath(options.id), serializeNote(note), 'utf-8');
  }

  async read(id: string, options?: ReadOptions): Promise<MemoryNote | null> {
    try {
      const raw = await readFile(this.filePath(id), 'utf-8');
      const note = parseNote(raw);

      if (options?.reinforce) {
        note.strength = Math.min(1.0, note.strength + 0.3);
        note.lastAccessed = new Date().toISOString();
        note.accessCount += 1;
        await writeFile(this.filePath(id), serializeNote(note), 'utf-8');
      }

      return note;
    } catch {
      return null;
    }
  }

  async queryByTags(tags: string[]): Promise<MemoryNote[]> {
    const all = await this.list();
    const tagSet = new Set(tags);
    return all.filter(note => note.tags.some(t => tagSet.has(t)));
  }

  async list(): Promise<MemoryNote[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }

    const notes: MemoryNote[] = [];
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const raw = await readFile(join(this.dir, file), 'utf-8');
        notes.push(parseNote(raw));
      } catch {
        // skip malformed files
      }
    }

    notes.sort((a, b) => b.strength - a.strength);
    return notes;
  }

  async applyDecay(factor: number): Promise<void> {
    const files = await readdir(this.dir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const path = join(this.dir, file);
      try {
        const raw = await readFile(path, 'utf-8');
        const note = parseNote(raw);
        note.strength = note.strength * factor;
        await writeFile(path, serializeNote(note), 'utf-8');
      } catch {
        // skip malformed files
      }
    }
  }

  async prune(threshold: number): Promise<number> {
    const files = await readdir(this.dir);
    let pruned = 0;
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const path = join(this.dir, file);
      try {
        const raw = await readFile(path, 'utf-8');
        const note = parseNote(raw);
        if (note.strength < threshold) {
          await unlink(path);
          pruned++;
        }
      } catch {
        // skip malformed files
      }
    }
    return pruned;
  }
}
