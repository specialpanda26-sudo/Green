-- Greenline Buses. Run once in Supabase > SQL Editor. Safe to run again.
create extension if not exists pgcrypto;

create table if not exists settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  route text not null,
  travel_date date not null,
  seats text[] not null,
  pax jsonb not null default '{}'::jsonb,
  phone text not null,
  coach text,
  total integer not null check (total > 0),
  status text not null default 'pending' check (status in ('pending','paid','failed','expired','cancelled','review')),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  email text,
  emailed_at timestamptz
);
create index if not exists bookings_trip on bookings(travel_date, route);
create index if not exists bookings_phone on bookings(phone);

-- One row per held or sold seat. The primary key makes double booking impossible.
create table if not exists booked_seats (
  route text not null,
  travel_date date not null,
  seat text not null,
  booking_id uuid not null references bookings(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (route, travel_date, seat)
);
create index if not exists booked_seats_booking on booked_seats(booking_id);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  request_id text not null unique,
  checkout_id text,
  phone text not null,
  amount integer not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending','paid','failed','expired','underpaid')),
  receipt text,
  fail_reason text,
  fail_code integer,
  note text,
  ip text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists payments_created on payments(created_at desc);
create index if not exists payments_status on payments(status, created_at desc);
create index if not exists payments_booking on payments(booking_id);

create table if not exists payhero_events (
  id uuid primary key default gen_random_uuid(),
  ref text,
  status text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text,
  email text,
  message text not null,
  booking_ref text,
  status text not null default 'open' check (status in ('open','replied','closed')),
  admin_note text,
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
create index if not exists support_status on support_messages(status, created_at desc);

-- Only the server (service key) may touch these tables.
-- For a database made before email tickets existed (safe to run again):
alter table bookings add column if not exists email text;
alter table bookings add column if not exists emailed_at timestamptz;

alter table settings enable row level security;
alter table bookings enable row level security;
alter table booked_seats enable row level security;
alter table payments enable row level security;
alter table payhero_events enable row level security;
alter table support_messages enable row level security;
