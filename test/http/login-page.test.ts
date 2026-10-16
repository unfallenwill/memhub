import { describe, expect, it } from 'vitest';
import { escapeHtml, renderLoginPage } from '../../src/http/login-page.js';

describe('login page', () => {
  it('escapes user-controlled values', () => {
    expect(escapeHtml('<script>"a"&\'b\'</script>')).toBe(
      '&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;'
    );
  });

  it('setup state renders a password confirmation form', () => {
    const html = renderLoginPage({ state: 'setup', initialized: false });
    expect(html).toContain('Set the admin password');
    expect(html).toContain('name="password_confirm"');
    expect(html).toContain('action="/oauth/device/authorize"');
  });

  it('login state renders a single password field', () => {
    const html = renderLoginPage({ state: 'login', initialized: true });
    expect(html).toContain('Authorize this device');
    expect(html).not.toContain('password_confirm');
  });

  it('prefills and escapes the device code', () => {
    const html = renderLoginPage({
      state: 'login',
      initialized: true,
      prefilledCode: 'ABCD-1234',
    });
    expect(html).toContain('value="ABCD-1234"');
    const evil = renderLoginPage({
      state: 'login',
      initialized: true,
      prefilledCode: '"><script>alert(1)</script>',
    });
    expect(evil).not.toContain('<script>');
    expect(evil).toContain('&lt;script&gt;');
  });

  it('renders the not-initialized hint without a form', () => {
    const html = renderLoginPage({ state: 'not_initialized_bare', initialized: false });
    expect(html).toContain('memhub login');
    expect(html).not.toContain('<form');
  });

  it('renders error states with a retry path', () => {
    expect(renderLoginPage({ state: 'error_invalid', initialized: true })).toContain(
      'Wrong device code or password'
    );
    expect(renderLoginPage({ state: 'error_denied', initialized: true })).toContain('denied');
    expect(renderLoginPage({ state: 'error_missing', initialized: true })).toContain(
      'unknown or expired'
    );
  });

  it('error states with a code render a prefilled retry form', () => {
    const html = renderLoginPage({
      state: 'error_invalid',
      initialized: true,
      prefilledCode: 'ABCD-1234',
    });
    expect(html).toContain('<form');
    expect(html).toContain('value="ABCD-1234"');
  });
});
