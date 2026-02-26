/**
 * HistoryManager - Persistent conversation history to disk
 *
 * Follows the SkillTracker pattern: separate I/O from the pure Memory class.
 * Memory stays fs-free; HistoryManager handles load/save lifecycle.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { Memory } from './queen/Memory.js';

export class HistoryManager {
  private filePath: string;
  private maxMessages: number;
  private isDirty: boolean = false;
  private memory: Memory | null = null;

  constructor(filePath: string, maxMessages: number) {
    this.filePath = filePath;
    this.maxMessages = maxMessages;
  }

  /**
   * Whether a memory instance is currently attached.
   */
  isAttached(): boolean {
    return this.memory !== null;
  }

  /**
   * Link to the Queen's memory instance.
   * Returns false if already attached (caller should skip).
   */
  attach(memory: Memory): boolean {
    if (this.memory !== null) {
      return false;
    }
    this.memory = memory;
    return true;
  }

  /**
   * Load history from disk into the attached memory.
   * Returns true if history was loaded, false if starting fresh.
   */
  async load(): Promise<boolean> {
    if (!this.memory) return false;

    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw);

      // Basic structure validation
      if (!data || !Array.isArray(data.messages)) {
        return false;
      }

      // Rehydrate Date objects
      for (const msg of data.messages) {
        if (msg.timestamp && typeof msg.timestamp === 'string') {
          msg.timestamp = new Date(msg.timestamp);
        }
      }
      if (data.context?.userPreferences && typeof data.context.userPreferences !== 'object') {
        data.context.userPreferences = {};
      }

      this.memory.import(data);
      return true;
    } catch (error: unknown) {
      // File not found = fresh start (not an error)
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      // Corrupt JSON or other issue = warn and start fresh
      console.warn(`\x1b[33m⚠ Could not load history (${this.filePath}): starting fresh.\x1b[0m`);
      return false;
    }
  }

  /**
   * Save current memory state to disk (skip if not dirty).
   */
  async save(): Promise<void> {
    if (!this.memory || !this.isDirty) return;

    try {
      const data = this.memory.export();

      // Trim to maxMessages (keep system + most recent)
      if (data.messages.length > this.maxMessages) {
        const systemMsg = data.messages.find(m => m.role === 'system');
        const nonSystem = data.messages.filter(m => m.role !== 'system');
        const trimmed = nonSystem.slice(-this.maxMessages + (systemMsg ? 1 : 0));
        data.messages = systemMsg ? [systemMsg, ...trimmed] : trimmed;
      }

      // Ensure directory exists
      await mkdir(dirname(this.filePath), { recursive: true });

      await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.isDirty = false;
    } catch (error) {
      console.warn(`\x1b[33m⚠ Could not save history: ${error instanceof Error ? error.message : error}\x1b[0m`);
    }
  }

  /**
   * Flag that memory has changed and needs saving.
   */
  markDirty(): void {
    this.isDirty = true;
  }
}
