-- Banco de dados do projeto Contas
create table if not exists categories (
  id bigint generated always as identity primary key,
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists cards (
  id bigint generated always as identity primary key,
  name text not null unique,
  active boolean not null default true,
  closing_day smallint,
  due_day smallint,
  credit_limit numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  constraint cards_closing_day_chk check (closing_day is null or closing_day between 1 and 31),
  constraint cards_due_day_chk check (due_day is null or due_day between 1 and 31)
);

create table if not exists expenses (
  id bigint generated always as identity primary key,
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  category_id bigint references categories(id) on delete restrict,
  card_id bigint references cards(id) on delete set null,
  expense_date date not null default current_date,
  installment_total smallint check (installment_total is null or installment_total > 0),
  installment_number smallint check (installment_number is null or installment_number > 0),
  observation text,
  invoice_month date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  owner_id text
);

create index if not exists expenses_owner_date_idx on expenses(owner_id, expense_date desc);
create index if not exists expenses_date_idx on expenses(expense_date desc);
create index if not exists expenses_category_idx on expenses(category_id);
create index if not exists expenses_card_idx on expenses(card_id);

create table if not exists receivables (
  id bigint generated always as identity primary key,
  description text not null,
  expected_amount numeric(12,2) not null check (expected_amount > 0),
  due_date date not null,
  category text not null default 'Outros',
  receiving_method text,
  observation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  owner_id text
);

create table if not exists receipts (
  id bigint generated always as identity primary key,
  receivable_id bigint not null references receivables(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  received_date date not null default current_date,
  observation text,
  created_at timestamptz not null default now(),
  owner_id text
);

create index if not exists receivables_owner_date_idx on receivables(owner_id,due_date desc);
create index if not exists receipts_receivable_idx on receipts(receivable_id);


create table if not exists financial_accounts (
  id bigint generated always as identity primary key,
  name text not null unique,
  account_type text not null default 'bank',
  opening_balance numeric(12,2) not null default 0,
  active boolean not null default true,
  card_id bigint references cards(id) on delete set null,
  created_at timestamptz not null default now(),
  owner_id text
);

create table if not exists transfers (
  id bigint generated always as identity primary key,
  source_account_id bigint not null references financial_accounts(id) on delete restrict,
  destination_account_id bigint not null references financial_accounts(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  transfer_date date not null default current_date,
  transfer_type text not null default 'transfer',
  description text,
  observation text,
  created_at timestamptz not null default now(),
  owner_id text,
  constraint transfer_accounts_chk check (source_account_id <> destination_account_id)
);

create index if not exists accounts_owner_idx on financial_accounts(owner_id,active);

alter table receipts add column if not exists account_id bigint references financial_accounts(id) on delete set null;
alter table receipts add column if not exists account_id bigint references financial_accounts(id) on delete set null;
create index if not exists receipts_account_idx on receipts(account_id);
create index if not exists transfers_owner_date_idx on transfers(owner_id,transfer_date desc);
create table if not exists bank_transactions (
  id bigint generated always as identity primary key,
  account_id bigint not null references financial_accounts(id) on delete cascade,
  transaction_date date not null,
  description text not null,
  amount numeric(12,2) not null,
  external_id text,
  matched_expense_id bigint references expenses(id) on delete set null,
  matched_receipt_id bigint references receipts(id) on delete set null,
  reconciled boolean not null default false,
  imported_at timestamptz not null default now(),
  owner_id text,
  unique(account_id,external_id)
);
create index if not exists bank_transactions_owner_date_idx on bank_transactions(owner_id,transaction_date desc);
create index if not exists bank_transactions_match_idx on bank_transactions(account_id,transaction_date,amount,reconciled);

create table if not exists recurring_rules (
  id bigint generated always as identity primary key,
  rule_type text not null,
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  category_id bigint references categories(id) on delete set null,
  card_id bigint references cards(id) on delete set null,
  first_date date not null,
  next_date date not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  owner_id text,
  constraint recurring_type_chk check (rule_type in ('expense','receivable'))
);
create index if not exists recurring_owner_next_idx on recurring_rules(owner_id,next_date,active);



insert into categories (name) values
  ('Alimentação'), ('Carro'), ('Contas da casa'), ('Saúde'),
  ('Lazer'), ('Compras'), ('Educação'), ('Assinaturas'),
  ('Trabalho'), ('Outros'), ('Lanches'), ('Empréstimos feitos'),
  ('Empréstimos tomados'), ('Impostos e taxas'), ('Moto'),
  ('Transporte por aplicativo')
on conflict (name) do nothing;


insert into cards (name) values
  ('Pix'), ('Dinheiro'), ('Cartão de débito'), ('Cartão de crédito')
on conflict (name) do nothing;


update categories set active=false where name='Transporte';
