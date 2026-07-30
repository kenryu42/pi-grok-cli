const csrf = document.querySelector('meta[name="grok-csrf"]').content;
const accountsRoot = document.querySelector('#accounts');
const addAccount = document.querySelector('#add-account');
const refreshButton = document.querySelector('#refresh-quotas');
const statsSummary = document.querySelector('#stats-summary');
const linkState = document.querySelector('#link-state');
const linkText = document.querySelector('#link-text');
const dialog = document.querySelector('#action-dialog');
const dialogTitle = document.querySelector('#dialog-title');
const dialogMessage = document.querySelector('#dialog-message');
const dialogLabel = document.querySelector('#dialog-label');
const dialogInput = document.querySelector('#dialog-input');
const dialogConfirm = document.querySelector('#dialog-confirm');
const dialogCancel = document.querySelector('#dialog-cancel');
const toastStatus = document.querySelector('#toast');
const toastAlert = document.querySelector('#toast-alert');
const srStatus = document.querySelector('#sr-status');
const fieldCanvas = document.querySelector('#field');

let lastState = '';
let wasOffline = false;
let entranceDone = false;
let timer;
let pendingProviders = new Set();
let lastProgress = '';
let quotaRefreshInFlight = false;

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const makeToast = (node) => {
  let dismiss;
  const hide = () => {
    clearTimeout(dismiss);
    node.classList.remove('visible');
    // Clear after the hide transition so stale text leaves the accessibility tree.
    const message = node.textContent;
    setTimeout(() => {
      if (!node.classList.contains('visible') && node.textContent === message) {
        node.textContent = '';
      }
    }, 400);
  };
  node.addEventListener('pointerenter', () => clearTimeout(dismiss));
  node.addEventListener('pointerleave', () => {
    if (node.classList.contains('visible')) dismiss = setTimeout(hide, 2500);
  });
  return {
    hide,
    show: (message) => {
      clearTimeout(dismiss);
      node.textContent = message;
      node.classList.add('visible');
      dismiss = setTimeout(hide, 4800);
    },
  };
};

const statusToast = makeToast(toastStatus);
const alertToast = makeToast(toastAlert);

