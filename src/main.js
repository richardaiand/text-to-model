import { $, ls, parseResponse } from './utils.js';
import { settings, callAgent, getSystemPrompt } from './api.js';
import { AIAND_ENDPOINT } from './constants.js';
import { initScene, applyTheme, resize, animate, runModelCode, currentModel, exportModel, scene, disposeObject } from './scene.js';
import {
  openDB, dbRequest, createAccount, verifyAccount, saveAccountSettings, loadAccountSettings,
  getProjects, saveProject, renameProject, deleteProject, getMessages, saveMessage
} from './db.js';
import { setStatus, showLoader, updateModelPill, renderChatThread, updateAccountDrawer, renderProjectList, buildModelList, buildPresets } from './ui.js';

let deepThink = ls.get('ai3d.deepThink', 'false') === 'true';
let lightTheme = ls.get('ai3d.theme', 'dark') === 'light';
let currentAccount = null;
let currentProject = null;
let messages = [{ role: 'system', content: getSystemPrompt(deepThink) }];
let currentAbort = null;
let genId = 0;
let drawerOpen = true;
let chatWidthPct = 50;
let dragging = false;

const { renderer } = initScene($('c'));
applyTheme(lightTheme);
document.body.setAttribute('data-theme', lightTheme ? 'light' : 'dark');
$('themeBtn').textContent = lightTheme ? '☀️' : '🌙';

const ro = new ResizeObserver(resize);
ro.observe(renderer.domElement);
resize();
animate();

function syncDeepThink(save = true) {
  const el = $('deepThinkToggle');
  if (el) el.classList.toggle('on', deepThink);
  ls.set('ai3d.deepThink', String(deepThink));
  messages = [{ role: 'system', content: getSystemPrompt(deepThink) }];
  if (save) saveAccountSettings(currentAccount, settings, lightTheme, deepThink);
}

function bindAccountDrawer() {
  const signInBtn = $('drawerSignInBtn');
  if (signInBtn) signInBtn.addEventListener('click', openAuthDialog);
  const signOutBtn = $('drawerSignOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', signOut);
}

