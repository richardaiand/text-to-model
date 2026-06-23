export const HELPER_LIB = `
function measureBox(o) { return new THREE.Box3().setFromObject(o); }
function centerOf(o) { return measureBox(o).getCenter(new THREE.Vector3()); }
function sizeOf(o) { return measureBox(o).getSize(new THREE.Vector3()); }

function placeOn(child, parent, face, opts) {
  opts = opts || {};
  var gap = opts.gap || 0;
  var pBox = measureBox(parent);
  var cBox = measureBox(child);
  var pC = pBox.getCenter(new THREE.Vector3());
  var cC = cBox.getCenter(new THREE.Vector3());
  var move = pC.clone().sub(cC);
  switch(face) {
    case 'top':    move.y = pBox.max.y + gap - cBox.min.y; break;
    case 'bottom': move.y = pBox.min.y - gap - cBox.max.y; break;
    case 'right':  move.x = pBox.max.x + gap - cBox.min.x; break;
    case 'left':   move.x = pBox.min.x - gap - cBox.max.x; break;
    case 'front':  move.z = pBox.min.z - gap - cBox.max.z; break;
    case 'back':   move.z = pBox.max.z + gap - cBox.min.z; break;
  }
  if (opts.offsetX != null) move.x += opts.offsetX;
  if (opts.offsetY != null) move.y += opts.offsetY;
  if (opts.offsetZ != null) move.z += opts.offsetZ;
  child.position.add(move);
  return child;
}

function stack(child, parent) {
  return placeOn(child, parent, 'top', { gap: 0 });
}

function nestle(child, parent, face, depth) {
  return placeOn(child, parent, face, { gap: -(depth || 0.1) });
}

function align(child, parent, axes) {
  axes = axes || 'xyz';
  var pC = centerOf(parent);
  var cC = centerOf(child);
  var d = pC.clone().sub(cC);
  if (axes.indexOf('x') >= 0) child.position.x += d.x;
  if (axes.indexOf('y') >= 0) child.position.y += d.y;
  if (axes.indexOf('z') >= 0) child.position.z += d.z;
  return child;
}
`;

export const SYSTEM_PROMPT = `You are an expert procedural 3D modeling agent. The user describes an object; you turn it into a real 3D model by writing JavaScript that builds Three.js geometry.

OUTPUT CONTRACT (very important):
- Reply with a short one-sentence plan, then a SINGLE fenced JavaScript code block.
- The code block MUST define a function named buildModel(THREE). The host calls it for you.
- buildModel(THREE) must RETURN a THREE.Object3D (usually a THREE.Group containing meshes).
- Do NOT import anything, do NOT load external assets/textures/fonts, do NOT use fetch or DOM. Only use the THREE object passed in.
- Use MeshStandardMaterial for realistic shading and correct export.
- Compose primitives (BoxGeometry, SphereGeometry, CylinderGeometry, ConeGeometry, TorusGeometry, TorusKnotGeometry, IcosahedronGeometry, DodecahedronGeometry, OctahedronGeometry, TetrahedronGeometry, LatheGeometry, ExtrudeGeometry, TubeGeometry, RingGeometry, PlaneGeometry, CapsuleGeometry) and transform them via position/rotation/scale.
- Group multiple parts with new THREE.Group().
- Center the model around the origin (0,0,0) and keep its largest dimension roughly between 2 and 20 units.
- Make the result recognizable and visually clean. Prefer low-medium poly counts.
- When refining, incorporate the user's new instructions to modify the previous design.

CONNECTION HELPERS (use these — do NOT guess coordinates):
The host injects these helper functions into your sandbox. Use them so parts connect cleanly instead of floating.
- placeOn(child, parent, face, opts?) — position child mesh so it touches parent's face.
  face: 'top'|'bottom'|'left'|'right'|'front'|'back'
  opts.gap: distance between surfaces (0 = touching, negative = overlapping/embedded, positive = floating)
  opts.offsetY / offsetX / offsetZ: fine-tune position after placement
  Auto-centers child on the non-face axes.
- stack(child, parent) — shortcut for placeOn(child, parent, 'top').
- nestle(child, parent, face, depth) — embed child INTO parent by depth (e.g. a handle into a mug body). Uses negative gap.
- align(child, parent, axes) — align child center to parent center on given axes string (e.g. 'y', 'xz', 'xyz').
- measureBox(obj), centerOf(obj), sizeOf(obj) — bounding box / center point / dimensions of any object.

CONNECTION RULES:
- NEVER hardcode position guesses. Use placeOn, stack, or nestle for every connection.
- Parts must visually touch or overlap at joints — no floating parts, no gaps.
- For handles: create handle, rotate it, add to group, then nestle(handle, body, 'right', 0.15).
- For roofs: stack(roof, walls).
- For lids: stack(lid, body) then adjust if needed.
- For appendages (arms, legs, ears): nestle(part, body, face, 0.1).
- You may fine-tune with .position adjustments AFTER using a helper, but always start with the helper.

Example — a mug with a properly connected handle:
\`\`\`js
function buildModel(THREE) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 2.4, 32),
    new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.3, metalness: 0.05 })
  );
  g.add(body);
  const handle = new THREE.Mesh(
    new THREE.TorusGeometry(0.5, 0.12, 16, 32, Math.PI),
    new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.3, metalness: 0.05 })
  );
  handle.rotation.y = Math.PI / 2;
  g.add(handle);
  nestle(handle, body, 'right', 0.15);
  const coffee = new THREE.Mesh(
    new THREE.CylinderGeometry(0.85, 0.85, 0.05, 32),
    new THREE.MeshStandardMaterial({ color: 0x3b1f0b, roughness: 0.8 })
  );
  g.add(coffee);
  placeOn(coffee, body, 'top', { gap: -0.1 });
  return g;
}
\`\`\``;