const showToast = (message, error = false) => {
  (error ? statusToast : alertToast).hide();
  (error ? alertToast : statusToast).show(message);
};

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Grok-CSRF': csrf,
      ...options.headers,
    },
  });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Dashboard request failed (${response.status})`);
  return body;
};

const mutation = (path, method, body = {}) => api(path, { method, body: JSON.stringify(body) });

const modal = ({ title, message, value, confirm = 'Confirm', danger = false, cancel = true }) =>
  new Promise((resolve) => {
    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    dialogConfirm.textContent = confirm;
    dialogConfirm.className = danger ? 'button primary danger' : 'button primary';
    dialogCancel.hidden = !cancel;
    const hasInput = value !== undefined;
    dialogLabel.hidden = !hasInput;
    dialogInput.hidden = !hasInput;
    dialogInput.value = value ?? '';
    const close = () => {
      dialog.removeEventListener('close', close);
      resolve(dialog.returnValue === 'confirm' ? (hasInput ? dialogInput.value : true) : undefined);
    };
    dialog.addEventListener('close', close);
    dialog.showModal();
    if (hasInput) dialogInput.select();
  });

dialogCancel.addEventListener('click', () => dialog.close('cancel'));
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close('cancel');
});

const percent = (used, limit) =>
  !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0
    ? 0
    : Math.max(0, Math.min(100, (used / limit) * 100));

const dateLabel = (value) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

/* ---------- State field backdrop ----------
 * A WebGL2 domain-warped noise field driven by live account state: aggregate
 * quota burn raises its energy and shifts the palette indigo → teal → amber,
 * errored accounts bleed ember into the warp, sync activity shimmers, and the
 * pointer stirs the flow. Reduced motion gets a single composed still frame;
 * no WebGL gets the painted CSS fallback (.no-field). */

const FIELD_VERTEX = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FIELD_FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uEnergy;
uniform float uAlert;
uniform float uPending;
uniform vec2 uPointer;
uniform float uPointerForce;

out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    value += amp * noise(p);
    p = rot * p * 2.02;
    amp *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 toPtr = uv - (uPointer - 0.5 * uRes) / uRes.y;
  float stir = uPointerForce * exp(-dot(toPtr, toPtr) * 5.0);
  uv += stir * 0.22 * vec2(-toPtr.y, toPtr.x);

  float t = uTime * (0.045 + uEnergy * 0.035 + uPending * 0.02);
  float warp = 2.1 + uEnergy * 0.9 + uAlert * 0.5;

  vec2 q = vec2(
    fbm(uv * 1.35 + vec2(0.0, t)),
    fbm(uv * 1.35 + vec2(5.2, t * 1.3))
  );
  vec2 r = vec2(
    fbm(uv * 1.35 + warp * q + vec2(1.7, 9.2) + t * 0.6),
    fbm(uv * 1.35 + warp * q + vec2(8.3, 2.8) - t * 0.4)
  );
  float f = fbm(uv * 1.35 + (warp + 0.4) * r);
  // fbm clusters near 0.5; stretch it so the color bands actually saturate.
  f = clamp((f - 0.5) * 2.4 + 0.5, 0.0, 1.0);

  float body = smoothstep(0.3, 0.48, f);
  float mid = smoothstep(0.48, 0.66, f);
  float core = smoothstep(0.66, 0.92, f);
  float glow = 0.55 + 0.45 * uEnergy + 0.2 * uPending;

  vec3 deep = vec3(0.028, 0.032, 0.052);
  vec3 indigo = vec3(0.32, 0.38, 0.9);
  vec3 teal = vec3(0.2, 0.75, 0.55);
  vec3 amber = vec3(0.95, 0.75, 0.25);
  vec3 ember = vec3(0.92, 0.3, 0.28);

  float hueArg = clamp((r.y * 0.6 + q.x * 0.4 - 0.5) * 2.6 + 0.5, 0.0, 1.0);
  vec3 zone = mix(indigo, teal, smoothstep(0.32, 0.68, hueArg));
  zone = mix(zone, amber, smoothstep(0.6, 0.95, uEnergy) * core);
  zone = mix(zone, ember, uAlert * smoothstep(0.32, 0.75, f) * 0.85);

  vec3 col = deep;
  col += indigo * 0.03 * (0.5 + 0.5 * q.y);
  col = mix(col, zone * 0.45, body);
  col = mix(col, zone, mid * 0.9);
  col += zone * core * 0.6 * glow;
  col += zone * (0.14 * q.x * uPending + stir * 0.3);

  vec2 sp = uv * 70.0;
  vec2 cell = floor(sp);
  float h = hash(cell);
  if (h > 0.99) {
    vec2 pos = vec2(hash(cell + 1.3), hash(cell + 2.7));
    float d = length(fract(sp) - pos);
    float tw = 0.5 + 0.5 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
    col += vec3(0.75, 0.82, 1.0) * (1.0 - smoothstep(0.0, 0.16, d)) * tw * 0.6;
  }

  vec2 vuv = uv * vec2(0.75, 1.0);
  col *= clamp(1.0 - 0.35 * dot(vuv, vuv), 0.0, 1.0);
  col *= 1.0 + uPending * 0.06 * sin(uTime * 2.4) + uAlert * 0.08 * sin(uTime * 1.3);
  col = col / (1.0 + col * 0.6);
  col += (hash(gl_FragCoord.xy + vec2(fract(uTime))) - 0.5) * (1.5 / 255.0);

  outColor = vec4(col, 1.0);
}`;

