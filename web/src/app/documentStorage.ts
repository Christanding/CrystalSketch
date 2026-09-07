import type { LoadedPreviewSession } from "./hooks/useStructurePreview";
import { loadWorkspace, parseWorkspacePreferences, serializeWorkspacePreferences, WORKSPACE_PREFERENCES_KEY, type SavedWorkspace, type WorkspacePreferences } from "./workspaceStorage";
import { validateModelStructure } from "../model/structureModel";

export interface WorkspaceManifest {
  version: 2;
  documents: { id: string; title: string }[];
  activeId: string | null;
  compareIds: [string, string] | null;
  syncRotation: boolean;
  uniformScale: boolean;
  leftSidebarOpen?: boolean;
}
export interface StoredDocuments { manifest: WorkspaceManifest; documents: SavedWorkspace[] }
export const DOCUMENT_MANIFEST_KEY = "crystalsketch.documents.v2";
const preferenceKey = (id: string) => `crystalsketch.document.${id}`;
const blockedIds = new Set<string>();
interface ModelSaveQueue { pending: SavedWorkspace | null; completion?: Promise<void> }
const modelSaves = new Map<string, ModelSaveQueue>();
let database: Promise<IDBDatabase> | null = null;
export const createEmptyManifest = (): WorkspaceManifest => ({ version: 2, documents: [], activeId: null, compareIds: null, syncRotation: true, uniformScale: false });

export function durableWorkspaceManifest(manifest: WorkspaceManifest, durableIds: ReadonlySet<string>): WorkspaceManifest {
  const documents = manifest.documents.filter(doc => durableIds.has(doc.id));
  const activeId = manifest.activeId && durableIds.has(manifest.activeId) ? manifest.activeId : documents[0]?.id ?? null;
  const compareIds = manifest.compareIds?.every(id => durableIds.has(id)) ? manifest.compareIds : null;
  return { ...manifest, documents, activeId, compareIds };
}

function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("crystalsketch-workspace", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspace");
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Workspace storage is blocked."));
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
  }).catch(error => { database = null; throw error; });
  return database;
}

export function parseWorkspaceManifest(value: string): WorkspaceManifest {
  const state = JSON.parse(value) as WorkspaceManifest;
  if (state?.version !== 2 || !Array.isArray(state.documents)
    || state.documents.some(doc => !doc || typeof doc.id !== "string" || typeof doc.title !== "string")
    || new Set(state.documents.map(doc => doc.id)).size !== state.documents.length
    || typeof state.syncRotation !== "boolean" || typeof state.uniformScale !== "boolean"
    || state.leftSidebarOpen !== undefined && typeof state.leftSidebarOpen !== "boolean") throw new Error("Invalid document workspace.");
  const ids = new Set(state.documents.map(doc => doc.id));
  if (state.activeId !== null && !ids.has(state.activeId)
    || state.documents.length > 0 && state.activeId === null
    || state.compareIds !== null && (!Array.isArray(state.compareIds) || state.compareIds.length !== 2
      || state.compareIds[0] === state.compareIds[1] || state.compareIds.some(id => !ids.has(id))
      || !state.compareIds.includes(state.activeId!))) throw new Error("Invalid document selection.");
  return state;
}

export async function loadDocuments(): Promise<StoredDocuments> {
  const empty = { manifest: createEmptyManifest(), documents: [] };
  if (typeof indexedDB === "undefined") return empty;
  const raw = localStorage.getItem(DOCUMENT_MANIFEST_KEY);
  if (!raw) {
    const legacy = await loadWorkspace();
    if (!legacy) return empty;
    const manifest: WorkspaceManifest = { ...createEmptyManifest(), documents: [{ id: legacy.session.id, title: legacy.session.fileName }], activeId: legacy.session.id };
    await saveDocumentSession(legacy.session);
    saveDocumentPreferences(legacy.preferences);
    saveWorkspaceManifest(manifest);
    return { manifest, documents: [legacy] };
  }
  const manifest = parseWorkspaceManifest(raw);
  const db = await openDatabase();
  const documents = await Promise.all(manifest.documents.map(async ({ id }) => {
    const record = await new Promise<LoadedPreviewSession & { savedPreferences?: string }>((resolve, reject) => {
      const request = db.transaction("workspace").objectStore("workspace").get(`document:${id}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const { savedPreferences, ...session } = record ?? {} as typeof record;
    const preferences = parseWorkspacePreferences(session.model ? savedPreferences ?? null : localStorage.getItem(preferenceKey(id)));
    if (session.model) {
      validateModelStructure(session.model.state.structure);
      if (!Number.isSafeInteger(session.model.revision) || session.model.revision < 0 || !Array.isArray(session.model.state.defects)) {
        throw new Error("Saved structure model is invalid.");
      }
    }
    if (!preferences || preferences.sessionId !== id || session?.id !== id
      || !Array.isArray(session.scene?.atoms) || !Array.isArray(session.scene?.bonds)
      || !Array.isArray(session.scene?.cell?.vectors)) throw new Error("Saved structure is unavailable.");
    return { session, preferences };
  }));
  return { manifest, documents };
}

export async function saveDocumentSession(session: LoadedPreviewSession) {
  if (typeof indexedDB === "undefined" || blockedIds.has(session.id)) return;
  const db = await openDatabase();
  if (blockedIds.has(session.id)) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("workspace", "readwrite");
    transaction.objectStore("workspace").put(session, `document:${session.id}`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Document save failed."));
  });
}

export function saveDocumentPreferences(preferences: WorkspacePreferences) {
  if (preferences.modelDocument) return;
  if (typeof indexedDB === "undefined" || blockedIds.has(preferences.sessionId)) return;
  localStorage.setItem(preferenceKey(preferences.sessionId), serializeWorkspacePreferences(preferences));
}

export async function saveModelWorkspace(workspace: SavedWorkspace) {
  const id = workspace.session.id;
  if (typeof indexedDB === "undefined" || blockedIds.has(id)) return;
  const active = modelSaves.get(id);
  if (active) { active.pending = workspace; return active.completion; }
  const queue: ModelSaveQueue = { pending: workspace };
  modelSaves.set(id, queue);
  queue.completion = drainModelSaves(id, queue);
  return queue.completion;
}

async function drainModelSaves(id: string, queue: ModelSaveQueue) {
  try {
    const db = await openDatabase();
    let failure: unknown;
    while (queue.pending && !blockedIds.has(id)) {
      const { session, preferences } = queue.pending;
      queue.pending = null;
      try {
        // Model, operation history and view settings belong to one durable revision.
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction("workspace", "readwrite");
          transaction.objectStore("workspace").put({ ...session, savedPreferences: serializeWorkspacePreferences(preferences) }, `document:${id}`);
          transaction.oncomplete = () => resolve();
          transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Model save failed."));
        });
      } catch (error) { failure = error; }
    }
    if (failure) throw failure;
  } finally {
    modelSaves.delete(id);
  }
}

export function saveWorkspaceManifest(manifest: WorkspaceManifest) {
  if (typeof indexedDB === "undefined") return;
  localStorage.setItem(DOCUMENT_MANIFEST_KEY, JSON.stringify(manifest));
}

export async function removeDocument(id: string) {
  blockedIds.add(id);
  localStorage.removeItem(preferenceKey(id));
  // A v2 manifest (including an empty one) is authoritative; never restore a closed v1 document.
  localStorage.removeItem(WORKSPACE_PREFERENCES_KEY);
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("workspace", "readwrite");
    transaction.objectStore("workspace").delete(`document:${id}`);
    transaction.objectStore("workspace").delete("active");
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Document removal failed."));
  });
}
