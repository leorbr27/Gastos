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
  invoice_month date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expenses_date_idx on expenses(expense_date desc);
create index if not exists expenses_category_idx on expenses(category_id);
create index if not exists expenses_card_idx on expenses(card_id);

insert into categories (name) values
  ('Alimentação'), ('Transporte'), ('Contas da casa'), ('Saúde'),
  ('Lazer'), ('Compras'), ('Educação'), ('Assinaturas'),
  ('Trabalho'), ('Outros')
on conflict (name) do nothing;