const createField = (canvas) => {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: 'low-power',
    stencil: false,
  });
  if (!gl) return undefined;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || 'Field shader failed to compile.');
    }
    return shader;
  };
  try {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, FIELD_VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FIELD_FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Field shader failed to link.');
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const uniforms = {};
    for (const name of [
      'uRes',
      'uTime',
      'uEnergy',
      'uAlert',
      'uPending',
      'uPointer',
      'uPointerForce',
    ]) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }

    // The field renders on a 30fps cadence; rAF ticks faster only to pace the next draw.
    const FRAME_MS = 1000 / 30;
    const current = { energy: 0.12, alert: 0, pending: 0 };
    const target = { energy: 0.12, alert: 0, pending: 0 };
    const pointer = { x: 0, y: 0, fx: 0, fy: 0, force: 0, forceTarget: 0 };
    let raf = 0;
    let last = 0;
    let time = 30;

    const pixelScale = () => Math.min(window.devicePixelRatio || 1, 1.5) * 0.5;

    const resize = () => {
      const scale = pixelScale();
      const width = Math.max(1, Math.round(canvas.clientWidth * scale));
      const height = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const draw = () => {
      gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uTime, time);
      gl.uniform1f(uniforms.uEnergy, current.energy);
      gl.uniform1f(uniforms.uAlert, current.alert);
      gl.uniform1f(uniforms.uPending, current.pending);
      gl.uniform2f(uniforms.uPointer, pointer.fx, pointer.fy);
      gl.uniform1f(uniforms.uPointerForce, pointer.force);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const frame = (now) => {
      raf = 0;
      if (now - last < FRAME_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
      last = now;
      time += dt;
      const ease = 1 - Math.exp(-dt * 2.2);
      current.energy += (target.energy - current.energy) * ease;
      current.alert += (target.alert - current.alert) * ease;
      current.pending += (target.pending - current.pending) * ease;
      const snap = 1 - Math.exp(-dt * 9);
      pointer.fx += (pointer.x - pointer.fx) * snap;
      pointer.fy += (pointer.y - pointer.fy) * snap;
      pointer.forceTarget *= Math.exp(-dt * 1.4);
      pointer.force += (pointer.forceTarget - pointer.force) * (1 - Math.exp(-dt * 4));
      draw();
      if (!reduceMotion.matches && !document.hidden) raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf || reduceMotion.matches || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const stop = () => {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const still = () => {
      resize();
      draw();
    };

    window.addEventListener(
      'pointermove',
      (event) => {
        const scale = pixelScale();
        pointer.x = event.clientX * scale;
        pointer.y = (canvas.clientHeight - event.clientY) * scale;
        pointer.forceTarget = 1;
      },
      { passive: true },
    );
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });
    reduceMotion.addEventListener('change', () => {
      if (reduceMotion.matches) {
        stop();
        still();
        return;
      }
      start();
    });
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      stop();
      document.documentElement.classList.add('no-field');
    });

    resize();
    new ResizeObserver(() => (raf ? resize() : still())).observe(canvas);

    if (reduceMotion.matches) still();
    else start();

    return {
      setTargets(next) {
        Object.assign(target, next);
        if (!reduceMotion.matches) return;
        Object.assign(current, target);
        still();
      },
    };
  } catch {
    return undefined;
  }
};

const field = createField(fieldCanvas);
if (!field) document.documentElement.classList.add('no-field');

const updateFieldTargets = (state, offline = false) => {
  if (!field) return;
  const usages = state.accounts
    .filter((account) => account.quota)
    .map((account) => percent(account.quota.monthly.used, account.quota.monthly.monthlyLimit));
  const energy = usages.length
    ? usages.reduce((sum, value) => sum + value, 0) / usages.length / 100
    : 0.12;
  const errors = state.accounts.filter(
    (account) => account.login.error || account.login.quotaError,
  ).length;
  field.setTargets({
    alert: offline ? 0.65 : state.accounts.length ? errors / state.accounts.length : 0,
    energy: Math.max(0.12, energy),
    pending:
      state.refreshing || state.accounts.some((account) => account.login.state === 'pending')
        ? 1
        : 0,
  });
};

