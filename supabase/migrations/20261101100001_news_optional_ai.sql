-- Optional public-keyword inference only. No private user data is stored here.
alter table public.news_articles add column ai_category text check (ai_category in ('event','support','facility','health','community'));
alter table public.news_articles add column ai_summary text check (char_length(ai_summary) <= 80);
create table public.news_ai_cache (
  key text primary key check (key ~ '^[a-f0-9]{64}$'),
  result jsonb,
  created_at timestamptz not null default now()
);
create table public.news_ai_budget (
  day date primary key,
  calls integer not null check (calls between 1 and 20)
);
alter table public.news_ai_cache enable row level security;
alter table public.news_ai_budget enable row level security;
revoke all on public.news_ai_cache, public.news_ai_budget from public, anon, authenticated;
grant select, insert, update on public.news_ai_cache, public.news_ai_budget to service_role;
create function public.claim_news_ai_call(p_day date, p_limit integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare claimed integer;
begin
  if p_day is distinct from (now() at time zone 'UTC')::date or p_limit is null or p_limit < 1 or p_limit > 20 then return false; end if;
  insert into public.news_ai_budget(day,calls) values (p_day,1)
  on conflict(day) do update set calls = public.news_ai_budget.calls + 1
  where public.news_ai_budget.calls < p_limit
  returning calls into claimed;
  return claimed is not null;
end;
$$;
revoke all on function public.claim_news_ai_call(date,integer) from public,anon,authenticated;
grant execute on function public.claim_news_ai_call(date,integer) to service_role;
