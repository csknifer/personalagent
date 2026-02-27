import { resolve, sep } from 'path';
import { isPathInsideDir } from './index.js';

describe('isPathInsideDir', () => {
  const baseDir = resolve('/srv/static');

  it('allows normal paths inside dir', () => {
    expect(isPathInsideDir(resolve('/srv/static/index.html'), baseDir)).toBe(true);
    expect(isPathInsideDir(resolve('/srv/static/assets/app.js'), baseDir)).toBe(true);
    expect(isPathInsideDir(resolve('/srv/static/deep/nested/file.css'), baseDir)).toBe(true);
  });

  it('blocks ../ traversal paths', () => {
    expect(isPathInsideDir(resolve('/srv/static/../../etc/passwd'), baseDir)).toBe(false);
    expect(isPathInsideDir(resolve('/srv/static/../secret.txt'), baseDir)).toBe(false);
    expect(isPathInsideDir(resolve('/etc/passwd'), baseDir)).toBe(false);
  });

  it('blocks exact parent', () => {
    expect(isPathInsideDir(resolve('/srv'), baseDir)).toBe(false);
  });

  it('allows the dir itself', () => {
    expect(isPathInsideDir(baseDir, baseDir)).toBe(true);
  });

  it('blocks paths that share a prefix but are not inside the dir', () => {
    // e.g. /srv/static-evil/malicious.js should NOT match /srv/static
    expect(isPathInsideDir(resolve('/srv/static-evil/malicious.js'), baseDir)).toBe(false);
  });
});
