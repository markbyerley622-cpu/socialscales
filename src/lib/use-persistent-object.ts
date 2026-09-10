"use client";

import * as React from "react";

/**
 * Reads a JSON object from localStorage without a hydration mismatch and
 * without setState-in-effect.
 *
 * `useSyncExternalStore` gives the server a `null` snapshot and the client the
 * real stored string, so React performs the second pass itself. Writes happen
 * in an effect, which is exactly what effects are for: pushing React state out
 * to an external system.
 *
 * Storage is per-browser and best-effort. Private windows, cleared site data
 * and blocked storage all fall back to `initial` rather than throwing.
 */

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};

const readRaw = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function usePersistentObject<T extends object>(key: string, initial: T) {
  // Freeze the baseline on first render: later renders may pass a new object
  // literal, and the stored value must not be re-merged onto a moving target.
  const [initialSnapshot] = React.useState(initial);

  const raw = useSyncExternalStoreSafe(key);

  const persisted = React.useMemo<Partial<T>>(() => {
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Partial<T>;
    } catch {
      return {};
    }
  }, [raw]);

  const baseline = React.useMemo<T>(
    () => ({ ...initialSnapshot, ...persisted }) as T,
    [initialSnapshot, persisted],
  );

  const [override, setOverride] = React.useState<T | null>(null);
  const value = override ?? baseline;

  const update = React.useCallback(
    (updater: (previous: T) => T) => {
      setOverride((previous) => updater(previous ?? baseline));
    },
    [baseline],
  );

  // Push the current value out to storage. Never runs on the server.
  React.useEffect(() => {
    if (override === null) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(override));
    } catch {
      /* storage unavailable — the in-memory value is still correct */
    }
  }, [key, override]);

  const clear = React.useCallback(() => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* non-fatal */
    }
  }, [key]);

  return { value, update, clear } as const;
}

function useSyncExternalStoreSafe(key: string): string | null {
  const getSnapshot = React.useCallback(() => readRaw(key), [key]);
  const getServerSnapshot = React.useCallback(() => null, []);
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
