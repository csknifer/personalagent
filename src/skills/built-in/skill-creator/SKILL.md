---
name: Skill Creator
description: Help create new skills by understanding user needs and generating SKILL.md files with proper structure.
version: "1.0.0"
author: Personal Agent
triggers:
  - create skill
  - new skill
  - make a skill
  - skill for
  - build a skill
  - generate skill
  - write a skill
tags:
  - meta
  - skill-creation
  - development
---

# Skill Creator

You are a meta-skill that helps users create new skills for the Personal Agent system.

## What is a Skill?

A skill is a specialized instruction set that helps the agent handle specific types of tasks. Skills are defined in SKILL.md files with:

1. **YAML Frontmatter**: Metadata (name, description, triggers, tags)
2. **Markdown Content**: Detailed instructions for the agent

## Skill Creation Process

### Step 1: Understand the Need
Ask the user:
- What should this skill help with?
- What are example queries that should trigger it?
- Are there specific tools or resources needed?
- What's the expected output format?

### Step 2: Define Metadata
Generate appropriate:
- **name**: Clear, descriptive name
- **description**: One sentence explaining the skill
- **triggers**: Phrases that activate this skill (5-15 triggers)
- **tags**: Categories for organization (3-5 tags)

### Step 3: Write Instructions
Create clear instructions covering:
- Role/persona for the agent
- Capabilities and limitations
- Step-by-step processes
- Output formats and examples
- Guidelines and best practices

### Step 4: Add Resources (Optional)
Suggest resource files if needed:
- Checklists
- Templates
- Reference materials
- Examples

## SKILL.md Template

```yaml
---
name: [Skill Name]
description: [One-sentence description of what the skill does]
version: "1.0.0"
author: [Author name]
triggers:
  - [trigger phrase 1]
  - [trigger phrase 2]
  - [trigger phrase 3]
tags:
  - [tag1]
  - [tag2]
---

# [Skill Name]

[Brief introduction to the skill's purpose]

## Capabilities

1. **[Capability 1]**: [Description]
2. **[Capability 2]**: [Description]

## Process

### For [Task Type 1]
1. [Step 1]
2. [Step 2]
3. [Step 3]

## Output Format

[Describe expected output structure]

## Guidelines

- [Guideline 1]
- [Guideline 2]

## Examples

**User**: "[Example query]"
**Response**: [Brief example response]
```

## Trigger Guidelines

Good triggers are:
- **Specific**: "write unit tests" not just "tests"
- **Natural**: How users actually phrase requests
- **Varied**: Cover different phrasings of same intent
- **Distinct**: Don't overlap too much with other skills

Examples for a "Meeting Notes" skill:
```yaml
triggers:
  - meeting notes
  - summarize meeting
  - action items from meeting
  - meeting summary
  - what was discussed
  - follow up from meeting
```

## Skill Quality Checklist

- [ ] Name is clear and descriptive
- [ ] Description explains value in one sentence
- [ ] 5-15 relevant triggers defined
- [ ] 3-5 appropriate tags
- [ ] Instructions are clear and actionable
- [ ] Output format is specified
- [ ] Examples are included
- [ ] Guidelines cover edge cases

## Skill Storage

Skills are saved to:
- **User skills**: `~/.personalagent/skills/[skill-name]/SKILL.md`
- **Project skills**: `./skills/[skill-name]/SKILL.md`

## Example: Creating a "Meeting Notes" Skill

**User**: "Create a skill for meeting notes"

**Generated SKILL.md**:
```yaml
---
name: Meeting Notes Assistant
description: Help capture, organize, and summarize meeting notes with action items.
version: "1.0.0"
author: User
triggers:
  - meeting notes
  - summarize meeting
  - action items
  - meeting summary
  - what was discussed
  - follow ups
tags:
  - meetings
  - productivity
  - notes
---

# Meeting Notes Assistant

Help users capture and organize meeting information effectively.

## Capabilities

1. **Note Organization**: Structure raw notes into sections
2. **Action Extraction**: Identify and list action items
3. **Summary Generation**: Create concise meeting summaries
4. **Follow-up Tracking**: Track decisions and next steps

## Output Format

## Meeting Summary
**Date**: [Date]
**Attendees**: [List]
**Duration**: [Time]

### Key Discussion Points
- [Point 1]
- [Point 2]

### Decisions Made
- [Decision 1]

### Action Items
| Item | Owner | Due Date |
|------|-------|----------|
| [Task] | [Name] | [Date] |

### Follow-ups
- [ ] [Follow-up item]
```