/* ---------- Quota gauges ----------
 * Ring gauges drawn with a conic-gradient over the registered --gauge
 * property. Sweeps are animated with WAAPI (registered custom property
 * interpolation); where that is unsupported the gauge renders statically. */

const gaugeMemory = new Map();

const animateGauge = (gauge, from, to) => {
  if (reduceMotion.matches) return;
  try {
    gauge.animate([{ '--gauge': String(from) }, { '--gauge': String(to) }], {
      duration: 780,
      easing: 'cubic-bezier(0.22, 0.9, 0.24, 1)',
    });
  } catch {
    // Custom-property WAAPI unsupported: the inline --gauge value already shows the truth.
  }
};

const quotaRow = (provider, label, usedLabel, metaText, remaining) => {
  const row = element('div', 'quota');
  const gauge = element(
    'div',
    `quota-gauge${remaining <= 5 ? ' danger' : remaining <= 25 ? ' warning' : ''}`,
  );
  gauge.style.setProperty('--gauge', remaining.toFixed(1));
  gauge.setAttribute('role', 'meter');
  gauge.setAttribute('aria-label', `${label}: ${Math.round(remaining)} percent remaining`);
  gauge.setAttribute('aria-valuemin', '0');
  gauge.setAttribute('aria-valuemax', '100');
  gauge.setAttribute('aria-valuenow', String(Math.round(remaining)));
  gauge.append(element('span', 'gauge-value', `${Math.round(remaining)}%`));
  const key = `${provider}:${label}`;
  const previous = gaugeMemory.get(key);
  gaugeMemory.set(key, remaining);
  if (!entranceDone) animateGauge(gauge, 0, remaining);
  else if (previous !== undefined && Math.abs(previous - remaining) > 0.5) {
    animateGauge(gauge, previous, remaining);
  }
  const side = element('div', 'quota-side');
  const header = element('div', 'quota-head');
  header.append(element('span', '', label));
  if (usedLabel) header.append(element('span', 'mono', usedLabel));
  const meta = element('div', 'quota-meta');
  meta.append(element('span', '', metaText));
  side.append(header, meta);
  row.append(gauge, side);
  return row;
};

const quotaUnavailable = (label, reason) => {
  const row = element('div', 'quota');
  const header = element('div', 'quota-head');
  header.append(element('span', '', label));
  row.append(header, element('p', 'quota-unavailable', reason));
  return row;
};

const PLAN_LABELS = {
  free: 'Free plan',
  'supergrok-lite': 'SuperGrok Lite',
  supergrok: 'SuperGrok',
  'supergrok-heavy': 'SuperGrok Heavy',
};

