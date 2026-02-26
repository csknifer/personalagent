/**
 * Skill Manager - CRUD operations for skills
 */

import { readFile, writeFile, readdir, mkdir, rm, stat, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Skill, SkillMetadata, SkillLoader } from './SkillLoader.js';

export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
}

export interface CreateSkillOptions {
  name: string;
  description: string;
  triggers?: string[];
  tags?: string[];
  content?: string;
  template?: string;
  targetPath?: string;
}

export interface SkillInstallResult {
  success: boolean;
  skill?: Skill;
  error?: string;
}

export class SkillManager {
  private skillLoader: SkillLoader;
  private userSkillsPath: string;

  constructor(skillLoader: SkillLoader, userSkillsPath?: string) {
    this.skillLoader = skillLoader;
    // Default to ~/.personalagent/skills
    this.userSkillsPath = userSkillsPath || this.expandPath('~/.personalagent/skills');
  }

  /**
   * List all available skills
   */
  listSkills(): Skill[] {
    return this.skillLoader.getAllSkills();
  }

  /**
   * Get a specific skill by ID
   */
  getSkill(id: string): Skill | undefined {
    return this.skillLoader.getSkill(id);
  }

  /**
   * Search skills by query
   */
  searchSkills(query: string): Skill[] {
    return this.skillLoader.matchSkills(query);
  }

