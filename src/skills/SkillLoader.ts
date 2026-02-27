/**
 * Skill Loader - Discovers and loads skills following the Anthropic Agent Skills standard
 */

import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import { parse as parseYaml } from 'yaml';

export interface SkillMetadata {
  name: string;
  description: string;
  version?: string;
  author?: string;
  triggers?: string[];
  tags?: string[];
}

export interface Skill {
  id: string;
  path: string;
  metadata: SkillMetadata;
  content?: string;
  scripts?: Map<string, string>;
  resources?: Map<string, string>;
  loaded: boolean;
}

interface SkillLoaderOptions {
  paths: string[];
  autoDiscover?: boolean;
}

const SKILL_FILE = 'SKILL.md';

export class SkillLoader {
  private skillPaths: string[];
  private skills: Map<string, Skill> = new Map();
  private autoDiscover: boolean;

  constructor(options: SkillLoaderOptions) {
    this.skillPaths = options.paths.map(p => resolve(this.expandPath(p)));
    this.autoDiscover = options.autoDiscover ?? true;
  }

  /**
   * Discover all skills in configured paths
   */
  async discoverSkills(): Promise<Skill[]> {
    const discovered: Skill[] = [];

    for (const basePath of this.skillPaths) {
      if (!existsSync(basePath)) {
        continue;
      }

      try {
        const entries = await readdir(basePath, { withFileTypes: true });
        
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillPath = join(basePath, entry.name);
            const skill = await this.loadSkillMetadata(skillPath);
            
            if (skill) {
              discovered.push(skill);
              this.skills.set(skill.id, skill);
            }
          }
        }
      } catch (error) {
        // Skip inaccessible paths
        continue;
      }
    }

    return discovered;
  }

  /**
   * Load skill metadata from a skill directory
   */
  private async loadSkillMetadata(skillPath: string): Promise<Skill | null> {
    const skillFile = join(skillPath, SKILL_FILE);
    
    if (!existsSync(skillFile)) {
      return null;
    }

    try {
      const content = await readFile(skillFile, 'utf-8');
      const metadata = this.parseSkillFile(content);
      
      if (!metadata) {
        return null;
      }

      const skillId = basename(skillPath);
      
      return {
        id: skillId,
        path: skillPath,
        metadata,
        loaded: false,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Parse a SKILL.md file and extract metadata
   */
  private parseSkillFile(content: string): SkillMetadata | null {
    // Extract YAML frontmatter
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    
    if (frontmatterMatch) {
      try {
        const yaml = parseYaml(frontmatterMatch[1]) as Record<string, unknown>;
        return {
          name: String(yaml.name || 'Unnamed Skill'),
          description: String(yaml.description || ''),
          version: yaml.version ? String(yaml.version) : undefined,
          author: yaml.author ? String(yaml.author) : undefined,
          triggers: Array.isArray(yaml.triggers) 
            ? yaml.triggers.map(String) 
            : undefined,
          tags: Array.isArray(yaml.tags) 
            ? yaml.tags.map(String) 
            : undefined,
        };
      } catch {
        return null;
      }
    }

    // Try to extract metadata from markdown headers
    const nameMatch = content.match(/^#\s+(.+)$/m);
    const descMatch = content.match(/^#\s+.+\n\n(.+)$/m);
    
    if (nameMatch) {
      return {
        name: nameMatch[1].trim(),
        description: descMatch ? descMatch[1].trim() : '',
      };
    }

    return null;
  }

  /**
   * Fully load a skill including its content
   */
  async loadSkill(skillId: string): Promise<Skill | null> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return null;
    }

    if (skill.loaded) {
      return skill;
    }

    try {
      // Load the full SKILL.md content
      const skillFile = join(skill.path, SKILL_FILE);
      skill.content = await readFile(skillFile, 'utf-8');

      // Load scripts
      skill.scripts = new Map();
      const scriptsPath = join(skill.path, 'scripts');
      if (existsSync(scriptsPath)) {
        const scripts = await readdir(scriptsPath);
        for (const script of scripts) {
          const scriptPath = join(scriptsPath, script);
          const stats = await stat(scriptPath);
          if (stats.isFile()) {
            const scriptContent = await readFile(scriptPath, 'utf-8');
            skill.scripts.set(script, scriptContent);
          }
        }
      }

      // Load resources
      skill.resources = new Map();
      const resourcesPath = join(skill.path, 'resources');
      if (existsSync(resourcesPath)) {
        const resources = await readdir(resourcesPath);
        for (const resource of resources) {
          const resourcePath = join(resourcesPath, resource);
          const stats = await stat(resourcePath);
          if (stats.isFile() && stats.size < 1024 * 1024) { // Max 1MB
            const resourceContent = await readFile(resourcePath, 'utf-8');
            skill.resources.set(resource, resourceContent);
          }
        }
      }

      skill.loaded = true;
      return skill;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get a skill by ID
   */
  getSkill(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Get all discovered skills
   */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Match skills to a user query.
   * Uses word-boundary matching for short triggers (≤3 chars) to avoid
   * false positives (e.g., "pr" matching "price").
   * Multi-word triggers and longer triggers use substring matching.
   */
  matchSkills(query: string): Skill[] {
    const queryLower = query.toLowerCase();
    const matches: Skill[] = [];

    for (const skill of this.skills.values()) {
      // Check triggers
      if (skill.metadata.triggers) {
        for (const trigger of skill.metadata.triggers) {
          const triggerLower = trigger.toLowerCase();
          if (this.matchesTrigger(queryLower, triggerLower)) {
            matches.push(skill);
            break;
          }
        }
      }

      // Check individual words from name and description
      if (!matches.includes(skill)) {
        const nameWords = skill.metadata.name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const descWords = skill.metadata.description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const allWords = [...nameWords, ...descWords];
        if (allWords.some(word => this.matchesTrigger(queryLower, word))) {
          matches.push(skill);
        }
      }

      // Check tags (use word-boundary matching for short tags too)
      if (!matches.includes(skill) && skill.metadata.tags) {
        for (const tag of skill.metadata.tags) {
          const tagLower = tag.toLowerCase();
          if (this.matchesTrigger(queryLower, tagLower)) {
            matches.push(skill);
            break;
          }
        }
      }
    }

    return matches;
  }

  /**
   * Match a trigger/tag against a query.
   * Short single-word triggers (≤3 chars) require word boundaries to prevent
   * false positives like "pr" matching "price".
   * Multi-word triggers and longer triggers use simple substring matching.
   */
  private matchesTrigger(query: string, trigger: string): boolean {
    const isMultiWord = trigger.includes(' ');

    if (isMultiWord || trigger.length > 3) {
      // Multi-word triggers or long triggers: substring match is fine
      return query.includes(trigger);
    }

    // Short single-word triggers: require word boundaries
    const pattern = new RegExp(`\\b${this.escapeRegExp(trigger)}\\b`);
    return pattern.test(query);
  }

  /**
   * Escape special regex characters in a string
   */
  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get skill summaries for context injection
   */
  getSkillSummaries(): string {
    const summaries: string[] = [];
    
    for (const skill of this.skills.values()) {
      summaries.push(`- ${skill.metadata.name}: ${skill.metadata.description}`);
    }

    return summaries.join('\n');
  }

  /**
   * Expand ~ to home directory
   */
  private expandPath(filePath: string): string {
    if (filePath.startsWith('~/') || filePath === '~') {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      return filePath.replace(/^~/, home);
    }
    return filePath;
  }
}

/**
 * Create a skill loader with configuration
 */
export function createSkillLoader(paths: string[], autoDiscover = true): SkillLoader {
  return new SkillLoader({ paths, autoDiscover });
}
