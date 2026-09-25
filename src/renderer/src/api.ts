export interface HfBridge {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  on(channel: 'hf:events' | 'hf:pty' | 'hf:exit', fn: (payload: never) => void): () => void;
  platform: string;
}
declare global {
  interface Window {
    hf: HfBridge;
  }
}
export const hf = (): HfBridge => window.hf;
