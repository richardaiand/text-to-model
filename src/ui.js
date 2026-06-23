import { $, escapeHtml, parseResponse } from './utils.js';
import { AIAND_ENDPOINT, AIAND_MODELS, OTHER_PRESETS } from './constants.js';
import { settings } from './api.js';

export function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

export function showLoader(text, on) {
  $('loaderText').textContent = text;
  $('loader').classList.toggle('show', on);
}

export function updateModelPill() {
  $('modelPill').textContent = settings.model ? `model: ${settings.model}` : 'no model set';
}

export function renderChatThread(messages) {
  const thread = $('chatThread');
  thread.innerHTML = '';
  const convo = messages.filter((m) => m.role !== 'system');
  if (convo.length === 0) {
    thread.innerHTML = '<div class="empty-chat">Describe the 3D model you want to build, then hit Generate.</div>';
    return;
  }
  convo.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'chat-row ' + (m.role === 'user' ? 'user' : 'ai');
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    if (m.role === 'user') {
      bubble.textContent = m.content;
    } else {
      const parsed = parseResponse(m.content);
      if (parsed.plan) {
        const details = document.createElement('details');
        details.className = 'think-block';
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = 'Thinking';
        const body = document.createElement('div');
        body.className = 'think-body';
        body.textContent = parsed.plan;
        details.appendChild(summary);
        details.appendChild(body);
        bubble.appendChild(details);
      }
      const pre = document.createElement('pre');
      pre.className = 'chat-code';
      pre.textContent = parsed.code.slice(0, 500) + (parsed.code.length > 500 ? '\n...' : '');
      bubble.appendChild(pre);
    }
    row.appendChild(bubble);
    thread.appendChild(row);
  });
  thread.scrollTop = thread.scrollHeight;
}

export function updateAccountDrawer(currentAccount) {
  const el = $('accountDrawer');
  if (currentAccount) {
    el.innerHTML = `
      <h2>Account</h2>
      <div class="account-info">
        <b>${escapeHtml(currentAccount.username)}</b>
      </div>
      <button class="ghost sm" id="drawerSignOutBtn" style="margin-top:8px;width:100%">Sign out</button>
      <div class="drawer-hint" style="margin-top:6px">Signed in locally. Data stays in this browser.</div>
    `;
  } else {
    el.innerHTML = `
      <h2>Account</h2>
      <div class="drawer-hint">Sign in to save multiple projects and continue later.</div>
      <button class="primary sm" id="drawerSignInBtn" style="margin-top:8px;width:100%">Sign in / Create account</button>
    `;
  }
}

export async function renderProjectList(currentAccount, currentProject, callbacks) {
  const list = $('projectList');
  list.innerHTML = '';
  if (!currentAccount) {
    list.innerHTML = '<div class="drawer-hint">Sign in to save and manage projects.</div>';
    return;
  }
  const { getProjects } = await import('./db.js');
  const projects = await getProjects(currentAccount.username);
  if (projects.length === 0) {
    list.innerHTML = '<div class="drawer-hint">No saved projects yet. Start a chat to create one.</div>';
    return;
  }
  projects.forEach((p) => {
    const item = document.createElement('div');
    item.className = 'project-item' + (currentProject && currentProject.id === p.id ? ' active' : '');
    const title = document.createElement('span');
    title.style.flex = '1';
    title.style.minWidth = '0';
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.textContent = p.title || 'Untitled';
    item.appendChild(title);
    const actions = document.createElement('span');
    actions.className = 'actions';
    const rename = document.createElement('button');
    rename.textContent = '✎';
    rename.title = 'Rename project';
    rename.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newTitle = prompt('Rename project:', p.title || 'Untitled');
      if (newTitle === null) return;
      await callbacks.onRename(p.id, newTitle);
    });
    actions.appendChild(rename);
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Delete project';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this project and its chat history?')) return;
      await callbacks.onDelete(p.id);
    });
    actions.appendChild(del);
    item.appendChild(actions);
    item.addEventListener('click', () => callbacks.onSelect(p));
    list.appendChild(item);
  });
}

export function buildModelList() {
  const TAG_LABELS = { fastest: 'Fastest', quality: 'Best Quality', balanced: 'Balanced' };
  const wrap = $('modelList');
  wrap.innerHTML = '';
  AIAND_MODELS.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'model-card' + (m.works ? '' : ' disabled');
    if (settings.endpoint === AIAND_ENDPOINT && settings.model === m.id) card.classList.add('selected');
    const info = document.createElement('div');
    info.className = 'model-info';
    const name = document.createElement('div');
    name.className = 'model-name';
    name.textContent = m.name;
    const desc = document.createElement('div');
    desc.className = 'model-desc';
    desc.textContent = m.desc;
    info.appendChild(name);
    info.appendChild(desc);
    const badge = document.createElement('span');
    badge.className = 'badge ' + (m.works ? 'works' : 'fails');
    badge.textContent = m.works ? 'Works' : 'Times out';
    card.appendChild(info);
    if (m.tags && m.tags.length) {
      const tagWrap = document.createElement('div');
      tagWrap.className = 'model-tags';
      m.tags.forEach((t) => {
        const tag = document.createElement('span');
        tag.className = 'badge tag-' + t;
        tag.textContent = TAG_LABELS[t] || t;
        tagWrap.appendChild(tag);
      });
      card.appendChild(tagWrap);
    }
    card.appendChild(badge);
    if (m.works) {
      card.addEventListener('click', () => {
        $('endpoint').value = AIAND_ENDPOINT;
        $('model').value = m.id;
        wrap.querySelectorAll('.model-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
      });
    }
    wrap.appendChild(card);
  });
}

export function buildPresets() {
  const wrap = $('presets');
  wrap.innerHTML = '';
  OTHER_PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.textContent = p.name;
    b.addEventListener('click', () => {
      $('endpoint').value = p.endpoint;
      $('model').value = p.model;
      document.querySelectorAll('.model-card').forEach((c) => c.classList.remove('selected'));
    });
    wrap.appendChild(b);
  });
}
