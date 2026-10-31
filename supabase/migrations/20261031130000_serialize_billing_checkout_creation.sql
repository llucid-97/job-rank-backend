begin;

-- The checkout API creates remote Stripe objects before it can persist their
-- IDs. Keep one durable, per-user attempt so concurrent requests and retries
-- reuse the same immutable Stripe parameters and idempotency keys.
create table public.billing_checkout_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  attempt_id uuid not null unique,
  customer_create_attempt_id uuid not null,
  billing_plan_id uuid not null references public.billing_plans(id),
  plan_code text not null,
  stripe_price_id text not null,
  email_snapshot text,
  stripe_customer_id text,
  success_url text not null,
  cancel_url text not null,
  customer_create_started_at timestamptz,
  checkout_params jsonb,
  checkout_create_started_at timestamptz,
  checkout_safe_retry_after timestamptz,
  claim_token uuid,
  claim_until timestamptz not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);

-- Both the API and webhook reconcile by Stripe's globally unique session ID.
-- Enforce that conflict target explicitly before using PostgREST upsert.
create unique index if not exists billing_checkout_sessions_stripe_checkout_session_id_uidx
  on public.billing_checkout_sessions (stripe_checkout_session_id);

alter table public.billing_checkout_attempts enable row level security;
revoke all on public.billing_checkout_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.billing_checkout_attempts to service_role;

