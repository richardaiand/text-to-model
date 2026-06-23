const DB_NAME = 'ai3d_chat';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  if (!window.indexedDB) {
    dbPromise = Promise.reject(new Error('IndexedDB not supported in this browser'));
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IndexedDB open timed out')), 3000);
    let settled = false;
    const done = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(...args);
    };
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = done(() => reject(req.error || new Error('IndexedDB error')));
    req.onsuccess = done(() => resolve(req.result));
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('accounts')) {
        db.createObjectStore('accounts', { keyPath: 'username' });
      }
      if (!db.objectStoreNames.contains('projects')) {
        const ps = db.createObjectStore('projects', { keyPath: 'id', autoIncrement: true });
        ps.createIndex('accountId', 'accountId', { unique: false });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        ms.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'accountId' });
      }
    };
  });
  return dbPromise;
}

export async function dbRequest(storeName, mode, operation) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = operation(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

export async function hashPassword(password) {
  const enc = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function createAccount(username, password) {
  const existing = await dbRequest('accounts', 'readonly', store => store.get(username));
  if (existing) throw new Error('Username already exists.');
  const account = { username, passwordHash: await hashPassword(password), createdAt: Date.now() };
  await dbRequest('accounts', 'readwrite', store => store.put(account));
  return account;
}

export async function verifyAccount(username, password) {
  const account = await dbRequest('accounts', 'readonly', store => store.get(username));
  if (!account) throw new Error('Account not found.');
  const hash = await hashPassword(password);
  if (hash !== account.passwordHash) throw new Error('Incorrect password.');
  return account;
}

export async function getProjects(accountId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readonly');
    const store = tx.objectStore('projects');
    const idx = store.index('accountId');
    const req = idx.openCursor(accountId);
    const list = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { list.push(cursor.value); cursor.continue(); }
      else resolve(list.sort((a, b) => b.updatedAt - a.updatedAt));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveProject(project) {
  project.updatedAt = Date.now();
  const id = await dbRequest('projects', 'readwrite', store => store.put(project));
  if (!project.id) project.id = id;
  return project;
}

export async function renameProject(id, newTitle) {
  const project = await dbRequest('projects', 'readonly', store => store.get(id));
  if (!project) return null;
  project.title = newTitle.trim() || 'Untitled';
  await saveProject(project);
  return project;
}

export async function deleteProject(id) {
  await dbRequest('projects', 'readwrite', store => store.delete(id));
  const db = await openDB();
  const tx = db.transaction('messages', 'readwrite');
  const store = tx.objectStore('messages');
  const idx = store.index('projectId');
  return new Promise((resolve, reject) => {
    const req = idx.openCursor(id);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getMessages(projectId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');
    const idx = store.index('projectId');
    const req = idx.openCursor(projectId);
    const list = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { list.push(cursor.value); cursor.continue(); }
      else resolve(list.sort((a, b) => a.createdAt - b.createdAt));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveMessage(msg) {
  msg.updatedAt = Date.now();
  const id = await dbRequest('messages', 'readwrite', store => store.put(msg));
  if (!msg.id) msg.id = id;
  return msg;
}

export async function loadAccountSettings(account, settings) {
  if (!account) return { theme: null, detail: null };
  const s = await dbRequest('settings', 'readonly', store => store.get(account.username));
  if (s) {
    if (s.endpoint) settings.endpoint = s.endpoint;
    if (s.model) settings.model = s.model;
    if (s.apiKey) settings.apiKey = s.apiKey;
    return { theme: s.theme || null, detail: ['low', 'medium', 'high'].includes(s.detail) ? s.detail : null };
  }
  return { theme: null, detail: null };
}

export async function saveAccountSettings(account, settings, lightTheme, detail) {
  if (!account) return;
  await dbRequest('settings', 'readwrite', store => store.put({
    accountId: account.username,
    endpoint: settings.endpoint,
    model: settings.model,
    apiKey: settings.apiKey,
    theme: lightTheme ? 'light' : 'dark',
    detail,
  }));
}
