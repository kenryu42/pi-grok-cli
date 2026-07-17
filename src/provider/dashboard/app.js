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

let lastState = '';
let wasOffline = false;
let entranceDone = false;
let timer;

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

const quotaRow = (label, usedLabel, reset, value) => {
  const row = element('div', 'quota');
  const header = element('div', 'quota-head');
  header.append(element('span', '', label), element('span', 'quota-pct', `${Math.round(value)}%`));
  const meter = element('div', `meter${value >= 95 ? ' danger' : value >= 75 ? ' warning' : ''}`);
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-label', `${label}: ${Math.round(value)} percent used`);
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', String(Math.round(value)));
  const fill = element('div', 'meter-fill');
  fill.style.setProperty('--meter-value', `${value}%`);
  meter.append(fill);
  const meta = element('div', 'quota-meta');
  if (usedLabel) meta.append(element('span', 'mono', usedLabel));
  meta.append(element('span', '', `Resets ${dateLabel(reset)}`));
  row.append(header, meter, meta);
  return row;
};

const quotaUnavailable = (label, reason) => {
  const row = element('div', 'quota');
  const header = element('div', 'quota-head');
  header.append(element('span', '', label));
  row.append(header, element('p', 'quota-unavailable', reason));
  return row;
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
    await refreshState(true);
  } catch (error) {
    showToast(error.message, true);
  }
};

const loginPanel = (account) => {
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
      await refreshState(true);
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
  return panel;
};

const cardActions = (account) => {
  const actions = element('footer', 'card-actions');
  const activate = async () => {
    try {
      await mutation(`/api/accounts/${account.provider}/activate`, 'POST');
      await refreshState(true);
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
      await mutation(`/api/accounts/${account.provider}`, 'PATCH', { label });
      await refreshState(true);
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
      await mutation(
        account.provider === 'grok-cli'
          ? '/api/accounts/grok-cli/logout'
          : `/api/accounts/${account.provider}`,
        account.provider === 'grok-cli' ? 'POST' : 'DELETE',
      );
      await refreshState(true);
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
  if (!account.environment) {
    const button = actionButton(
      account.provider === 'grok-cli' ? 'Log out' : 'Remove',
      destructive,
      'danger push-right',
    );
    actions.append(button);
  }
  return actions;
};

const accountCard = (account, index) => {
  const card = element('article', `account-card${account.active ? ' active' : ''}`);
  card.dataset.provider = account.provider;
  card.style.animationDelay = `${Math.min(index * 40, 200)}ms`;

  const head = element('header', 'card-head');
  const titleRow = element('div', 'card-title-row');
  titleRow.append(element('h3', '', account.label));
  if (account.active) titleRow.append(element('span', 'active-badge', 'Active'));
  const metaRow = element('div', 'card-meta-row');
  metaRow.append(element('span', 'card-provider', account.provider), statusPill(account));
  head.append(titleRow, metaRow);

  const body = element('div', 'card-body');
  if (account.login.state === 'pending') {
    body.append(loginPanel(account));
    card.append(head, body);
    return card;
  }
  const errorText = account.login.error || account.login.quotaError;
  if (account.quota) {
    body.append(
      quotaRow(
        'Monthly credits',
        `${account.quota.monthly.used.toLocaleString()} / ${account.quota.monthly.monthlyLimit.toLocaleString()} used`,
        account.quota.monthly.billingPeriodEnd,
        percent(account.quota.monthly.used, account.quota.monthly.monthlyLimit),
      ),
    );
    body.append(
      account.quota.weekly
        ? quotaRow(
            'Weekly credits',
            '',
            account.quota.weekly.billingPeriodEnd,
            Math.max(0, Math.min(100, account.quota.weekly.creditUsagePercent)),
          )
        : quotaUnavailable('Weekly credits', 'Not available — try refreshing'),
    );
    const freshness = element('p', 'freshness');
    if (!account.quota.fresh) freshness.append(element('span', 'tag', 'Stale'));
    freshness.append(element('span', '', `Updated ${dateLabel(account.quota.updatedAt)}`));
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
  const online = state.accounts.filter((account) => account.authenticated).length;
  statsSummary.textContent = `${state.accounts.length} account${state.accounts.length === 1 ? '' : 's'} · ${online} logged in`;
  linkState.className = 'link-pill ok';
  linkText.textContent = 'Synced';
  refreshButton.disabled = state.refreshing;
  refreshButton.classList.toggle('is-refreshing', state.refreshing);
  accountsRoot.setAttribute('aria-busy', String(state.refreshing));
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
  const children = state.accounts.length
    ? state.accounts.map(accountCard)
    : [element('p', 'grid-message', 'No accounts configured. Use Add account to connect one.')];
  accountsRoot.replaceChildren(...children);
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

const schedule = (state) => {
  clearTimeout(timer);
  if (document.hidden) return;
  const pending =
    state.refreshing || state.accounts.some((account) => account.login.state === 'pending');
  timer = setTimeout(() => refreshState(), pending ? 2000 : 15000);
};

async function refreshState(force = false) {
  try {
    const state = await api('/api/state');
    const serialized = JSON.stringify(state);
    if (force || wasOffline || serialized !== lastState) {
      lastState = serialized;
      render(state);
    }
    wasOffline = false;
    schedule(state);
  } catch (error) {
    clearTimeout(timer);
    linkState.className = 'link-pill error';
    linkText.textContent = 'Offline';
    accountsRoot.setAttribute('aria-busy', 'false');
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
    confirm: 'Add and log in',
  });
  if (label === undefined) return;
  try {
    const account = await mutation('/api/accounts', 'POST', { label });
    await refreshState(true);
    await startLogin(account.provider);
  } catch (error) {
    showToast(error.message, true);
  }
});

refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshButton.classList.add('is-refreshing');
  try {
    const result = await mutation('/api/quotas/refresh', 'POST');
    showToast(
      result.failed.length
        ? `Updated ${result.updated} of ${result.updated + result.failed.length} accounts — ${result.failed.length} failed; try logging in again.`
        : `Updated ${result.updated} account${result.updated === 1 ? '' : 's'}.`,
    );
    await refreshState(true);
  } catch (error) {
    showToast(error.message, true);
    await refreshState(true);
  }
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
void refreshState(true);
