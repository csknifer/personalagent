declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  interface MarkedTerminalOptions {
    reflowText?: boolean;
    tab?: number;
    width?: number;
  }

  export function markedTerminal(options?: MarkedTerminalOptions): MarkedExtension;
}
