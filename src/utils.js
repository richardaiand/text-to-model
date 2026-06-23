export const $ = (id) => document.getElementById(id);

export const ls = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function parseResponse(text) {
  const fence = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
  if (fence) {
    const code = fence[1].trim();
    const plan = text.slice(0, fence.index).trim().replace(/^#+\s*/gm, '').trim();
    return { code, plan };
  }
  const fnIdx = text.indexOf('function buildModel');
  if (fnIdx >= 0) {
    return { code: text.slice(fnIdx).trim(), plan: fnIdx > 0 ? text.slice(0, fnIdx).trim() : '' };
  }
  return { code: text.trim(), plan: '' };
}