const statusPill = (account) => {
  const variant = account.login.error
    ? 'error'
    : account.login.state === 'pending'
      ? 'pending'
      : account.authenticated
        ? 'ok'
        : '';
  const pill = element('p', `status-pill${variant ? ` ${variant}` : ''}`);
  const dot = element('span', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  pill.append(
    dot,
    element('span', '', account.login.state === 'pending' ? 'Logging in…' : account.status),
  );
  return pill;
};

const actionButton = (label, action, kind = 'ghost') => {
  const button = element('button', `button small ${kind}`, label);
  button.type = 'button';
  button.dataset.action = label;
  button.addEventListener('click', action);
  return button;
};

const startLogin = async (provider) => {
  // Open the popup with the final URL instead of scripting a blank one: embedded
  // browsers (e.g. WKWebView) hand window.open('') an unusable about:blank view.
  try {
    const ticket = await mutation(`/api/accounts/${provider}/login-ticket`, 'POST');
    if (!window.open(ticket.path, `grok-login-${provider}`)) {
      showToast('Pop-up blocked. Allow pop-ups, then use Log in on the account card.', true);
      return;
    }
    await refreshState(true, true);
  } catch (error) {
    showToast(error.message, true);
  }
};

const loginPanel = (account, isNew) => {
  const panel = element('form', 'login-panel');
  panel.append(element('p', '', account.login.progress || 'Waiting for browser authorization…'));
  const row = element('div', 'login-row');
  const input = element('input');
  input.name = 'code';
  input.autocomplete = 'off';
  input.placeholder = 'One-time code (if shown)';
  input.setAttribute('aria-label', 'One-time authorization code');
  input.dataset.action = 'code';
  const submit = element('button', 'button small primary', 'Submit code');
  submit.type = 'submit';
  row.append(input, submit);
  const cancel = element('button', 'link-button', 'Cancel login');
  cancel.type = 'button';
  cancel.dataset.action = 'Cancel login';
  cancel.addEventListener('click', async () => {
    try {
      await mutation(`/api/accounts/${account.provider}/login-cancel`, 'POST');
      await refreshState(true, true);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  panel.append(row, cancel);
  panel.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    try {
      await mutation(`/api/accounts/${account.provider}/login-code`, 'POST', {
        code: input.value,
      });
      input.value = '';
      showToast('Code submitted — finishing login…');
    } catch (error) {
      showToast(error.message, true);
    }
  });
  if (isNew) {
    panel.animate(
      [
        { opacity: 0, translate: '0 8px' },
        { opacity: 1, translate: '0 0' },
      ],
      { duration: 340, easing: 'cubic-bezier(0.22, 0.9, 0.24, 1)' },
    );
  }
  return panel;
};

const cardActions = (account) => {
  const actions = element('footer', 'card-actions');
  const activate = async () => {
    try {
      await mutation(`/api/accounts/${account.provider}/activate`, 'POST');
      await refreshState(true, true);
      showToast(`Switched to ${account.label}.`);
    } catch (error) {
      showToast(error.message, true);
    }
  };
  const rename = async () => {
    const label = await modal({
      title: `Rename ${account.label}`,
      message: "Shown here and in pi's account list. Local to this machine.",
      value: account.label,
      confirm: 'Save label',
    });
    if (label === undefined) return;
    try {
      const updated = await mutation(`/api/accounts/${account.provider}`, 'PATCH', { label });
      await refreshState(true);
      showToast(`Renamed to ${updated.label}.`);
    } catch (error) {
      showToast(error.message, true);
    }
  };
  const tokenInstructions = async () => {
    await modal({
      title: 'Remove environment login',
      message:
        'This account logs in with the GROK_CLI_OAUTH_TOKEN environment variable. Unset it and restart pi to remove the account.',
      confirm: 'Close',
      cancel: false,
    });
  };
  const destructive = async () => {
    const confirmed = await modal({
      title:
        account.provider === 'grok-cli' ? `Log out ${account.label}?` : `Remove ${account.label}?`,
      message:
        account.provider === 'grok-cli'
          ? 'Removes the saved login. The account stays in the list — log in again to use it.'
          : 'Removes this account and its saved login. You can add it again with Add account.',
      confirm: account.provider === 'grok-cli' ? 'Log out' : 'Remove account',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await mutation(
        account.provider === 'grok-cli'
          ? '/api/accounts/grok-cli/logout'
          : `/api/accounts/${account.provider}`,
        account.provider === 'grok-cli' ? 'POST' : 'DELETE',
      );
      await refreshState(true, true);
      showToast(
        `${
          account.provider === 'grok-cli'
            ? `Logged out ${account.label}.`
            : `Removed ${account.label}.`
        }${result.warning ? ` ${result.warning}` : ''}`,
      );
    } catch (error) {
      showToast(error.message, true);
    }
  };

  if (!account.authenticated && !account.environment) {
    actions.append(actionButton('Log in', () => startLogin(account.provider), 'primary'));
  } else if (!account.active && account.authenticated) {
    actions.append(actionButton('Switch', activate, 'primary'));
  }
  if (!account.environment && account.authenticated) {
    actions.append(actionButton('Log in again', () => startLogin(account.provider)));
  }
  if (account.environment) {
    actions.append(actionButton('How to remove', tokenInstructions));
  }
  actions.append(actionButton('Rename', rename));
  if (!account.environment && (account.provider !== 'grok-cli' || account.authenticated)) {
    const button = actionButton(
      account.provider === 'grok-cli' ? 'Log out' : 'Remove',
      destructive,
      'danger push-right',
    );
    actions.append(button);
  }
  return actions;
};

const accountCard = (account, index, isNewPending, refreshing) => {
  const card = element('article', `account-card${account.active ? ' active' : ''}`);
  card.dataset.provider = account.provider;
  card.style.viewTransitionName = `card-${account.provider}`;
  if (!entranceDone) {
    card.style.setProperty('--enter-delay', `${Math.min(index * 45, 220)}ms`);
  }

  const head = element('header', 'card-head');
  const titleRow = element('div', 'card-title-row');
  titleRow.append(element('h2', '', account.label));
  if (account.active) titleRow.append(element('span', 'active-badge', 'Active'));
  const metaRow = element('div', 'card-meta-row');
  metaRow.append(element('span', 'card-provider', account.provider), statusPill(account));
  if (account.plan) metaRow.append(element('span', 'plan-pill', PLAN_LABELS[account.plan]));
  head.append(titleRow, metaRow);

  const body = element('div', 'card-body');
  if (account.login.state === 'pending') {
    body.append(loginPanel(account, isNewPending));
    card.append(head, body);
    return card;
  }
  const errorText = account.login.error || account.login.quotaError;
  if (account.quota) {
    const isFree = account.plan === 'free';
    const monthly = account.quota.monthly;
    body.append(
      quotaRow(
        account.provider,
        'Monthly credits',
        isFree ? '' : `${Math.max(0, monthly.monthlyLimit - monthly.used).toLocaleString()} left`,
        isFree ? 'Not available' : `Resets ${dateLabel(monthly.billingPeriodEnd)}`,
        percent(monthly.monthlyLimit - monthly.used, monthly.monthlyLimit),
      ),
    );
    body.append(
      account.quota.weekly || isFree
        ? quotaRow(
            account.provider,
            'Weekly credits',
            '',
            !isFree && account.quota.weekly
              ? `Resets ${dateLabel(account.quota.weekly.billingPeriodEnd)}`
              : 'Not available',
            !isFree && account.quota.weekly
              ? Math.max(0, Math.min(100, 100 - account.quota.weekly.creditUsagePercent))
              : 0,
          )
        : quotaUnavailable('Weekly credits', 'Not available — try refreshing'),
    );
    const freshness = element('p', 'freshness');
    if (!refreshing && !account.quota.fresh) freshness.append(element('span', 'tag', 'Stale'));
    freshness.append(
      element(
        'span',
        '',
        refreshing ? 'Refreshing…' : `Updated ${dateLabel(account.quota.updatedAt)}`,
      ),
    );
    body.append(freshness);
  } else if (!errorText) {
    body.append(
      element(
        'p',
        'card-empty',
        account.authenticated
          ? 'No quota data yet — refresh to load usage.'
          : 'Quota appears here after login.',
      ),
    );
  }
  if (errorText) {
    body.append(element('p', 'card-error', errorText));
  }

  card.append(head, body, cardActions(account));
  return card;
};

const render = (state) => {
  statsSummary.textContent = `${state.accounts.length} account${state.accounts.length === 1 ? '' : 's'}`;
  linkState.className = 'link-pill ok';
  linkText.textContent = 'Synced';
  refreshButton.disabled = state.refreshing;
  accountsRoot.setAttribute('aria-busy', String(state.refreshing));
  accountsRoot.classList.toggle('refreshing', state.refreshing || quotaRefreshInFlight);
  updateFieldTargets(state);
  const active = document.activeElement;
  const refocus =
    active instanceof HTMLElement && accountsRoot.contains(active) && active.dataset.action
      ? {
          provider: active.closest('[data-provider]')?.dataset.provider,
          action: active.dataset.action,
        }
      : undefined;
  const codes = new Map(
    [...accountsRoot.querySelectorAll('[data-provider] input[name="code"]')]
      .map((input) => [input.closest('[data-provider]').dataset.provider, input.value])
      .filter(([, value]) => value),
  );
  if (entranceDone) accountsRoot.classList.add('settled');
  const nextPending = new Set(
    state.accounts
      .filter((account) => account.login.state === 'pending')
      .map((account) => account.provider),
  );
  // A login that left pending since the last render resolves audibly, not only visually.
  for (const provider of pendingProviders) {
    if (nextPending.has(provider)) continue;
    const account = state.accounts.find((candidate) => candidate.provider === provider);
    if (account?.login.state === 'success') showToast(`Logged in ${account.label}.`);
    if (account?.login.state === 'failed') showToast(account.login.error || 'Login failed.', true);
    if (account?.login.quotaError) showToast(account.login.quotaError, true);
  }
  // Login progress goes to a persistent live region: poll re-renders replace the
  // panel itself, so aria-live on the panel would never announce anything.
  const progress = state.accounts
    .filter((account) => account.login.state === 'pending')
    .map((account) => account.login.progress || 'Waiting for browser authorization…')
    .join(' ');
  if (progress !== lastProgress) {
    lastProgress = progress;
    if (progress) srStatus.textContent = progress;
  }
  const children = state.accounts.length
    ? state.accounts.map((account, index) =>
        accountCard(
          account,
          index,
          nextPending.has(account.provider) && !pendingProviders.has(account.provider),
          state.refreshing || quotaRefreshInFlight,
        ),
      )
    : [element('p', 'grid-message', 'No accounts configured. Use Add account to connect one.')];
  accountsRoot.replaceChildren(...children);
  pendingProviders = nextPending;
  entranceDone = true;
  for (const [provider, value] of codes) {
    const input = accountsRoot.querySelector(`[data-provider="${provider}"] input[name="code"]`);
    if (input) input.value = value;
  }
  if (refocus?.provider) {
    accountsRoot
      .querySelector(`[data-provider="${refocus.provider}"] [data-action="${refocus.action}"]`)
      ?.focus();
  }
};

// Structural, user-initiated changes (add / remove / switch / login) morph via
// the View Transitions API; everything else re-renders plainly.
const renderTransition = (state) => {
  if (
    reduceMotion.matches ||
    typeof document.startViewTransition !== 'function' ||
    accountsRoot.querySelector('input[name="code"]:focus')
  ) {
    render(state);
    return;
  }
  document.startViewTransition(() => render(state));
};

const schedule = (state) => {
  clearTimeout(timer);
  if (document.hidden) return;
  const pending =
    state.refreshing || state.accounts.some((account) => account.login.state === 'pending');
  timer = setTimeout(() => refreshState(), pending ? 2000 : 15000);
};

async function refreshState(force = false, animate = false) {
  try {
    const state = await api('/api/state');
    const serialized = JSON.stringify(state);
    if (force || wasOffline || serialized !== lastState) {
      lastState = serialized;
      if (animate) renderTransition(state);
      else render(state);
    }
    wasOffline = false;
    schedule(state);
  } catch (error) {
    clearTimeout(timer);
    linkState.className = 'link-pill error';
    linkText.textContent = 'Offline';
    accountsRoot.setAttribute('aria-busy', 'false');
    accountsRoot.classList.remove('refreshing');
    if (lastState) updateFieldTargets(JSON.parse(lastState), true);
    else field?.setTargets({ alert: 0.65, pending: 0 });
    // Keep the last good state on screen once loaded; a stale console beats a blank one.
    if (!lastState) {
      accountsRoot.replaceChildren(
        element(
          'p',
          'grid-message',
          'Dashboard connection lost. Run /grok-cli-accounts gui to reopen it.',
        ),
      );
    }
    if (!wasOffline) {
      showToast(
        error instanceof TypeError
          ? 'Connection to the dashboard server failed. Retrying…'
          : error.message,
        true,
      );
    }
    wasOffline = true;
    if (!document.hidden) timer = setTimeout(() => refreshState(), 5000);
  }
}

addAccount.addEventListener('click', async () => {
  const label = await modal({
    title: 'Add account',
    message:
      'Optional label, shown in pi and this dashboard. A browser window opens next for xAI authorization.',
    value: '',
    confirm: 'Add',
  });
  if (label === undefined) return;
  try {
    const account = await mutation('/api/accounts', 'POST', { label });
    await refreshState(true, true);
    await startLogin(account.provider);
  } catch (error) {
    showToast(error.message, true);
  }
});

refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  quotaRefreshInFlight = true;
  accountsRoot.classList.add('refreshing');
  try {
    const result = await mutation('/api/quotas/refresh', 'POST');
    showToast(
      result.failed.length
        ? `Updated ${result.updated} of ${result.updated + result.failed.length} accounts — ${result.failed.length} failed; try logging in again.`
        : `Updated ${result.updated} account${result.updated === 1 ? '' : 's'}.`,
    );
  } catch (error) {
    showToast(error.message, true);
  }
  quotaRefreshInFlight = false;
  await refreshState(true);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(timer);
    return;
  }
  void refreshState(true);
});

