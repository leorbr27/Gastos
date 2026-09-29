-- Banco de dados do projeto Gastos
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
