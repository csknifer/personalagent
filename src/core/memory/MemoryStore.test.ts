import { MemoryStore } from './MemoryStore.js';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('MemoryStore', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memtest-'));
    store = new MemoryStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('should write and read a memory note', async () => {
    await store.write({ id: 'test-1', content: 'Web search works best with specific queries.', tags: ['strategy', 'web-search'], source: 'task-execution' });
    const note = await store.read('test-1');
    expect(note).not.toBeNull();
    expect(note!.content).toContain('Web search');
    expect(note!.tags).toContain('strategy');
    expect(note!.strength).toBe(1.0);
  });

  it('should query by tags', async () => {
    await store.write({ id: 'note-1', content: 'About web', tags: ['web-search', 'strategy'], source: 'exec' });
    await store.write({ id: 'note-2', content: 'About files', tags: ['file-ops', 'strategy'], source: 'exec' });
    const results = await store.queryByTags(['web-search']);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('note-1');
  });

  it('should reinforce strength on access', async () => {
    await store.write({ id: 'note-1', content: 'Important', tags: ['pattern'], source: 'exec' });
    await store.applyDecay(0.5);
    let note = await store.read('note-1');
    expect(note!.strength).toBeCloseTo(0.5);
    note = await store.read('note-1', { reinforce: true });
    expect(note!.strength).toBeGreaterThan(0.5);
  });

  it('should list notes sorted by strength', async () => {
    await store.write({ id: 'weak', content: 'Old', tags: [], source: 'test' });
    await store.write({ id: 'strong', content: 'New', tags: [], source: 'test' });
    await store.applyDecay(0.3);
    await store.read('strong', { reinforce: true });
    const all = await store.list();
    expect(all[0].id).toBe('strong');
    expect(all[0].strength).toBeGreaterThan(all[1].strength);
  });

  it('should prune notes below threshold', async () => {
    await store.write({ id: 'note-1', content: 'Will decay', tags: [], source: 'test' });
    await store.applyDecay(0.05);
    const pruned = await store.prune(0.1);
    expect(pruned).toBe(1);
    expect(await store.read('note-1')).toBeNull();
  });

  it('should return null for non-existent notes', async () => {
    expect(await store.read('does-not-exist')).toBeNull();
  });
});
