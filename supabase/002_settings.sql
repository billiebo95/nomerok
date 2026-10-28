-- Номерок: настройки сервиса (режим оплаты).
-- Вставить в Supabase → SQL Editor → New query → Run. Можно запускать повторно.

create table if not exists public.settings (
  key   text primary key,
  value text not null
);
alter table public.settings enable row level security;
revoke all on public.settings from anon, authenticated;

-- auto  — первые 100 объявлений бесплатно, потом платно автоматически
-- free  — всегда бесплатно
-- paid  — платно прямо сейчас
insert into public.settings (key, value) values ('pay_mode', 'auto')
on conflict (key) do nothing;
