/**
 * The /login page: a zero-Java HTML form for the device flow.
 *
 * Rendered inline (no webDist dependency) so first-run setup works even
 * when the SPA has not been built. All user-controlled values are
 * escaped; the page sets a restrictive CSP and is never cached.
 */

/** Page states, driven by query params and the auth setup state. */
export type LoginPageState =
  | 'setup'
  | 'login'
  | 'success'
  | 'error_invalid'
  | 'error_denied'
  | 'error_missing'
  | 'not_initialized_bare';

/** Options for renderLoginPage. */
export interface LoginPageOptions {
  /** User code to prefill into the form (from ?code=). */
  readonly prefilledCode?: string | undefined;
  readonly state: LoginPageState;
  /** Whether the admin password has been initialized. */
  readonly initialized: boolean;
  /** Path of the setup code file on the server (first login only). */
  readonly setupCodePath?: string | undefined;
}

/** Escape a value for safe interpolation into HTML text/attributes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 26rem; margin: 4rem auto;
         padding: 0 1.25rem; }
  h1 { font-size: 1.35rem; }
  p.hint { color: gray; }
  label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font: inherit;
          border: 1px solid #888; border-radius: 4px; }
  input.code { font-family: ui-monospace, monospace; letter-spacing: 0.08em;
               text-transform: uppercase; }
  button { margin-top: 1.25rem; padding: 0.55rem 1.4rem; font: inherit; font-weight: 600;
           border: 0; border-radius: 4px; background: #2563eb; color: #fff; cursor: pointer; }
  .ok { color: #15803d; font-weight: 600; }
  .err { color: #b91c1c; font-weight: 600; }
`;

interface FormSpec {
  readonly heading: string;
  readonly intro: string;
  readonly confirmField: boolean;
  readonly setupCodeField: boolean;
  readonly submitLabel: string;
}

function formSpec(state: LoginPageState, setupCodePath: string | undefined): FormSpec {
  if (state === 'setup') {
    const where = setupCodePath
      ? ` on the server: <code>cat ${escapeHtml(setupCodePath)}</code>`
      : ' on the server (the setup-code file in the MemHub data directory)';
    return {
      heading: 'Set the admin password',
      intro:
        'This is the first login. Enter the setup code — found' +
        ` ${where} — then choose the administrator password for this MemHub server.`,
      confirmField: true,
      setupCodeField: true,
      submitLabel: 'Set password and authorize',
    };
  }
  return {
    heading: 'Authorize this device',
    intro: 'Enter the admin password to allow the device that started this login.',
    confirmField: false,
    setupCodeField: false,
    submitLabel: 'Authorize',
  };
}

/** Render the full HTML document for /login. */
export function renderLoginPage(options: LoginPageOptions): string {
  const { state, initialized } = options;
  // Forms render for the plain states and for retries (error_* with the
  // device code still in the URL); bare error pages only when the code
  // is gone, so the user is told to restart the login from the CLI.
  const formState: 'setup' | 'login' | null =
    state === 'setup' || state === 'login'
      ? state
      : state === 'error_invalid' || state === 'error_denied' || state === 'error_missing'
        ? options.prefilledCode !== undefined
          ? initialized
            ? 'login'
            : 'setup'
          : null
        : null;
  const spec = formState !== null ? formSpec(formState, options.setupCodePath) : null;
  const code = escapeHtml(options.prefilledCode ?? '');

  let message = '';
  if (state === 'success') {
    message = '<p class="ok">The device was authorized. You can return to the terminal.</p>';
  } else if (state === 'error_denied') {
    message =
      '<p class="err">Too many wrong attempts — this login was denied. Start it again from the CLI.</p>';
  } else if (state === 'error_missing') {
    message =
      '<p class="err">That device code is unknown or expired. Start the login again from the CLI.</p>';
  } else if (state === 'error_invalid') {
    message = '<p class="err">Wrong device code or password. Check both and try again.</p>';
  }

  let body: string;
  if (spec !== null) {
    const confirmField = spec.confirmField
      ? `<label for="password_confirm">Repeat password</label>
         <input type="password" id="password_confirm" name="password_confirm"
                autocomplete="new-password" required minlength="8">`
      : '';
    const setupCodeField = spec.setupCodeField
      ? `<label for="setup_code">Setup code</label>
         <input class="code" id="setup_code" name="setup_code"
                maxlength="13" autocomplete="one-time-code" required autofocus>`
      : '';
    const passwordAutofocus = spec.setupCodeField ? '' : ' autofocus';
    body = `
<h1>${spec.heading}</h1>
<p>${spec.intro}</p>
${message}
<form method="POST" action="/oauth/device/authorize">
  <label for="user_code">Device code</label>
  <input class="code" id="user_code" name="user_code" value="${code}"
         maxlength="12" autocomplete="off"${passwordAutofocus} required>
  ${setupCodeField}
  <label for="password">Admin password</label>
  <input type="password" id="password" name="password"
         autocomplete="${spec.confirmField ? 'new-password' : 'current-password'}" required minlength="8">
  ${confirmField}
  <button type="submit">${spec.submitLabel}</button>
</form>`;
  } else if (state === 'success') {
    body = `
<h1>Authorized</h1>
${message}`;
  } else if (state === 'not_initialized_bare') {
    body = `
<h1>MemHub</h1>
<p>Remote login is not set up yet. Start it from a device:</p>
<pre>memhub login --base-url &lt;this server URL&gt;</pre>
<p class="hint">The first login sets the admin password and needs the setup code
from the server's MemHub data directory, so it must be started by the server
owner from a CLI.</p>`;
  } else {
    body = `
<h1>Authorization failed</h1>
${message}
<p><a href="/login">Start over</a></p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemHub login</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Response headers every login page response must carry. */
export const LOGIN_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
