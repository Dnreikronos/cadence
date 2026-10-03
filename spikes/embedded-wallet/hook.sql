-- Spike only. Copies a value the browser stored in the user's metadata into the
-- access token as the top-level `tknonce` claim, which Turnkey checks against
-- sha256(publicKey) when it logs a user in with an OIDC token.
--
-- The value is copied only when it is a string of 64 lowercase hex characters (what
-- sha256 produces), so user-controlled metadata cannot put anything else into the
-- token. A pure function: it never raises, and an invalid value is just ignored.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event -> 'claims';
  nonce jsonb := claims -> 'user_metadata' -> 'tknonce';
begin
  if jsonb_typeof(nonce) = 'string' and (nonce #>> '{}') ~ '^[0-9a-f]{64}$' then
    claims := jsonb_set(claims, '{tknonce}', nonce);
  end if;
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public, service_role;