  /**
   * Create a new skill
   */
  async createSkill(options: CreateSkillOptions): Promise<SkillInstallResult> {
    try {
      const skillId = this.slugify(options.name);
      const targetPath = options.targetPath || join(this.userSkillsPath, skillId);

      // Check if skill already exists
      if (existsSync(targetPath)) {
        return {
          success: false,
          error: `Skill directory already exists: ${targetPath}`,
        };
      }

      // Create skill directory
      await mkdir(targetPath, { recursive: true });

      // Get content from template or generate
      let content: string;
      if (options.template) {
        const template = this.getTemplate(options.template);
        if (!template) {
          return {
            success: false,
            error: `Unknown template: ${options.template}`,
          };
        }
        content = this.applyTemplate(template, options);
      } else if (options.content) {
        content = options.content;
      } else {
        content = this.generateSkillContent(options);
      }

      // Write SKILL.md
      const skillFile = join(targetPath, 'SKILL.md');
      await writeFile(skillFile, content, 'utf-8');

      // Re-discover skills to load the new one
      await this.skillLoader.discoverSkills();

      const skill = this.skillLoader.getSkill(skillId);
      return {
        success: true,
        skill,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Update an existing skill
   */
  async updateSkill(id: string, updates: { content?: string; metadata?: Partial<SkillMetadata> }): Promise<SkillInstallResult> {
    try {
      const skill = this.skillLoader.getSkill(id);
      if (!skill) {
        return {
          success: false,
          error: `Skill not found: ${id}`,
        };
      }

      // Load full skill if not already loaded
      const loadedSkill = await this.skillLoader.loadSkill(id);
      if (!loadedSkill || !loadedSkill.content) {
        return {
          success: false,
          error: `Could not load skill: ${id}`,
        };
      }

      let newContent: string;
      
      if (updates.content) {
        newContent = updates.content;
      } else if (updates.metadata) {
        // Update just the frontmatter
        newContent = this.updateFrontmatter(loadedSkill.content, updates.metadata);
      } else {
        return {
          success: false,
          error: 'No updates provided',
        };
      }

      // Write updated content
      const skillFile = join(skill.path, 'SKILL.md');
      await writeFile(skillFile, newContent, 'utf-8');

      // Re-discover to reload
      await this.skillLoader.discoverSkills();

      return {
        success: true,
        skill: this.skillLoader.getSkill(id),
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Delete a skill
   */
  async deleteSkill(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      const skill = this.skillLoader.getSkill(id);
      if (!skill) {
        return {
          success: false,
          error: `Skill not found: ${id}`,
        };
      }

      // Safety check: don't delete built-in skills
      if (skill.path.includes('built-in')) {
        return {
          success: false,
          error: 'Cannot delete built-in skills',
        };
      }

      // Remove skill directory
      await rm(skill.path, { recursive: true, force: true });

      // Re-discover skills
      await this.skillLoader.discoverSkills();

      return { success: true };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Install a skill from a GitHub repository
   */
  async installFromGitHub(repo: string, branch: string = 'main'): Promise<SkillInstallResult> {
    try {
      // Construct raw GitHub URL
      // Expected format: owner/repo or owner/repo/path/to/skill
      const parts = repo.split('/');
      if (parts.length < 2) {
        return {
          success: false,
          error: 'Invalid repository format. Use: owner/repo or owner/repo/path/to/skill',
        };
      }

      const owner = parts[0];
      const repoName = parts[1];
      const skillPath = parts.slice(2).join('/') || '';
      
      const baseUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}`;
      const skillMdUrl = skillPath 
        ? `${baseUrl}/${skillPath}/SKILL.md`
        : `${baseUrl}/SKILL.md`;

      // Fetch SKILL.md content
      const response = await fetch(skillMdUrl);
      if (!response.ok) {
        return {
          success: false,
          error: `Could not fetch SKILL.md from ${skillMdUrl}: ${response.statusText}`,
        };
      }

      const content = await response.text();

      // Parse to get skill name
      const metadata = this.parseSkillContent(content);
      if (!metadata) {
        return {
          success: false,
          error: 'Could not parse skill metadata from SKILL.md',
        };
      }

      // Create skill directory
      const skillId = this.slugify(metadata.name);
      const targetPath = join(this.userSkillsPath, skillId);

      if (existsSync(targetPath)) {
        return {
          success: false,
          error: `Skill already exists: ${skillId}. Remove it first to reinstall.`,
        };
      }

      await mkdir(targetPath, { recursive: true });

      // Write SKILL.md
      await writeFile(join(targetPath, 'SKILL.md'), content, 'utf-8');

      // TODO: Also fetch resources/ directory if it exists

      // Re-discover skills
      await this.skillLoader.discoverSkills();

      return {
        success: true,
        skill: this.skillLoader.getSkill(skillId),
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Export a skill to a file
   */
  async exportSkill(id: string): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const skill = await this.skillLoader.loadSkill(id);
      if (!skill || !skill.content) {
        return {
          success: false,
          error: `Skill not found or could not be loaded: ${id}`,
        };
      }

      // For now, just return the SKILL.md content
      // TODO: Support exporting as zip with resources
      return {
        success: true,
        content: skill.content,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get available skill templates
   */
  getTemplates(): SkillTemplate[] {
    return [
      {
        id: 'basic',
        name: 'Basic Skill',
        description: 'Minimal skill with triggers and instructions',
        content: this.basicTemplate(),
      },
      {
        id: 'research',
        name: 'Research Skill',
        description: 'Research-focused skill with web search integration',
        content: this.researchTemplate(),
      },
      {
        id: 'coding',
        name: 'Coding Skill',
        description: 'Code-focused skill with file system tools',
        content: this.codingTemplate(),
      },
      {
        id: 'workflow',
        name: 'Workflow Skill',
        description: 'Multi-step workflow with checkpoints',
        content: this.workflowTemplate(),
      },
    ];
  }

  /**
   * Get a specific template
   */
  getTemplate(id: string): SkillTemplate | undefined {
    return this.getTemplates().find(t => t.id === id);
  }

  // ============ Private Helper Methods ============

  private expandPath(filePath: string): string {
    if (filePath.startsWith('~/') || filePath === '~') {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      return filePath.replace(/^~/, home);
    }
    return filePath;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private generateSkillContent(options: CreateSkillOptions): string {
    const metadata = {
      name: options.name,
      description: options.description,
      version: '1.0.0',
      author: 'User',
      triggers: options.triggers || [options.name.toLowerCase()],
      tags: options.tags || ['custom'],
    };

    const frontmatter = stringifyYaml(metadata);
    const body = `# ${options.name}

${options.description}

## Capabilities

1. [Describe capability 1]
2. [Describe capability 2]

## Process

1. [Step 1]
2. [Step 2]

## Output Format

[Describe expected output]

## Guidelines

- [Add guidelines here]
`;

    return `---\n${frontmatter}---\n\n${body}`;
  }

  private applyTemplate(template: SkillTemplate, options: CreateSkillOptions): string {
    return template.content
      .replace(/\[SKILL_NAME\]/g, options.name)
      .replace(/\[SKILL_DESCRIPTION\]/g, options.description)
      .replace(/\[SKILL_TRIGGERS\]/g, (options.triggers || [options.name.toLowerCase()]).map(t => `  - ${t}`).join('\n'))
      .replace(/\[SKILL_TAGS\]/g, (options.tags || ['custom']).map(t => `  - ${t}`).join('\n'));
  }

  private parseSkillContent(content: string): SkillMetadata | null {
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return null;

    try {
      const yaml = parseYaml(frontmatterMatch[1]) as Record<string, unknown>;
      return {
        name: String(yaml.name || 'Unnamed Skill'),
        description: String(yaml.description || ''),
        version: yaml.version ? String(yaml.version) : undefined,
        author: yaml.author ? String(yaml.author) : undefined,
        triggers: Array.isArray(yaml.triggers) ? yaml.triggers.map(String) : undefined,
        tags: Array.isArray(yaml.tags) ? yaml.tags.map(String) : undefined,
      };
    } catch {
      return null;
    }
  }

  private updateFrontmatter(content: string, updates: Partial<SkillMetadata>): string {
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return content;

    try {
      const existing = parseYaml(frontmatterMatch[1]) as Record<string, unknown>;
      const updated = { ...existing, ...updates };
      const newFrontmatter = stringifyYaml(updated);
      return content.replace(/^---\s*\n[\s\S]*?\n---/, `---\n${newFrontmatter}---`);
    } catch {
      return content;
    }
  }

  // ============ Template Definitions ============

  private basicTemplate(): string {
    return `---
name: [SKILL_NAME]
description: [SKILL_DESCRIPTION]
version: "1.0.0"
author: User
triggers:
[SKILL_TRIGGERS]
tags:
[SKILL_TAGS]
---

# [SKILL_NAME]

[SKILL_DESCRIPTION]

## Capabilities

1. **[Capability 1]**: [Description]
2. **[Capability 2]**: [Description]

## Process

1. [Step 1]
2. [Step 2]
3. [Step 3]

## Output Format

[Describe the expected output structure]

## Guidelines

- [Guideline 1]
- [Guideline 2]
`;
  }

  private researchTemplate(): string {
    return `---
name: [SKILL_NAME]
description: [SKILL_DESCRIPTION]
version: "1.0.0"
author: User
triggers:
[SKILL_TRIGGERS]
tags:
[SKILL_TAGS]
---

# [SKILL_NAME]

[SKILL_DESCRIPTION]

## Capabilities

1. **Web Search**: Search for relevant information
2. **Source Analysis**: Evaluate source credibility
3. **Synthesis**: Combine findings into coherent summaries
4. **Citation**: Properly cite all sources

## Process

1. Understand the research question
2. Use \`web_search\` to find relevant sources
3. Evaluate source quality and relevance
4. Extract key information
5. Synthesize findings
6. Cite sources

## Output Format

## Summary
[Brief overview]

## Key Findings
- Finding 1
- Finding 2

## Sources
1. [Source 1](URL)
2. [Source 2](URL)

## Guidelines

- Verify information across multiple sources
- Prioritize authoritative and recent sources
- Be transparent about uncertainty
`;
  }

  private codingTemplate(): string {
    return `---
name: [SKILL_NAME]
description: [SKILL_DESCRIPTION]
version: "1.0.0"
author: User
triggers:
[SKILL_TRIGGERS]
tags:
[SKILL_TAGS]
---

# [SKILL_NAME]

[SKILL_DESCRIPTION]

## Capabilities

1. **Code Analysis**: Read and understand existing code
2. **Code Generation**: Write clean, documented code
3. **File Operations**: Create and modify files

## Tools Available

- \`read_file\` - Read file contents
- \`write_file\` - Create or update files
- \`list_directory\` - Explore project structure

## Process

1. Understand the requirements
2. Analyze existing code if applicable
3. Plan the implementation
4. Write clean, documented code
5. Verify the solution

## Output Format

1. **Understanding**: Restate the task
2. **Approach**: Explain the solution
3. **Code**: The implementation
4. **Explanation**: Why this works

## Guidelines

- Follow language conventions
- Include error handling
- Add helpful comments
- Consider edge cases
`;
  }

  private workflowTemplate(): string {
    return `---
name: [SKILL_NAME]
description: [SKILL_DESCRIPTION]
version: "1.0.0"
author: User
triggers:
[SKILL_TRIGGERS]
tags:
[SKILL_TAGS]
---

# [SKILL_NAME]

[SKILL_DESCRIPTION]

## Workflow Steps

### Step 1: [Step Name]
**Goal**: [What this step accomplishes]
**Actions**:
- [Action 1]
- [Action 2]
**Checkpoint**: [How to verify completion]

### Step 2: [Step Name]
**Goal**: [What this step accomplishes]
**Actions**:
- [Action 1]
- [Action 2]
**Checkpoint**: [How to verify completion]

### Step 3: [Step Name]
**Goal**: [What this step accomplishes]
**Actions**:
- [Action 1]
- [Action 2]
**Checkpoint**: [How to verify completion]

## Error Handling

- If Step X fails: [Recovery action]
- If user needs clarification: [Ask specific questions]

## Output Format

## Workflow Progress

- [x] Step 1: [Status]
- [ ] Step 2: [Status]
- [ ] Step 3: [Status]

## Current Step Details
[Details about current step]

## Next Actions
[What happens next]
`;
  }
}

/**
 * Create a skill manager instance
 */
export function createSkillManager(skillLoader: SkillLoader, userSkillsPath?: string): SkillManager {
  return new SkillManager(skillLoader, userSkillsPath);
}
