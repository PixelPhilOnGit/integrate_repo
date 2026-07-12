/**
 * Type declarations for @tauri-apps/plugin-global-shortcut.
 *
 * This plugin may not be installed in all environments (browser dev, etc.)
 * so we provide fallback declarations to satisfy TypeScript. The actual
 * import happens inside a try-catch and gracefully degrades when the
 * module is unavailable.
 */

declare module '@tauri-apps/plugin-global-shortcut' {
  export type ShortcutAction = 'Pressed' | 'Released';

  export function register(
    shortcut: string,
    handler: (action: ShortcutAction) => void,
  ): Promise<void>;

  export function unregister(shortcut: string): Promise<void>;

  export function unregisterAll(): Promise<void>;

  export function isRegistered(shortcut: string): Promise<boolean>;
}