create function public.claim_billing_checkout_attempt(
  p_user_id uuid,
  p_attempt_id uuid,
  p_claim_token uuid,
  p_billing_plan_id uuid,
  p_plan_code text,
  p_stripe_price_id text,
  p_email text,
  p_success_url text,
  p_cancel_url text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz;
  checkout_attempt public.billing_checkout_attempts%rowtype;
  existing_session record;
begin
  if p_user_id is null or p_attempt_id is null or p_claim_token is null
     or p_billing_plan_id is null or p_plan_code is null or p_stripe_price_id is null
     or p_success_url is null or p_cancel_url is null then
    raise exception 'Invalid billing checkout claim arguments';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('billing-checkout:' || p_user_id::text, 0)
  );
  v_now := pg_catalog.clock_timestamp();

  if exists (
    select 1 from public.subscriptions
    where user_id = p_user_id and status in ('active', 'trialing', 'past_due', 'unpaid')
  ) then
    return pg_catalog.jsonb_build_object('status', 'subscription_exists');
  end if;

  -- Checkout completion and subscription synchronization arrive as separate
  -- Stripe webhook events. Hold admission after a completed checkout that
  -- names a subscription until its row is visible. Once synchronized, the
  -- normal active-status check above blocks paid subscriptions, while terminal
  -- statuses such as canceled can start a fresh checkout.
  if exists (
    select 1
    from public.billing_checkout_sessions checkout_session
    where checkout_session.user_id = p_user_id
      and checkout_session.status = 'complete'
      and checkout_session.stripe_subscription_id is not null
      and not exists (
        select 1
        from public.subscriptions subscription
        where subscription.user_id = p_user_id
          and subscription.stripe_subscription_id = checkout_session.stripe_subscription_id
      )
  ) then
    return pg_catalog.jsonb_build_object('status', 'subscription_sync_pending');
  end if;

  -- A synchronized subscription that is still incomplete/paused (or has an
  -- unfamiliar status) also remains associated with this completed checkout.
  -- Only terminal canceled or expired-incomplete subscriptions release it.
  if exists (
    select 1
    from public.billing_checkout_sessions checkout_session
    join public.subscriptions subscription
      on subscription.user_id = checkout_session.user_id
     and subscription.stripe_subscription_id = checkout_session.stripe_subscription_id
    where checkout_session.user_id = p_user_id
      and checkout_session.status = 'complete'
      and checkout_session.stripe_subscription_id is not null
      and subscription.status not in ('canceled', 'incomplete_expired')
  ) then
    return pg_catalog.jsonb_build_object('status', 'checkout_subscription_unresolved');
  end if;

  select stripe_checkout_session_id, checkout_url, expires_at, billing_plan_id
  into existing_session
  from public.billing_checkout_sessions
  where user_id = p_user_id and billing_plan_id = p_billing_plan_id
    and status = 'open' and expires_at > v_now
  order by created_at desc
  limit 1;
  if found then
    return pg_catalog.jsonb_build_object(
      'status', 'existing_session',
      'session', pg_catalog.to_jsonb(existing_session)
    );
  end if;

  select stripe_checkout_session_id, checkout_url, expires_at, billing_plan_id
  into existing_session
  from public.billing_checkout_sessions
  where user_id = p_user_id and status = 'open' and expires_at > v_now
  order by created_at desc
  limit 1;
  if found then
    return pg_catalog.jsonb_build_object(
      'status', 'other_plan_open',
      'session', pg_catalog.to_jsonb(existing_session)
    );
  end if;

  select * into checkout_attempt
  from public.billing_checkout_attempts
  where user_id = p_user_id
  for update;

  if found then
    if checkout_attempt.claim_until > v_now then
      return pg_catalog.jsonb_build_object('status', 'busy');
    end if;

    -- Checkout Sessions expire 24 hours after creation. Add a margin beyond
    -- the API's 120-second ceiling before rotating an unknown remote attempt.
    -- Any prior session is then no longer payable, even if Stripe pruned its
    -- idempotency key. Keep the customer-create key and frozen email separate.
    if checkout_attempt.checkout_safe_retry_after is not null
       and checkout_attempt.checkout_safe_retry_after <= v_now then
      update public.billing_checkout_attempts
      set attempt_id = p_attempt_id,
          billing_plan_id = p_billing_plan_id,
          plan_code = p_plan_code,
          stripe_price_id = p_stripe_price_id,
          success_url = p_success_url,
          cancel_url = p_cancel_url,
          checkout_params = null,
          checkout_create_started_at = null,
          checkout_safe_retry_after = null,
          claim_token = p_claim_token,
          claim_until = v_now + interval '180 seconds',
          updated_at = v_now
      where user_id = p_user_id
      returning * into checkout_attempt;
    elsif checkout_attempt.billing_plan_id <> p_billing_plan_id then
      return pg_catalog.jsonb_build_object('status', 'other_plan_in_progress');
    else
      update public.billing_checkout_attempts
      set claim_token = p_claim_token,
          claim_until = v_now + interval '180 seconds',
          updated_at = v_now
      where user_id = p_user_id
      returning * into checkout_attempt;
    end if;
  else
    insert into public.billing_checkout_attempts (
      user_id, attempt_id, customer_create_attempt_id, billing_plan_id,
      plan_code, stripe_price_id, email_snapshot, success_url, cancel_url,
      claim_token, claim_until, created_at, updated_at
    ) values (
      p_user_id, p_attempt_id, p_attempt_id, p_billing_plan_id,
      p_plan_code, p_stripe_price_id, p_email, p_success_url, p_cancel_url,
      p_claim_token, v_now + interval '180 seconds', v_now, v_now
    )
    returning * into checkout_attempt;
  end if;

  return pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'attempt', pg_catalog.to_jsonb(checkout_attempt)
  );
end;
$$;

create function public.mark_billing_checkout_customer_creation_started(
  p_user_id uuid, p_attempt_id uuid, p_claim_token uuid
) returns timestamptz
language plpgsql security invoker set search_path = '' as $$
declare
  started_at timestamptz;
begin
  update public.billing_checkout_attempts
  set customer_create_started_at = coalesce(customer_create_started_at, pg_catalog.clock_timestamp()),
      updated_at = pg_catalog.clock_timestamp()
  where user_id = p_user_id and attempt_id = p_attempt_id
    and claim_token = p_claim_token and claim_until > pg_catalog.clock_timestamp()
  returning customer_create_started_at into started_at;
  if not found then raise exception 'Billing checkout claim was lost'; end if;
  return started_at;
