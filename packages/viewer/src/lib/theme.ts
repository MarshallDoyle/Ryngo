/**
 * Theme hook for the codegraph viewer.
 *
 * The viewer defaults to dark (Inspector / Pitch+Volt — brand §2). Light
 * mode swaps in the docs theme (Vellum+Bearing+Volt-Dark — brand §4.2,
 * §5.7). Mode is persisted in localStorage; if no preference is stored we
 * fall back to `prefers-color-scheme`, then to dark.
 *
 * The active mode is reflected on `<html data-theme="...">` so CSS can
 * switch the `@theme` variables in `index.css`. Components that only need
 * Tailwind utilities never read this hook — utilities resolve to vars and
 * follow `[data-theme]` automatically. Use the hook only when you need the
 * current mode in JS (e.g. to pass a hex into ELK or React Flow).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { palettes, type Palette, type ThemeMode } from './tokens';

const STORAGE_KEY = 'codegraph.viewer.theme';
const ATTR = 'data-theme';

/* ------------------------------------------------------------------------- */
/* Module-level state — single source of truth for the current mode          */
/* ------------------------------------------------------------------------- */

type Listener = (mode: ThemeMode) => void;
const listeners = new Set<Listener>();
let currentMode: ThemeMode = resolveInitialMode();

function resolveInitialMode(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function applyMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(ATTR, mode);
  document.documentElement.style.colorScheme = mode;
}

function setMode(mode: ThemeMode, persist = true): void {
  currentMode = mode;
  if (persist && typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, mode);
  }
  applyMode(mode);
  for (const listener of listeners) listener(mode);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener) as unknown as void;
}

/* ------------------------------------------------------------------------- */
/* Bootstrap: apply mode to the DOM on first import                          */
/* ------------------------------------------------------------------------- */

if (typeof document !== 'undefined') {
  applyMode(currentMode);
}

/* ------------------------------------------------------------------------- */
/* React hook                                                                 */
/* ------------------------------------------------------------------------- */

export interface UseThemeResult {
  /** Current theme mode. */
  readonly mode: ThemeMode;
  /** Active palette (typed). Re-reads on mode change. */
  readonly palette: Palette;
  /** Imperatively set the mode and persist it. */
  readonly setMode: (mode: ThemeMode) => void;
  /** Toggle between dark and light. */
  readonly toggle: () => void;
}

/**
 * Read and control the viewer's theme. Re-renders when the mode changes,
 * including from another tab (storage event) or another component.
 *
 * SSR note: useSyncExternalStore's third arg returns the dark default during
 * server render; the first client render reconciles to the real value.
 */
export function useTheme(): UseThemeResult {
  const mode = useSyncExternalStore(
    subscribe,
    () => currentMode,
    () => 'dark' as const,
  );

  // Cross-tab sync: listen to `storage` so two viewer windows stay aligned.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = e.newValue;
      if (next === 'dark' || next === 'light') setMode(next, false);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return {
    mode,
    palette: palettes[mode],
    setMode: (m) => setMode(m),
    toggle: () => setMode(mode === 'dark' ? 'light' : 'dark'),
  };
}

/**
 * Non-React accessor for the current palette. Useful inside ELK layout
 * config, React Flow edge style functions, and other contexts where hooks
 * aren't available. Reads the live mode each call.
 */
export function getPalette(): Palette {
  return palettes[currentMode];
}

/** Non-React accessor for the current mode. */
export function getMode(): ThemeMode {
  return currentMode;
}

/**
 * Subscribe to mode changes from non-React code. Returns an unsubscribe
 * function. Prefer the `useTheme` hook in components.
 */
export function onThemeChange(listener: (mode: ThemeMode) => void): () => void {
  return subscribe(listener);
}

/**
 * Lightweight effect: react to system `prefers-color-scheme` changes when
 * the user has not pinned a mode. Mount this once near the app root (e.g.
 * in App.tsx) — it is a no-op after the user clicks the toggle once.
 */
export function useSystemThemeSync(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => {
      if (window.localStorage.getItem(STORAGE_KEY)) return; // user pinned
      setMode(e.matches ? 'light' : 'dark', false);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
}
