-- Extended employee self-service / HR profile fields.
-- Run in Supabase SQL Editor (or psql). Safe to re-run.

alter table employees
  add column if not exists date_of_birth date,
  add column if not exists current_address text,
  add column if not exists permanent_address text,
  add column if not exists emergency_contacts jsonb not null default '[]'::jsonb,
  add column if not exists education jsonb not null default '[]'::jsonb,
  add column if not exists experience jsonb not null default '[]'::jsonb,
  add column if not exists medical_notes text not null default '',
  add column if not exists cnic_front_url text,
  add column if not exists cnic_back_url text,
  add column if not exists bank_account_holder_name text,
  add column if not exists iban text;

-- Backfill current_address from legacy address where missing.
update employees
   set current_address = address
 where current_address is null
   and address is not null
   and address <> '';