end;
$$;

create function public.save_billing_checkout_params(
  p_user_id uuid,
  p_attempt_id uuid,
  p_claim_token uuid,
  p_stripe_customer_id text,
  p_checkout_params jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  stored_params jsonb;
  stored_customer_id text;
begin
  if p_stripe_customer_id is null or p_checkout_params is null then
    raise exception 'Invalid billing checkout parameters';
  end if;
  update public.billing_checkout_attempts
  set stripe_customer_id = coalesce(stripe_customer_id, p_stripe_customer_id),
      checkout_params = coalesce(checkout_params, p_checkout_params),
      updated_at = pg_catalog.clock_timestamp()
  where user_id = p_user_id and attempt_id = p_attempt_id
    and claim_token = p_claim_token and claim_until > pg_catalog.clock_timestamp()
  returning checkout_params, stripe_customer_id into stored_params, stored_customer_id;
  if not found then raise exception 'Billing checkout claim was lost'; end if;
  return pg_catalog.jsonb_build_object('params', stored_params, 'customer_id', stored_customer_id);
end;
$$;

create function public.mark_billing_checkout_creation_started(
  p_user_id uuid, p_attempt_id uuid, p_claim_token uuid
) returns timestamptz
language plpgsql security invoker set search_path = '' as $$
declare
  safe_retry_after timestamptz;
begin
  update public.billing_checkout_attempts
  set checkout_create_started_at = coalesce(checkout_create_started_at, pg_catalog.clock_timestamp()),
      checkout_safe_retry_after = coalesce(
        checkout_safe_retry_after,
        pg_catalog.clock_timestamp() + interval '24 hours 3 minutes'
      ),
      updated_at = pg_catalog.clock_timestamp()
  where user_id = p_user_id and attempt_id = p_attempt_id
    and claim_token = p_claim_token and claim_until > pg_catalog.clock_timestamp()
    and checkout_params is not null
  returning checkout_safe_retry_after into safe_retry_after;
  if not found then raise exception 'Billing checkout claim was lost'; end if;
  return safe_retry_after;
end;
$$;

create function public.release_billing_checkout_attempt(
  p_user_id uuid, p_attempt_id uuid, p_claim_token uuid
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  released boolean;
begin
  update public.billing_checkout_attempts
  set claim_token = null,
      claim_until = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where user_id = p_user_id and attempt_id = p_attempt_id
    and claim_token = p_claim_token
  returning true into released;
  return coalesce(released, false);
end;
$$;

create function public.finish_billing_checkout_attempt(
  p_user_id uuid, p_attempt_id uuid, p_claim_token uuid
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  finished boolean;
begin
  delete from public.billing_checkout_attempts
  where user_id = p_user_id and attempt_id = p_attempt_id
    and claim_token = p_claim_token;
  finished := found;
  return finished;
end;
$$;

revoke all on function public.claim_billing_checkout_attempt(uuid, uuid, uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.mark_billing_checkout_customer_creation_started(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.save_billing_checkout_params(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.mark_billing_checkout_creation_started(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.release_billing_checkout_attempt(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.finish_billing_checkout_attempt(uuid, uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.claim_billing_checkout_attempt(uuid, uuid, uuid, uuid, text, text, text, text, text)
  to service_role;
grant execute on function public.mark_billing_checkout_customer_creation_started(uuid, uuid, uuid)
  to service_role;
grant execute on function public.save_billing_checkout_params(uuid, uuid, uuid, text, jsonb)
  to service_role;
grant execute on function public.mark_billing_checkout_creation_started(uuid, uuid, uuid)
  to service_role;
grant execute on function public.release_billing_checkout_attempt(uuid, uuid, uuid)
  to service_role;
grant execute on function public.finish_billing_checkout_attempt(uuid, uuid, uuid)
  to service_role;

commit;
