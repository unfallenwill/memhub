/**
 * The retry form of the login page (src/http/login-page.ts).
 *
 * An error state that still carries the device code renders a retry
 * form. Whether that form asks for a new password or for the first
 * admin password depends on whether the server is initialized yet.
 */

import { describe, expect, it } from 'vitest';
import { renderLoginPage } from '../../src/http/login-page.js';

describe('the retry form of the login page', () => {
  it('asks for the first admin password on a server without one', () => {
    const html = renderLoginPage({
      state: 'error_invalid',
      initialized: false,
      prefilledCode: 'ABCD-1234',
    });

    expect(html).toContain('Set the admin password');
    expect(html).toContain('name="password_confirm"');
    expect(html).toContain('value="ABCD-1234"');
  });

  it('asks for the password on an initialized server', () => {
    const html = renderLoginPage({
      state: 'error_denied',
      initialized: true,
      prefilledCode: 'ABCD-1234',
    });

    expect(html).toContain('Authorize this device');
    expect(html).not.toContain('password_confirm');
  });
});