async function generate() {
  if (!settings.apiKey && !/localhost|127\.0\.0\.1/.test(settings.endpoint)) {
    setStatus('Add your API key in Settings first.', 'error');
    $('settingsBtn').click();
    return;
  }
  const prompt = $('prompt').value.trim();
  if (!prompt) { setStatus('Type a prompt first.', 'error'); return; }

  if (currentAbort) {
    currentAbort.abort();
    setStatus('Cancelling previous request…', '');
    return;
  }

  const btn = $('generateBtn');
  btn.disabled = true;
  showLoader(deepThink ? 'Thinking deeply…' : 'Agent is modeling…', true);
  setStatus('Generating…');
  const abort = new AbortController();
  currentAbort = abort;
  const myGen = ++genId;

  if (!currentProject && currentAccount) {
    currentProject = await saveProject({ accountId: currentAccount.username, title: prompt.slice(0, 40) });
    await renderProjectList(currentAccount, currentProject, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
  }

  try {
    const raw = await callAgent(prompt, abort.signal, messages, deepThink);
    const { code, plan } = parseResponse(raw);
    messages.push({ role: 'user', content: prompt });
    messages.push({ role: 'assistant', content: raw });

    if (currentProject && currentAccount) {
      const userMsg = { projectId: currentProject.id, role: 'user', content: prompt, createdAt: Date.now() };
      const aiMsg = { projectId: currentProject.id, role: 'assistant', content: raw, plan, code, createdAt: Date.now() + 1 };
      await saveMessage(userMsg);
      await saveMessage(aiMsg);
      currentProject.title = currentProject.title || prompt.slice(0, 40);
      await saveProject(currentProject);
      await renderProjectList(currentAccount, currentProject, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
    }

    renderChatThread(messages);
    runModelCode(code);
    setStatus('Model ready. Orbit to inspect, then export.', 'ok');
    $('prompt').value = '';
  } catch (e) {
    if (messages[messages.length - 1]?.role === 'user') messages.pop();
    setStatus(e.message, 'error');
  } finally {
    if (currentAbort === abort) currentAbort = null;
    if (genId === myGen) {
      btn.disabled = false;
      showLoader('', false);
    }
  }
}

async function newProject() {
  if (currentModel) {
    scene.remove(currentModel);
    disposeObject(currentModel);
  }
  messages = [{ role: 'system', content: getSystemPrompt(deepThink) }];
  $('prompt').value = '';
  $('stats').textContent = 'No model';
  $('emptyHint').style.display = '';
  document.querySelectorAll('.exports button').forEach((b) => (b.disabled = true));
  setStatus('');

  if (currentAccount) {
    currentProject = await saveProject({ accountId: currentAccount.username, title: 'New Project' });
    await renderProjectList(currentAccount, currentProject, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
  } else {
    currentProject = null;
  }
  renderChatThread(messages);
}

async function loadProject(project) {
  currentProject = project;
  await renderProjectList(currentAccount, currentProject, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
  if (currentModel) {
    scene.remove(currentModel);
    disposeObject(currentModel);
  }
  messages = [{ role: 'system', content: getSystemPrompt(deepThink) }];
  $('prompt').value = '';
  $('stats').textContent = 'No model';
  $('emptyHint').style.display = '';
  document.querySelectorAll('.exports button').forEach((b) => (b.disabled = true));
  setStatus('');

  if (!project) {
    renderChatThread(messages);
    return;
  }

  const stored = await getMessages(project.id);
  stored.forEach((m) => messages.push({ role: m.role, content: m.content }));
  renderChatThread(messages);

  const lastCode = stored.filter(m => m.role === 'assistant' && m.code).pop()?.code;
  if (lastCode) {
    try { runModelCode(lastCode); }
    catch (e) { setStatus('Could not rebuild model: ' + e.message, 'error'); }
  }
}

async function handleRenameProject(id, newTitle) {
  const project = await renameProject(id, newTitle);
  if (project && currentProject && currentProject.id === id) {
    currentProject.title = project.title;
  }
  await renderProjectList(currentAccount, currentProject, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
}

async function handleDeleteProject(id) {
  await deleteProject(id);
  if (currentProject && currentProject.id === id) await loadProject(null);
  else await renderProjectList(currentAccount, currentProject, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
}

function openSettings() {
  $('endpoint').value = settings.endpoint;
  $('model').value = settings.model;
  $('apiKey').value = settings.apiKey;
  $('settingsDlg').showModal();
}

async function saveSettings() {
  settings.endpoint = $('endpoint').value.trim() || AIAND_ENDPOINT;
  settings.model = $('model').value.trim() || 'deepseek-ai/deepseek-v4-flash';
  settings.apiKey = $('apiKey').value.trim();
  ls.set('ai3d.endpoint', settings.endpoint);
  ls.set('ai3d.model', settings.model);
  ls.set('ai3d.apiKey', settings.apiKey);
  await saveAccountSettings(currentAccount, settings, lightTheme, deepThink);
  updateModelPill();
  $('settingsDlg').close();
}

function openAuthDialog() {
  $('authUser').value = '';
  $('authPass').value = '';
  $('authError').textContent = '';
  $('authDlg').showModal();
}

function closeAuthDialog() {
  $('authDlg').close();
}

async function handleSignIn() {
  $('authError').textContent = '';
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  if (!username || !password) { $('authError').textContent = 'Enter username and password.'; return; }
  try {
    currentAccount = await verifyAccount(username, password);
    ls.set('ai3d.currentAccount', username);
    const accSettings = await loadAccountSettings(currentAccount, settings);
    if (accSettings.theme) { lightTheme = accSettings.theme === 'light'; ls.set('ai3d.theme', accSettings.theme); }
    if (accSettings.deepThink !== null) { deepThink = accSettings.deepThink; ls.set('ai3d.deepThink', String(deepThink)); }
    applyTheme(lightTheme);
    document.body.setAttribute('data-theme', lightTheme ? 'light' : 'dark');
    $('themeBtn').textContent = lightTheme ? '☀️' : '🌙';
    syncDeepThink(false);
    updateAccountDrawer(currentAccount); bindAccountDrawer();
    closeAuthDialog();
    const projects = await getProjects(currentAccount.username);
    if (projects.length) await loadProject(projects[0]);
    else await loadProject(null);
    await renderProjectList(currentAccount, currentProject, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
    setStatus(`Welcome back, ${username}.`, 'ok');
  } catch (e) {
    $('authError').textContent = e.message;
  }
}

async function handleSignUp() {
  $('authError').textContent = '';
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  if (!username || !password) { $('authError').textContent = 'Enter username and password.'; return; }
  if (password.length < 4) { $('authError').textContent = 'Password must be at least 4 characters.'; return; }
  try {
    currentAccount = await createAccount(username, password);
    ls.set('ai3d.currentAccount', username);
    await saveAccountSettings(currentAccount, settings, lightTheme, deepThink);
    updateAccountDrawer(currentAccount); bindAccountDrawer();
    closeAuthDialog();
    await loadProject(null);
    await renderProjectList(currentAccount, currentProject, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
    setStatus(`Account created. Welcome, ${username}.`, 'ok');
  } catch (e) {
    $('authError').textContent = e.message;
  }
}

async function signOut() {
  currentAccount = null;
  currentProject = null;
  ls.del('ai3d.currentAccount');
  updateAccountDrawer(null);
  await renderProjectList(null, null, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
  await loadProject(null);
  setStatus('Signed out.', '');
}

function setChatWidth(pct) {
  chatWidthPct = Math.max(0, Math.min(100, pct));
  const chat = $('chatPanel');
  const view = $('viewportPanel');
  if (chatWidthPct <= 0) {
    chat.style.display = 'none';
    view.style.display = 'block';
    view.style.flex = '1';
  } else if (chatWidthPct >= 100) {
    chat.style.display = 'flex';
    chat.style.width = '100%';
    view.style.display = 'none';
  } else {
    chat.style.display = 'flex';
    chat.style.width = chatWidthPct + '%';
    view.style.display = 'block';
    view.style.flex = '1';
  }
  resize();
}

async function exportCurrentModel(format) {
  try {
    const filename = await exportModel(format, $('filename').value);
    setStatus(`Exported ${filename}`, 'ok');
  } catch (e) {
    setStatus('Export failed: ' + e.message, 'error');
  }
}

window.addEventListener('error', (e) => {
  console.error('window error', e.error || e.message);
  setStatus('Script error: ' + (e.error?.message || e.message), 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('unhandled rejection', e.reason);
  setStatus('Unhandled error: ' + (e.reason?.message || e.reason), 'error');
});

$('generateBtn').addEventListener('click', generate);
$('newProjectBtn').addEventListener('click', newProject);
$('toggleDrawerBtn').addEventListener('click', () => {
  drawerOpen = !drawerOpen;
  $('mainArea').classList.toggle('drawer-collapsed', !drawerOpen);
  setChatWidth(chatWidthPct);
});
$('settingsBtn').addEventListener('click', openSettings);
$('saveSettings').addEventListener('click', saveSettings);
$('cancelSettings').addEventListener('click', () => $('settingsDlg').close());
document.querySelectorAll('.exports button').forEach((b) =>
  b.addEventListener('click', () => exportCurrentModel(b.dataset.export))
);
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    generate();
  }
});
$('themeBtn').addEventListener('click', () => {
  lightTheme = !lightTheme;
  ls.set('ai3d.theme', lightTheme ? 'light' : 'dark');
  applyTheme(lightTheme);
  document.body.setAttribute('data-theme', lightTheme ? 'light' : 'dark');
  $('themeBtn').textContent = lightTheme ? '☀️' : '🌙';
  saveAccountSettings(currentAccount, settings, lightTheme, deepThink);
});

const deepThinkEl = document.createElement('div');
deepThinkEl.className = 'toggle-row' + (deepThink ? ' on' : '');
deepThinkEl.id = 'deepThinkToggle';
deepThinkEl.innerHTML = '<div class="toggle"></div><span>Deep Think</span>';
$('settingsDlg').querySelector('.dlg-actions').before(deepThinkEl);
deepThinkEl.addEventListener('click', () => { deepThink = !deepThink; syncDeepThink(); });

$('authSignIn').addEventListener('click', handleSignIn);
$('authSignUp').addEventListener('click', handleSignUp);
$('authCancel').addEventListener('click', closeAuthDialog);

$('splitter').addEventListener('mousedown', (e) => {
  dragging = true;
  $('splitter').classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const main = $('mainArea').getBoundingClientRect();
  const drawerW = $('projectDrawer').offsetWidth;
  const splitterW = $('splitter').offsetWidth;
  const avail = main.width - drawerW - splitterW;
  const x = e.clientX - main.left - drawerW;
  let pct = (x / avail) * 100;
  for (const s of [0, 50, 100]) {
    if (Math.abs(pct - s) < 6) { pct = s; break; }
  }
  setChatWidth(pct);
});
document.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    $('splitter').classList.remove('dragging');
    document.body.style.cursor = '';
  }
});

async function init() {
  try {
    buildModelList();
    buildPresets();
    updateModelPill();
    setChatWidth(50);
    setTimeout(resize, 50);
    setTimeout(resize, 200);

    updateAccountDrawer(null); bindAccountDrawer();
    await renderProjectList(null, null, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
    renderChatThread(messages);
    if (!settings.apiKey) setStatus('Open Settings to add your API key.', '');

    const savedAccount = ls.get('ai3d.currentAccount', '');
    if (!savedAccount) return;

    currentAccount = await dbRequest('accounts', 'readonly', store => store.get(savedAccount));
    if (currentAccount) {
      const accSettings = await loadAccountSettings(currentAccount, settings);
      if (accSettings.theme) { lightTheme = accSettings.theme === 'light'; ls.set('ai3d.theme', accSettings.theme); }
      if (accSettings.deepThink !== null) { deepThink = accSettings.deepThink; ls.set('ai3d.deepThink', String(deepThink)); }
      applyTheme(lightTheme);
      document.body.setAttribute('data-theme', lightTheme ? 'light' : 'dark');
      $('themeBtn').textContent = lightTheme ? '☀️' : '🌙';
      syncDeepThink(false);
      updateAccountDrawer(currentAccount); bindAccountDrawer();
      const projects = await getProjects(currentAccount.username);
      if (projects.length) await loadProject(projects[0]);
      await renderProjectList(currentAccount, currentProject, { onSelect: loadProject, onDelete: handleDeleteProject, onRename: handleRenameProject });
    } else {
      ls.del('ai3d.currentAccount');
    }
  } catch (e) {
    console.error('init error', e);
    setStatus('Startup error: ' + e.message, 'error');
    updateAccountDrawer(null); bindAccountDrawer();
    renderChatThread(messages);
  }
}
init();
