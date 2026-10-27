-- Номерок: таблица объявлений.
-- Вставить целиком в Supabase → SQL Editor → New query → Run.

create table if not exists public.listings (
  id              bigint generated always as identity primary key,
  l1              text   not null,             -- первая буква
  d               text   not null,             -- три цифры
  l2              text   not null,             -- две буквы
  r               text   not null,             -- код региона
  price           bigint not null check (price >= 0),
  city            text   not null default '',
  descr           text   not null default '',
  seller_tg_id    bigint not null,             -- Telegram ID продавца (не показывается покупателям)
  seller_name     text   not null default '',
  seller_username text,                        -- @username из Telegram
  wa              text,                        -- номер WhatsApp, 11 цифр
  status          text   not null default 'pending'
                  check (status in ('pending','active','sold','rejected','removed')),
  created_at      timestamptz not null default now(),
  approved_at     timestamptz
);

create index if not exists listings_status_idx on public.listings (status, approved_at desc);
create index if not exists listings_seller_idx on public.listings (seller_tg_id);

-- Прямого доступа к таблице у сайта нет: писать в неё может только серверная функция.
alter table public.listings enable row level security;
revoke all on public.listings from anon, authenticated;

-- Публичная лента: только одобренные объявления и только безопасные поля.
create or replace view public.active_listings as
  select id, l1, d, l2, r, price, city, descr,
         seller_name, seller_username, wa,
         coalesce(approved_at, created_at) as published_at
  from public.listings
  where status = 'active';

revoke all on public.active_listings from anon, authenticated;
grant select on public.active_listings to anon, authenticated;