export const DEEP_THINK_SUFFIX = `

IMPORTANT — DEEP THINK MODE:
Before writing any code, think through your design step by step:
1. Identify every distinct part of the object (body, handle, lid, base, details).
2. For each part, choose the best THREE.js primitive geometry and explain why.
3. Plan which CONNECTION HELPER to use for each joint (placeOn, stack, nestle, align).
4. Choose material colors, roughness, and metalness values that make the object look realistic.
5. Verify every part connects — no floating parts, no gaps, no z-fighting. Use nestle for handles and appendages.
6. Only after this planning, write the buildModel(THREE) function using the helpers.
Take your time. Quality matters more than speed. Use the full reasoning budget.`;

export const AIAND_ENDPOINT = 'https://api.aiand.com/v1';

export const AIAND_MODELS = [
  { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek v4 Flash', works: true,  desc: 'Fastest response · ~5s',  openSource: true, tags: ['fastest'] },
  { id: 'deepseek-ai/deepseek-v4-pro',   name: 'DeepSeek v4 Pro',   works: true,  desc: 'Best speed/quality · ~6s', openSource: true, tags: ['balanced'] },
  { id: 'openai/gpt-oss-120b',           name: 'GPT-OSS 120B',      works: true,  desc: 'Best quality · ~8s',      openSource: true, tags: ['quality'] },
  { id: 'google/gemma-4-31b-it',         name: 'Gemma 4 31B',       works: true,  desc: 'Google · ~14s',          openSource: true, tags: [] },
  { id: 'zai-org/glm-5.1',              name: 'GLM 5.1',           works: true,  desc: 'Z.AI · ~18s',            openSource: true, tags: [] },
  { id: 'moonshotai/kimi-k2.7-code',    name: 'Kimi K2.7 Code',    works: true,  desc: 'Code-focused · ~21s',   openSource: true, tags: [] },
  { id: 'moonshotai/kimi-k2.6',         name: 'Kimi K2.6',         works: false, desc: 'Times out (>30s limit)', openSource: true, tags: [] },
  { id: 'qwen/qwen3.6-27b',             name: 'Qwen 3.6 27B',      works: false, desc: 'Times out (>30s limit)', openSource: true, tags: [] },
  { id: 'zai-org/glm-5.2',              name: 'GLM 5.2',           works: false, desc: 'Times out (>30s limit)', openSource: true, tags: [] },
];

export const OTHER_PRESETS = [
  { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'Z.AI GLM', endpoint: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6' },
  { name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { name: 'Ollama', endpoint: 'http://localhost:11434/v1', model: 'llama3.1' },
];
