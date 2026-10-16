import { useEffect, useState } from 'preact/hooks';
import { getDevices, isUnauthorized, revokeDevice } from '../api.js';
import { formatTime } from '../format.js';

/** Authorized devices (memhub login) with per-device revocation. */
export default function DevicesView() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    getDevices()
      .then(data => setDevices(data.devices ?? []))
      .catch(err => setError(err))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const onRevoke = id => {
    const device = devices.find(candidate => candidate.id === id);
    const label = device ? device.label : `#${id}`;
    if (!window.confirm(`Revoke the token for "${label}"? That device will need to log in again.`)) {
      return;
    }
    revokeDevice(id)
      .then(load)
      .catch(err => setError(err));
  };

  if (isUnauthorized(error)) {
    return (
      <section class="view">
        <h1 class="view-title">Devices</h1>
        <p class="error">
          This MemHub server requires a login. Run{' '}
          <code>memhub login &lt;server URL&gt;</code> on a device to authorize it.
        </p>
      </section>
    );
  }

  return (
    <section class="view">
      <h1 class="view-title">Devices</h1>
      {error && !isUnauthorized(error) ? <p class="error">{error.message}</p> : null}
      {devices.length === 0 && !loading ? (
        <p class="empty">No devices have logged in yet.</p>
      ) : null}
      <ul class="device-list">
        {devices.map(device => (
          <li key={device.id} class={`device-item${device.revoked_at ? ' revoked' : ''}`}>
            <span class="device-label">
              {device.label}
              {device.current ? <span class="device-current">this session</span> : null}
            </span>
            <span class="device-meta">
              authorized {formatTime(device.created_at)}
              {device.last_used_at ? ` · last used ${formatTime(device.last_used_at)}` : ''}
              {device.revoked_at ? ` · revoked ${formatTime(device.revoked_at)}` : ''}
            </span>
            {device.revoked_at ? null : (
              <button type="button" class="device-revoke" onClick={() => onRevoke(device.id)}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      {loading ? <p class="hint">Loading…</p> : null}
    </section>
  );
}
