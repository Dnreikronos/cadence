-- Spike only. Copies a value the browser stored in the user's metadata into the
-- access token as the top-level `tknonce` claim, which Turnkey checks against
-- sha256(publicKey) when it logs a user in with an OIDC token.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb := event -> 'claims';
  nonce text := claims -> 'user_metadata' ->> 'tknonce';
begin
  if nonce is not null then
    claims := jsonb_set(claims, '{tknonce}', to_jsonb(nonce));
  end if;
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
