import { SYSTEM_PROMPT, DEEP_THINK_SUFFIX } from './constants.js';
import { ls } from './utils.js';

export function getSystemPrompt(deepThink) {
  return deepThink ? SYSTEM_PROMPT + DEEP_THINK_SUFFIX : SYSTEM_PROMPT;
}

export const settings = {
  endpoint: ls.get('ai3d.endpoint'),
  model: ls.get('ai3d.model'),
  apiKey: ls.get('ai3d.apiKey'),
};

if (!settings.endpoint) settings.endpoint = 'https://api.aiand.com/v1';
if (!settings.model) settings.model = 'deepseek-ai/deepseek-v4-flash';

export function baseEndpoint() {
  return settings.endpoint.replace(/\/+$/, '');
}

export async function callAgent(userPrompt, signal, messages, deepThink) {
  const msgs = [{ role: 'system', content: getSystemPrompt(deepThink) }, ...messages.filter(m => m.role !== 'system')];
  msgs.push({ role: 'user', content: userPrompt });
  if (msgs.length > 12) msgs.splice(1, msgs.length - 11);

  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        endpoint: baseEndpoint(),
        apiKey: settings.apiKey,
        model: settings.model,
        messages: msgs,
        temperature: 0.7,
      }),
    });
  } catch (fetchErr) {
    if (signal?.aborted) throw new Error('Generation cancelled.');
    throw new Error('Cannot reach server. Check your connection and try again. (' + fetchErr.message + ')');
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let msg = t;
    try { msg = JSON.parse(t).error?.message || t; } catch {}
    throw new Error(`API ${res.status}: ${msg.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.error?.message) throw new Error(parsed.error.message);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) full += delta;
      } catch (e) {
        if (e instanceof Error && e.name !== 'SyntaxError') throw e;
      }
    }
  }
  if (!full) throw new Error('Model returned no content. Try again or use a different model.');
  return full;
}
