import type { EventConnection, EventHandlers } from '../events';
import { getToken } from '../api';
import { connectEventPort, EVENT_NAMES } from '../eventDelivery';

export function connectVaultEvents(handlers: EventHandlers, vaultId: string | null): EventConnection {
  const params = new URLSearchParams();
  if (vaultId !== null) params.set('vault_id', vaultId);
  const token = getToken();
  if (token !== null) params.set('token', token);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const url = `/events${suffix}`;
  return connectEventPort(url, EVENT_NAMES, handlers);
}
