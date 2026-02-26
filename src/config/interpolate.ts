/**
 * Environment variable interpolation for config values
 */

/**
 * Interpolates environment variables in a string
 * Supports ${VAR_NAME} syntax
 */
export function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue !== undefined) {
      return envValue;
    }
    // Return empty string if env var not found (don't leave the placeholder)
    return '';
  });
}

/**
 * Recursively interpolates environment variables in an object
 */
export function interpolateConfig<T>(obj: T): T {
  if (typeof obj === 'string') {
    return interpolateEnvVars(obj) as T;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => interpolateConfig(item)) as T;
  }
  
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateConfig(value);
    }
    return result as T;
  }
  
  return obj;
}

/**
 * Expands ~ to home directory in paths
 */
export function expandPath(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return filePath.replace(/^~/, home);
  }
  return filePath;
}

/**
 * Expands all paths in config
 */
export function expandConfigPaths<T>(obj: T, pathKeys: Set<string> = new Set(['file', 'historyFile', 'paths'])): T {
  if (typeof obj === 'string') {
    return obj as T;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => {
      if (typeof item === 'string') {
        return expandPath(item);
      }
      return expandConfigPaths(item, pathKeys);
    }) as T;
  }
  
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (pathKeys.has(key) && typeof value === 'string') {
        result[key] = expandPath(value);
      } else if (pathKeys.has(key) && Array.isArray(value)) {
        result[key] = value.map(v => typeof v === 'string' ? expandPath(v) : v);
      } else {
        result[key] = expandConfigPaths(value, pathKeys);
      }
    }
    return result as T;
  }
  
  return obj;
}
