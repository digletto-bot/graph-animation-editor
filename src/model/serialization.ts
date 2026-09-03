import type { AnimationProject, EditorPreferences } from './types.ts';
import { validateProject, type ValidationResult } from './projectValidation.ts';

export const STORAGE_KEY = 'graph-animation-editor:project';
export const STORAGE_REFERENCE_KEY = 'graph-animation-editor:reference-image';
export const STORAGE_PREFERENCES_KEY = 'graph-animation-editor:preferences';

/**
 * The exported document deliberately contains no reference image bytes — only
 * the transform/display block, so the JSON stays small and portable.
 */
export function serializeProject(project: AnimationProject): string {
  return JSON.stringify(
    {
      version: project.version,
      nodes: project.nodes,
      edges: project.edges,
      poses: project.poses,
      settings: project.settings,
      reference: project.reference,
    },
    null,
    2,
  );
}

export function parseProject(text: string): ValidationResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`File is not valid JSON: ${message}`] };
  }
  return validateProject(data);
}

export function exportFilename(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `bird-animation-${stamp}.json`;
}

export function downloadProject(project: AnimationProject, filename = exportFilename()): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsText(file);
  });
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/* --------------------------- local persistence -------------------------- */

export function saveProjectToStorage(project: AnimationProject): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, serializeProject(project));
    return true;
  } catch {
    return false;
  }
}

export function loadProjectFromStorage(): ValidationResult | null {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  return parseProject(text);
}

export function saveReferenceImageToStorage(dataUrl: string | null): void {
  try {
    if (dataUrl) localStorage.setItem(STORAGE_REFERENCE_KEY, dataUrl);
    else localStorage.removeItem(STORAGE_REFERENCE_KEY);
  } catch {
    /* Quota exceeded — the app still works without a stored reference. */
  }
}

export function loadReferenceImageFromStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_REFERENCE_KEY);
  } catch {
    return null;
  }
}

export function savePreferencesToStorage(preferences: EditorPreferences): boolean {
  try {
    localStorage.setItem(STORAGE_PREFERENCES_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

/** Partial: older/foreign payloads may be missing sections — callers merge onto defaults. */
export function loadPreferencesFromStorage(): Partial<EditorPreferences> | null {
  try {
    const text = localStorage.getItem(STORAGE_PREFERENCES_KEY);
    if (!text) return null;
    return JSON.parse(text) as Partial<EditorPreferences>;
  } catch {
    return null;
  }
}
