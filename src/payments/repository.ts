import { getSupabase, isSupabaseConfigured } from '../lib/supabase.js';
import { HttpError } from '../domain/workspace.js';
import type { Adjustment, Attempt, Provider, Verification } from './providers.js';

function database() {
  if (!isSupabaseConfigured()) throw new HttpError(503, 'Payment storage is not configured');
  return getSupabase();
}
function failure(error: { code?: string; message?: string }): never {
  if (error.code === 'P0002') throw new HttpError(404, 'Checkout not found');
  if (error.code === 'P0001') throw new HttpError(409, error.message || 'Checkout changed. Please refresh.');
  console.error('Checkout storage error:', error.code);
  throw new HttpError(503, 'Payment storage is unavailable. Please retry; do not start another payment.');
}
export const paymentRepository = {
  async pending(): Promise<Attempt[]> {
    const { data, error } = await database().from('checkout_attempts').select('*').in('status', ['initializing','pending']).lt('updated_at', new Date(Date.now() - 60000).toISOString()).order('updated_at').limit(25);
    if (error) failure(error); return data ?? [];
  },
  async touched(id: string) {
    const { error } = await database().from('checkout_attempts').update({ updated_at: new Date().toISOString() }).eq('id', id);
    if (error) failure(error);
  },
  async reserve(input: { code: string; provider: Provider; live: boolean; choice: 'deposit' | 'full'; email: string; key: string; returnURL: string }): Promise<Attempt> {
    const { data, error } = await database().rpc('reserve_checkout', { p_code: input.code, p_provider: input.provider, p_live: input.live, p_choice: input.choice, p_email: input.email, p_key: input.key, p_return_url: input.returnURL });
    if (error) failure(error);
    return data;
  },
  async find(field: 'id' | 'provider_reference' | 'provider_transaction', value: string, provider?: Provider): Promise<Attempt | null> {
    let query = database().from('checkout_attempts').select('*').eq(field, value);
    if (provider) query = query.eq('provider', provider);
    const { data, error } = await query.maybeSingle(); if (error) failure(error); return data;
  },
  async active(code: string): Promise<Attempt | null> {
    const { data, error } = await database().from('checkout_attempts').select('*').eq('reservation_code', code).in('status', ['initializing','pending']).maybeSingle();
    if (error) failure(error); return data;
  },
  async claim(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const { data, error } = await database().from('checkout_attempts').update({ lease_until: new Date(Date.now() + 60000).toISOString() }).eq('id', id).eq('status', 'initializing').or(`lease_until.is.null,lease_until.lt.${now}`).select('id');
    if (error) failure(error); return Boolean(data?.length);
  },
  async initialized(id: string, session: string, url: string): Promise<void> {
    // A webhook can settle while initialization is in flight. Never downgrade a successful attempt.
    const { error } = await database().from('checkout_attempts').update({ provider_session: session, checkout_url: url, status: 'pending', lease_until: null, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'initializing');
    if (error) failure(error);
  },
  async expire(id: string) {
    const { error } = await database().from('checkout_attempts').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending').eq('provider', 'stripe');
    if (error) failure(error);
  },
  async adjust(id: string, value: Adjustment) {
    const { error } = await database().rpc('adjust_checkout', { p_id: id, p_external: value.external, p_kind: value.kind, p_amount: value.amount });
    if (error) failure(error);
  },
  async settle(id: string, result: Verification): Promise<Attempt> {
    const { data, error } = await database().rpc('settle_checkout', { p_id: id, p_transaction: result.transaction, p_amount: result.amount, p_currency: result.currency, p_live: result.live });
    if (error) failure(error); return data;
  },
};