let lastFocusRefresh = 0;
window.addEventListener('focus', () => {
  if (Date.now() - lastFocusRefresh < 5000) return;
  lastFocusRefresh = Date.now();
  void refreshState();
});

// Cursor spotlight: proximity lights each card's border through --mx/--my/--glow
// custom properties, so the effect travels across cards without touching layout.
// Resets when the pointer leaves the grid or motion/pointer preferences change.
const setupProximity = () => {
  const media = {
    motion: matchMedia('(prefers-reduced-motion: no-preference)'),
    pointer: matchMedia('(hover: hover) and (pointer: fine)'),
  };
  let pointer;
  let frame = 0;
  const apply = () => {
    frame = 0;
    const cards = accountsRoot.querySelectorAll('.account-card');
    if (!pointer) {
      for (const card of cards) card.style.removeProperty('--glow');
      return;
    }
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const dx = Math.max(rect.left - pointer.x, 0, pointer.x - rect.right);
      const dy = Math.max(rect.top - pointer.y, 0, pointer.y - rect.bottom);
      const t = Math.max(0, 1 - Math.hypot(dx, dy) / 220);
      card.style.setProperty('--mx', `${(pointer.x - rect.left).toFixed(1)}px`);
      card.style.setProperty('--my', `${(pointer.y - rect.top).toFixed(1)}px`);
      card.style.setProperty('--glow', t.toFixed(3));
    }
  };
  const scheduleApply = () => {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  };
  accountsRoot.addEventListener('pointermove', (event) => {
    if (!media.motion.matches || !media.pointer.matches) return;
    pointer = { x: event.clientX, y: event.clientY };
    scheduleApply();
  });
  const reset = () => {
    pointer = undefined;
    scheduleApply();
  };
  accountsRoot.addEventListener('pointerleave', reset);
  window.addEventListener('scroll', scheduleApply, { passive: true });
  window.addEventListener('resize', scheduleApply);
  media.motion.addEventListener('change', reset);
  media.pointer.addEventListener('change', reset);
};
setupProximity();

void refreshState(true);
