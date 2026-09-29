import pg from "pg";
import { attachDatabasePool } from "@neon/functions";
import { createRemoteJWKSet, jwtVerify } from "jose";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });
const AUTH_BASE=String(process.env.NEON_AUTH_BASE_URL||"").replace(/\/$/,"");
const JWKS_URL=String(process.env.NEON_AUTH_JWKS_URL||"").trim() || (AUTH_BASE ? AUTH_BASE+"/.well-known/jwks.json" : "");
const JWKS=JWKS_URL ? createRemoteJWKSet(new URL(JWKS_URL)) : null;
attachDatabasePool(pool);

let schemaReady;
async function ensureSchema() {
  if(schemaReady) return schemaReady;
  schemaReady=(async()=>{
  await pool.query(`
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
    alter table cards add column if not exists credit_limit numeric(12,2) not null default 0;
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
    alter table expenses add column if not exists owner_id text;
    alter table expenses add column if not exists observation text;
    create index if not exists expenses_owner_date_idx on expenses(owner_id,expense_date desc);
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
    alter table receipts add column if not exists account_id bigint references financial_accounts(id) on delete set null;
        alter table receipts add column if not exists account_id bigint references financial_accounts(id) on delete set null;
    create index if not exists receipts_account_idx on receipts(account_id);
    create index if not exists accounts_owner_idx on financial_accounts(owner_id,active);
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
    insert into categories(name) values
      ('Alimentação'),('Carro'),('Contas da casa'),('Saúde'),('Lazer'),
      ('Alimentação'),('Transporte'),('Contas da casa'),('Saúde'),('Lazer'),
      ('Compras'),('Educação'),('Assinaturas'),('Trabalho'),('Outros'),('Lanches'),
      ('Empréstimos feitos'),('Empréstimos tomados'),('Impostos e taxas'),('Moto'),('Transporte por aplicativo')
    on conflict(name) do nothing;

    await pool.query(`update expenses set category_id=(select id from categories where name='Carro' limit 1) where category_id=(select id from categories where name='Transporte' limit 1);`);
    await pool.query(`update categories set active=false where name='Transporte';`);
    update expenses e set invoice_month=(date_trunc('month',e.expense_date)+case when extract(day from e.expense_date)>coalesce(c.closing_day,31) then interval '1 month' else interval '0 month' end)::date
      from cards c where c.id=e.card_id and e.invoice_month is null;
    insert into cards(name) values
      ('Pix'),('Dinheiro'),('Cartão de débito'),('Cartão de crédito')
    on conflict(name) do nothing;
  `);
  })();
  try { await schemaReady; } catch(e) { schemaReady=null; throw e; }
  return schemaReady;
}

const ALLOWED_ORIGIN = "https://leorbr27.github.io";
const headers = (origin) => ({
  "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : "null",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8"
});
const json = (data,status,origin) => new Response(JSON.stringify(data),{status,headers:headers(origin)});
const text = (v,max=200) => String(v ?? "").trim().slice(0,max);
const idOf = v => Number.isInteger(Number(v)) && Number(v)>0 ? Number(v) : null;
async function requireUser(request){
  if(!JWKS) throw new Error("AUTH_NOT_CONFIGURED");
  const raw=request.headers.get("authorization")||"";
  if(!/^Bearer\s+/i.test(raw)) throw new Error("AUTH_REQUIRED");
  try { const {payload}=await jwtVerify(raw.replace(/^Bearer\s+/i,"").trim(),JWKS); const sub=String(payload.sub||"").trim(); if(!sub) throw new Error("AUTH_REQUIRED"); return sub; }
  catch(e){ if(e?.message==="AUTH_REQUIRED") throw e; throw new Error("AUTH_INVALID"); }
}

async function expenseQuery(where="", params=[], limit=null, offset=0) {
  const r=await pool.query(`select e.id,e.description,e.amount,e.expense_date,e.created_at,e.updated_at,e.observation,e.category_id,c.name category_name,
    e.card_id,ca.name card_name,e.installment_total,e.installment_number,e.invoice_month
    from expenses e
    left join categories c on c.id=e.category_id
    left join cards ca on ca.id=e.card_id
    ${where} order by e.expense_date desc,e.id desc ${limit!==null?`limit ${Math.max(1,Math.min(100,Number(limit)))} offset ${Math.max(0,Number(offset)||0)}`:""}`,params);
  return r.rows;
}

export default async function handler(request) {
  const origin=request.headers.get("origin")||"";
  if(request.method==="OPTIONS") return origin===ALLOWED_ORIGIN ? new Response(null,{status:204,headers:headers(origin)}) : new Response(null,{status:403,headers:headers(origin)});
  if(origin!==ALLOWED_ORIGIN) return json({error:"Origem não autorizada."},403,origin);
  const url=new URL(request.url);
  const path=url.pathname.replace(/\/+$/,"")||"/";
  try {
    await ensureSchema();
    const isPublicBootstrap=request.method==="GET" && (path==="/" || path.endsWith("/bootstrap"));
    const isPublicCreateExpense=request.method==="POST" && path.endsWith("/expenses");
    const isPublicCreateCard=request.method==="POST" && path.endsWith("/cards");
    const userId=(path==="/auth-config" || isPublicBootstrap || isPublicCreateExpense || isPublicCreateCard || (request.method==="POST" && path.endsWith("/receivables")))?null:await requireUser(request);
    if(userId) await pool.query("update expenses set owner_id=$1 where owner_id is null",[userId]);

    if(request.method==="GET" && path==="/auth-config") return json({auth_url:AUTH_BASE},200,origin);

    if(request.method==="GET" && path==="/version") return json({api_version:"2026.09.29.7",schema_version:9,auth:true,pagination:true,receivables:true,partial_receipts:true,accounts:true,transfers:true},200,origin);

    if(request.method==="GET" && (path==="/" || path.endsWith("/bootstrap"))) {
      const [categories,cards]=await Promise.all([
        pool.query("select id,name from categories where active=true order by name"),
        pool.query("select id,name,closing_day,due_day,credit_limit from cards where active=true order by case when name='Pix' then 0 when name='Dinheiro' then 1 else 2 end,name"),
      ]);
      return json({categories:categories.rows,cards:cards.rows},200,origin);
    }

    if(request.method==="GET" && path.endsWith("/receivables")) {
      const rows=await pool.query(`select r.id,r.description,r.expected_amount,r.due_date,r.category,r.receiving_method,r.observation,r.created_at,r.updated_at,coalesce(sum(p.amount),0)::numeric(12,2) received_amount
        from receivables r left join receipts p on p.receivable_id=r.id
        where (r.owner_id=$1 or r.owner_id is null)
        group by r.id order by r.due_date desc,r.id desc limit ${Math.min(100,Math.max(1,Number(url.searchParams.get("limit")||50)||50))} offset ${Math.max(0,Number(url.searchParams.get("offset")||0)||0)}`,[userId]);
      return json({receivables:rows.rows},200,origin);
    }

    if(request.method==="POST" && path.endsWith("/receivables")) {
      const b=await request.json().catch(()=>null);
      const description=text(b?.description,200),expected=Number(b?.expected_amount),due=text(b?.due_date,10),category=text(b?.category,100)||"Outros",method=text(b?.receiving_method,100),observation=text(b?.observation,500);
      if(!description||!Number.isFinite(expected)||expected<=0||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(due))return json({error:"Descrição, valor e data prevista válidos são obrigatórios."},400,origin);
      const r=await pool.query(`insert into receivables(description,expected_amount,due_date,category,receiving_method,observation,owner_id) values($1,$2,$3,$4,$5,$6,$7) returning id,description,expected_amount,due_date,category,receiving_method,observation,created_at,updated_at`,[description,Math.round(expected*100)/100,due,category,method,observation,userId]);
      return json({...r.rows[0],received_amount:0},201,origin);
    }

    if(request.method==="POST" && /\/receivables\/\d+\/receipts$/.test(path)) {
      const id=Number(path.match(/(\d+)\/receipts$/)[1]),b=await request.json().catch(()=>null),amount=Number(b?.amount),receivedDate=text(b?.received_date,10)||new Date().toISOString().slice(0,10),observation=text(b?.observation,500),accountId=idOf(b?.account_id);
      if(!Number.isFinite(amount)||amount<=0||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(receivedDate))return json({error:"Valor e data do recebimento são obrigatórios."},400,origin);
      if(accountId){
        const a=await pool.query("select id,account_type from financial_accounts where id=$1 and (owner_id=$2 or owner_id is null)",[accountId,userId]);
        if(!a.rowCount||a.rows[0].account_type==="credit_card")return json({error:"Selecione uma conta bancária ou dinheiro para receber o valor."},400,origin);
      }
      const owner=await pool.query("select owner_id,expected_amount from receivables where id=$1 and (owner_id=$2 or owner_id is null)",[id,userId]);
      if(!owner.rowCount)return json({error:"Recebimento não encontrado."},404,origin);
      const sum=await pool.query("select coalesce(sum(amount),0) total from receipts where receivable_id=$1",[id]);
      if(Number(sum.rows[0].total)+amount>Number(owner.rows[0].expected_amount)+0.009)return json({error:"O valor recebido não pode ultrapassar o valor previsto."},400,origin);
      const r=await pool.query("insert into receipts(receivable_id,amount,received_date,observation,owner_id,account_id) values($1,$2,$3,$4,$5,$6) returning id,receivable_id,amount,received_date,observation,account_id,created_at",[id,Math.round(amount*100)/100,receivedDate,observation,userId,accountId]);
      return json(r.rows[0],201,origin);
    }

    if(request.method==="GET" && path.endsWith("/recurring")) {
      const rows=await pool.query("select id,rule_type,description,amount,category_id,card_id,first_date,next_date,active,created_at from recurring_rules where owner_id=$1 order by next_date,id",[userId]);
      return json({rules:rows.rows},200,origin);
    }

    if(request.method==="POST" && path.endsWith("/recurring/generate")) {
      const days=Math.min(365,Math.max(1,Number(url.searchParams.get("days")||90)||90));
      const horizon=(await pool.query("select current_date+$1::int d",[days])).rows[0].d;
      const client=await pool.connect();
      let created=0;
      try{
        await client.query("begin");
        const rules=(await client.query("select * from recurring_rules where owner_id=$1 and active=true and next_date<=$2 for update",[userId,horizon])).rows;
        for(const rule of rules){
          let next=new Date(String(rule.next_date).slice(0,10)+"T00:00:00Z");
          while(next.toISOString().slice(0,10)<=String(horizon).slice(0,10)){
            const d=next.toISOString().slice(0,10);
            if(rule.rule_type==="expense"){
              await client.query(`insert into expenses(description,amount,category_id,card_id,expense_date,installment_total,installment_number,invoice_month,owner_id)
                values($1,$2,$3,$4,$5,1,1,case when $4 is not null then (date_trunc('month',$5::date)+case when extract(day from $5::date)>coalesce((select closing_day from cards where id=$4),31) then interval '1 month' else interval '0 month' end)::date else null end,$6)`,[rule.description,rule.amount,rule.category_id,rule.card_id,d,userId]);
            }else{
              await client.query("insert into receivables(description,expected_amount,due_date,category,receiving_method,observation,owner_id) values($1,$2,$3,'Outros',null,'Gerado por recorrência',$4)",[rule.description,rule.amount,d,userId]);
            }
            created++;
            next=new Date(Date.UTC(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate()));
          }
          await client.query("update recurring_rules set next_date=$1 where id=$2",[next.toISOString().slice(0,10),rule.id]);
        }
        await client.query("commit");
      }catch(e){await client.query("rollback");throw e}finally{client.release()}
      return json({created},200,origin);
    }

    if(request.method==="POST" && path.endsWith("/recurring")) {
      const b=await request.json().catch(()=>null),ruleType=text(b?.rule_type,20),description=text(b?.description,200),amount=Number(b?.amount),firstDate=text(b?.first_date,10),categoryId=idOf(b?.category_id),cardId=idOf(b?.card_id);
      if(!["expense","receivable"].includes(ruleType)||!description||!Number.isFinite(amount)||amount<=0||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(firstDate))return json({error:"Tipo, descrição, valor e primeira data válidos são obrigatórios."},400,origin);
      if(ruleType==="expense"&&cardId===null&&categoryId===null)return json({error:"Informe ao menos uma categoria ou um cartão para a despesa recorrente."},400,origin);
      const r=await pool.query("insert into recurring_rules(rule_type,description,amount,category_id,card_id,first_date,next_date,owner_id) values($1,$2,$3,$4,$5,$6,$6,$7) returning id,rule_type,description,amount,category_id,card_id,first_date,next_date,active,created_at",[ruleType,description,Math.round(amount*100)/100,categoryId,ruleType==="expense"?cardId:null,firstDate,userId]);
      return json(r.rows[0],201,origin);
    }

    if(request.method==="GET" && path.endsWith("/reconciliation")) {
      const accountId=idOf(url.searchParams.get("account_id"));
      if(!accountId)return json({error:"account_id é obrigatório."},400,origin);
      const rows=await pool.query(`select id,transaction_date,description,amount,external_id,reconciled,matched_expense_id,matched_receipt_id,imported_at from bank_transactions where account_id=$1 and (owner_id=$2 or owner_id is null) order by transaction_date desc,id desc limit 500`,[accountId,userId]);
      return json({transactions:rows.rows},200,origin);
    }

    if(request.method==="POST" && path.endsWith("/reconciliation/import")) {
      const b=await request.json().catch(()=>null),accountId=idOf(b?.account_id),items=Array.isArray(b?.transactions)?b.transactions.slice(0,2000):[];
      if(!accountId||!items.length)return json({error:"Conta e transações são obrigatórias."},400,origin);
      const account=await pool.query("select id,account_type from financial_accounts where id=$1 and (owner_id=$2 or owner_id is null)",[accountId,userId]);
      if(!account.rowCount||account.rows[0].account_type==="credit_card")return json({error:"A conciliação CSV deve usar uma conta bancária ou dinheiro."},400,origin);
      let imported=0,matched=0,skipped=0;
      const client=await pool.connect();
      try{
        await client.query("begin");
        for(const item of items){
          const d=text(item?.transaction_date,10),desc=text(item?.description,300),external=text(item?.external_id,200)||null,amount=Number(item?.amount);
          if(!desc||!Number.isFinite(amount)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d)){skipped++;continue}
          if(external&&(await client.query("select 1 from bank_transactions where account_id=$1 and external_id=$2",[accountId,external])).rowCount){skipped++;continue}
          const cand=amount<0
            ? await client.query("select id from expenses where (owner_id=$1 or owner_id is null) and amount=$2 and expense_date between ($3::date-3) and ($3::date+3) and card_id is null order by abs(expense_date-$3::date),id limit 1",[userId,Math.abs(amount),d])
            : await client.query("select p.id from receipts p join receivables r on r.id=p.receivable_id where (p.owner_id=$1 or p.owner_id is null) and p.amount=$2 and p.received_date between ($3::date-3) and ($3::date+3) order by abs(p.received_date-$3::date),p.id limit 1",[userId,Math.abs(amount),d]);
          const expId=amount<0?(cand.rows[0]?.id||null):null,recId=amount>=0?(cand.rows[0]?.id||null):null;
          await client.query("insert into bank_transactions(account_id,transaction_date,description,amount,external_id,matched_expense_id,matched_receipt_id,reconciled,owner_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",[accountId,d,desc,Math.round(amount*100)/100,external,expId,recId,!!(expId||recId),userId]);
          imported++;if(expId||recId)matched++;
        }
        await client.query("commit");
      }catch(e){await client.query("rollback");throw e}finally{client.release()}
      return json({imported,matched,unmatched:imported-matched,skipped},201,origin);
    }

    if(request.method==="GET" && path.endsWith("/dashboard")) {
      const now=await pool.query("select date_trunc('month',current_date)::date month_start,(date_trunc('month',current_date)+interval '1 month-1 day')::date month_end,(current_date+30) future_end");
      const {month_start,month_end,future_end}=now.rows[0];
      const [exp,rec,accountsRows,cats,upcoming,recent]=await Promise.all([
        pool.query("select coalesce(sum(amount),0) total,count(*)::int count from expenses where (owner_id=$1 or owner_id is null) and expense_date between $2 and $3",[userId,month_start,month_end]),
        pool.query("select coalesce(sum(p.amount),0) received from receipts p where (p.owner_id=$1 or p.owner_id is null) and p.received_date between $2 and $3",[userId,month_start,month_end]),
        pool.query(`select a.id,a.name,a.account_type,a.opening_balance,
          coalesce((select sum(case when t.source_account_id=a.id then -t.amount when t.destination_account_id=a.id then t.amount else 0 end) from transfers t where t.owner_id=$1 and t.transfer_date<=current_date),0) transfer_net,
          coalesce((select sum(r.amount) from receipts r where r.owner_id=$1 and r.account_id=a.id and r.received_date<=current_date),0) receipt_net,
          coalesce((select sum(e.amount) from expenses e where e.owner_id=$1 and e.card_id=a.card_id and e.expense_date<=current_date),0) card_expenses,
          coalesce((select sum(t.amount) from transfers t where t.owner_id=$1 and t.destination_account_id=a.id and t.transfer_type='credit_card_payment' and t.transfer_date<=current_date),0) card_payments
          from financial_accounts a where a.active=true and (a.owner_id=$1 or a.owner_id is null)`,[userId]),
        pool.query(`select coalesce(c.name,'Outros') category,coalesce(sum(e.amount),0) total from expenses e left join categories c on c.id=e.category_id where (e.owner_id=$1 or e.owner_id is null) and e.expense_date between $2 and $3 group by c.name order by total desc limit 8`,[userId,month_start,month_end]),
        pool.query(`select r.id,r.description,r.expected_amount,r.due_date,coalesce(sum(p.amount),0) received from receivables r left join receipts p on p.receivable_id=r.id where (r.owner_id=$1 or r.owner_id is null) and r.due_date>current_date and r.due_date<=$2 group by r.id order by r.due_date,r.id limit 8`,[userId,future_end]),
        pool.query(`select e.id,e.description,e.amount,e.expense_date,c.name category from expenses e left join categories c on c.id=e.category_id where (e.owner_id=$1 or e.owner_id is null) order by e.expense_date desc,e.id desc limit 8`,[userId])
      ]);
      let liquid=0,cardDebt=0;
      for(const x of accountsRows.rows){if(x.account_type==="credit_card")cardDebt+=Math.max(0,Number(x.opening_balance)+Number(x.card_expenses)-Number(x.card_payments));else liquid+=Number(x.opening_balance)+Number(x.transfer_net)+Number(x.receipt_net)}
      const cash=await pool.query(`select
        coalesce(sum(case when e.card_id is null then e.amount else 0 end),0) cash_total,
        coalesce(sum(case when e.card_id is not null then e.amount else 0 end),0) card_total
        from expenses e where (e.owner_id=$1 or e.owner_id is null) and e.expense_date>current_date and e.expense_date<=$2`,[userId,future_end]);
      const due=await pool.query(`select coalesce(sum(r.expected_amount-coalesce(p.received,0)),0) total from receivables r left join (select receivable_id,sum(amount) received from receipts group by receivable_id) p on p.receivable_id=r.id where (r.owner_id=$1 or r.owner_id is null) and r.due_date>current_date and r.due_date<=$2`,[userId,future_end]);
      return json({month:{expenses:Number(exp.rows[0].total),expense_count:Number(exp.rows[0].count),received:Number(rec.rows[0].received),net:Number(rec.rows[0].received)-Number(exp.rows[0].total)},liquid,card_debt:cardDebt,receivables_due:Number(due.rows[0].total),projected_liquid:liquid+Number(due.rows[0].total)-Number(cash.rows[0].cash_total),future_cash_expenses:Number(cash.rows[0].cash_total),future_card_expenses:Number(cash.rows[0].card_total),categories:cats.rows,upcoming_receivables:upcoming.rows.map(x=>({...x,pending:Math.max(0,Number(x.expected_amount)-Number(x.received))})),recent_expenses:recent.rows},200,origin);
    }

    if(request.method==="GET" && path.endsWith("/cash-flow")) {
      const days=Math.min(365,Math.max(1,Number(url.searchParams.get("days")||30)||30));
      const endDate=await pool.query("select (current_date + $1::int) end_date",[days]);
      const end=endDate.rows[0].end_date;
      const accountsRows=await pool.query(`select a.id,a.account_type,a.opening_balance,
        coalesce((select sum(case when t.source_account_id=a.id then -t.amount when t.destination_account_id=a.id then t.amount else 0 end) from transfers t where t.owner_id=$1 and t.transfer_date<=current_date),0) transfer_net,
        coalesce((select sum(r.amount) from receipts r where r.owner_id=$1 and r.account_id=a.id and r.received_date<=current_date),0) receipt_net,
        coalesce((select sum(e.amount) from expenses e where e.owner_id=$1 and e.card_id=a.card_id and e.expense_date<=current_date),0) card_expenses,
        coalesce((select sum(t.amount) from transfers t where t.owner_id=$1 and t.destination_account_id=a.id and t.transfer_type='credit_card_payment' and t.transfer_date<=current_date),0) card_payments
        from financial_accounts a where a.active=true and (a.owner_id=$1 or a.owner_id is null)`,[userId]);
      let liquid=0,cardDebt=0;
      for(const x of accountsRows.rows){
        if(x.account_type==="credit_card") cardDebt+=Math.max(0,Number(x.opening_balance)+Number(x.card_expenses)-Number(x.card_payments));
        else liquid+=Number(x.opening_balance)+Number(x.transfer_net)+Number(x.receipt_net);
      }
      const rec=await pool.query(`select coalesce(sum(r.expected_amount-coalesce(p.received,0)),0) total from receivables r left join (select receivable_id,sum(amount) received from receipts group by receivable_id) p on p.receivable_id=r.id where (r.owner_id=$1 or r.owner_id is null) and r.due_date>current_date and r.due_date<=$2`,[userId,end]);
      const exp=await pool.query(`select coalesce(sum(case when e.card_id is null then e.amount else 0 end),0) cash_total,coalesce(sum(case when e.card_id is not null then e.amount else 0 end),0) card_total from expenses e where (e.owner_id=$1 or e.owner_id is null) and e.expense_date>current_date and e.expense_date<=$2`,[userId,end]);
      const futurePayments=await pool.query(`select coalesce(sum(case when s.account_type in ('bank','cash') then t.amount else 0 end),0) bank_to_card_payments from transfers t join financial_accounts s on s.id=t.source_account_id where t.owner_id=$1 and t.transfer_type='credit_card_payment' and t.transfer_date>current_date and t.transfer_date<=$2`,[userId,end]);
      return json({days,end_date:end,liquid,card_debt,receivables_due:Number(rec.rows[0].total),future_cash_expenses:Number(exp.rows[0].cash_total),future_card_expenses:Number(exp.rows[0].card_total),future_card_payments:Number(futurePayments.rows[0].bank_to_card_payments),projected_liquid:liquid+Number(rec.rows[0].total)-Number(exp.rows[0].cash_total)-Number(futurePayments.rows[0].bank_to_card_payments),projected_card_debt:cardDebt+Number(exp.rows[0].card_total)-Number(futurePayments.rows[0].bank_to_card_payments)},200,origin);
    }

    if(request.method==="GET" && path.endsWith("/accounts")) {
      const rows=await pool.query(`select a.id,a.name,a.account_type,a.opening_balance,a.card_id,a.created_at,
        coalesce((select sum(case when t.source_account_id=a.id then -t.amount when t.destination_account_id=a.id then t.amount else 0 end) from transfers t where t.owner_id=$1 and t.transfer_date<=current_date),0) transfer_net,
        coalesce((select sum(r.amount) from receipts r where r.owner_id=$1 and r.account_id=a.id and r.received_date<=current_date),0) receipt_net,
        coalesce((select sum(e.amount) from expenses e where e.owner_id=$1 and e.card_id=a.card_id and e.expense_date<=current_date),0) card_expenses,
        coalesce((select sum(t.amount) from transfers t where t.owner_id=$1 and t.destination_account_id=a.id and t.transfer_type='credit_card_payment' and t.transfer_date<=current_date),0) card_payments
        from financial_accounts a where a.active=true and (a.owner_id=$1 or a.owner_id is null) order by a.name`,[userId]);
      return json({accounts:rows.rows.map(x=>{
        const isCard=x.account_type==="credit_card";
        const debt=isCard?Math.max(0,Number(x.opening_balance)+Number(x.card_expenses)-Number(x.card_payments)):0;
        return {...x,balance:isCard?-debt:Number(x.opening_balance)+Number(x.transfer_net)+Number(x.receipt_net),debt};
      })},200,origin);
    }

    if(request.method==="POST" && path.endsWith("/accounts")) {
      const b=await request.json().catch(()=>null),name=text(b?.name,100),type=text(b?.account_type,30)||"bank",opening=Number(b?.opening_balance||0),cardId=idOf(b?.card_id);
      if(!name||!["bank","cash","credit_card"].includes(type)||!Number.isFinite(opening)||opening<0)return json({error:"Nome, tipo e saldo inicial válidos são obrigatórios."},400,origin);
      if(type==="credit_card"&&!cardId)return json({error:"Cartão de crédito deve estar vinculado a um cartão cadastrado."},400,origin);
      if(type!=="credit_card"&&cardId)return json({error:"Somente contas do tipo cartão de crédito podem ter cartão vinculado."},400,origin);
      const r=await pool.query(`insert into financial_accounts(name,account_type,opening_balance,card_id,owner_id) values($1,$2,$3,$4,$5) returning id,name,account_type,opening_balance,card_id,created_at`,[name,type,Math.round(opening*100)/100,cardId,userId]);
      return json({...r.rows[0],balance:Number(r.rows[0].opening_balance)},201,origin);
    }

    if(request.method==="POST" && path.endsWith("/transfers")) {
      const b=await request.json().catch(()=>null),source=idOf(b?.source_account_id),destination=idOf(b?.destination_account_id),amount=Number(b?.amount),date=text(b?.transfer_date,10),type=text(b?.transfer_type,30)||"transfer",description=text(b?.description,200),observation=text(b?.observation,500);
      if(!source||!destination||source===destination||!Number.isFinite(amount)||amount<=0||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date))return json({error:"Origem, destino, valor e data válidos são obrigatórios."},400,origin);
      const owns=await pool.query("select id,account_type from financial_accounts where id=any($1::bigint[]) and (owner_id=$2 or owner_id is null)",[[source,destination],userId]);
      if(owns.rowCount!==2)return json({error:"Conta de origem ou destino não encontrada."},404,origin);
      const destinationAccount=owns.rows.find(x=>Number(x.id)===destination);
      const sourceAccount=owns.rows.find(x=>Number(x.id)===source);
      if(type==="credit_card_payment" && destinationAccount?.account_type!=="credit_card")return json({error:"Pagamento de fatura deve ter como destino uma conta de cartão de crédito."},400,origin);
      if(type==="credit_card_payment" && sourceAccount?.account_type==="credit_card")return json({error:"O pagamento da fatura deve sair de uma conta bancária ou dinheiro."},400,origin);
      const r=await pool.query(`insert into transfers(source_account_id,destination_account_id,amount,transfer_date,transfer_type,description,observation,owner_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning id,source_account_id,destination_account_id,amount,transfer_date,transfer_type,description,observation,created_at`,[source,destination,Math.round(amount*100)/100,date,type,description,observation,userId]);
      return json(r.rows[0],201,origin);
    }

    if(request.method==="GET" && path.endsWith("/transfers")) {
      const rows=await pool.query(`select t.id,t.amount,t.transfer_date,t.transfer_type,t.description,t.observation,t.created_at,s.name source_name,d.name destination_name
        from transfers t join financial_accounts s on s.id=t.source_account_id join financial_accounts d on d.id=t.destination_account_id
        where t.owner_id=$1 order by t.transfer_date desc,t.id desc limit 100`,[userId]);
      return json({transfers:rows.rows},200,origin);
    }

    if(request.method==="GET" && path.endsWith("/expenses")) {
      const params=[userId], where=["(e.owner_id = $1 or e.owner_id is null)"];
      const start=text(url.searchParams.get("start"),10), end=text(url.searchParams.get("end"),10);
      const category=idOf(url.searchParams.get("category_id")), card=idOf(url.searchParams.get("card_id"));
      if(start && /^\d{4}-\d{2}-\d{2}$/.test(start)){params.push(start);where.push(`e.expense_date >= $${params.length}`)}
      if(end && /^\d{4}-\d{2}-\d{2}$/.test(end)){params.push(end);where.push(`e.expense_date <= $${params.length}`)}
      if(category){params.push(category);where.push(`e.category_id = $${params.length}`)}
      if(card){params.push(card);where.push("e.card_id = $"+params.length)}
      const limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit")||50)||50));
      const offset=Math.max(0,Number(url.searchParams.get("offset")||0)||0);
      const count=await pool.query(`select count(*)::int total from expenses e where ${where.join(" and ")}`,params);
      return json({expenses:await expenseQuery("where "+where.join(" and "),params,limit,offset),total:count.rows[0].total,limit,offset},200,origin);
    }

    if(request.method==="POST" && path.endsWith("/categories")) {
      const b=await request.json().catch(()=>null), name=text(b?.name,100);
      if(!name) return json({error:"Nome da categoria é obrigatório."},400,origin);
      const r=await pool.query(`insert into categories(name) values($1) on conflict(name) do update set active=true returning id,name`,[name]);
      return json(r.rows[0],201,origin);
    }

    if(request.method==="POST" && path.endsWith("/cards")) {
      const b=await request.json().catch(()=>null), name=text(b?.name,100),closing=idOf(b?.closing_day),due=idOf(b?.due_day),limit=Number(b?.credit_limit||0);
      if(!name||!Number.isFinite(limit)||limit<0||(closing!==null&&(closing<1||closing>31))||(due!==null&&(due<1||due>31)))return json({error:"Nome, limite, fechamento e vencimento válidos são obrigatórios."},400,origin);
      const r=await pool.query(`insert into cards(name,closing_day,due_day,credit_limit) values($1,$2,$3,$4)
        on conflict(name) do update set active=true,closing_day=coalesce(excluded.closing_day,cards.closing_day),due_day=coalesce(excluded.due_day,cards.due_day),credit_limit=excluded.credit_limit
        returning id,name,closing_day,due_day,credit_limit`,[name,closing,due,Math.round(limit*100)/100]);
      return json(r.rows[0],201,origin);
    }

    if(request.method==="PUT" && /\/cards\/?\d+$/.test(path)) {
      const id=Number(path.match(/(\d+)$/)[1]),b=await request.json().catch(()=>null),name=text(b?.name,100),closing=idOf(b?.closing_day),due=idOf(b?.due_day),limit=Number(b?.credit_limit||0);
      if(!name||!Number.isFinite(limit)||limit<0||(closing!==null&&(closing<1||closing>31))||(due!==null&&(due<1||due>31)))return json({error:"Nome, limite, fechamento e vencimento válidos são obrigatórios."},400,origin);
      const r=await pool.query(`update cards set name=$1,closing_day=$2,due_day=$3,credit_limit=$4 where id=$5 returning id,name,closing_day,due_day,credit_limit`,[name,closing,due,Math.round(limit*100)/100,id]);
      if(!r.rowCount)return json({error:"Cartão não encontrado."},404,origin);
      return json(r.rows[0],200,origin);
    }

    if(request.method==="GET" && path.endsWith("/card-statements")) {
      const cardId=idOf(url.searchParams.get("card_id"));
      const month=text(url.searchParams.get("month"),7);
      if(!cardId)return json({error:"card_id é obrigatório."},400,origin);
      const card=await pool.query("select id,name,closing_day,due_day,credit_limit from cards where id=$1",[cardId]);
      if(!card.rowCount)return json({error:"Cartão não encontrado."},404,origin);
      const c=card.rows[0];
      let statementMonth=month&&/^\d{4}-\d{2}$/.test(month)?month:null;
      if(!statementMonth){
        const d=new Date(),base=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));
        const day=base.getUTCDate();
        let y=base.getUTCFullYear(),m=base.getUTCMonth();
        if(Number(c.closing_day)&&day>Number(c.closing_day)){m++;if(m>11){m=0;y++;}}
        statementMonth=y+"-"+String(m+1).padStart(2,"0");
      }
      const start=statementMonth+"-01";
      const period=await pool.query(`select
        (date_trunc('month',$1::date)-interval '1 month'+make_interval(days=>coalesce($2,1)))::date period_start,
        (date_trunc('month',$1::date)+make_interval(days=>coalesce($2,1)-1))::date period_end,
        (date_trunc('month',$1::date)+make_interval(days=>case when coalesce($3,1)<=coalesce($2,1) then 1 else 0 end months)+make_interval(days=>coalesce($3,1)-1))::date due_date`,[start,c.closing_day,c.due_day]);
      const p=period.rows[0];
      const expensesRows=await pool.query("select id,description,amount,expense_date,installment_total,installment_number from expenses where card_id=$1 and invoice_month=$2 and (expense_date<=current_date or invoice_month>(date_trunc('month',current_date)+case when extract(day from current_date)>coalesce((select closing_day from cards where id=$1),31) then interval '1 month' else interval '0 month' end)::date) order by expense_date,id",[cardId,start]);
      const account=await pool.query("select id from financial_accounts where card_id=$1 and account_type='credit_card' and active=true limit 1",[cardId]);
      let paid=0;
      if(account.rowCount) {
        const pay=await pool.query("select coalesce(sum(amount),0) total from transfers where destination_account_id=$1 and transfer_type='credit_card_payment' and transfer_date>=$2 and transfer_date<=$3",[account.rows[0].id,p.period_end,p.due_date]);
        paid=Number(pay.rows[0].total);
      }
      const total=expensesRows.rows.reduce((a,x)=>a+Number(x.amount),0);
      return json({card:c,statement:{month:statementMonth,period_start:p.period_start,period_end:p.period_end,due_date:p.due_date,total,paid,remaining:Math.max(0,total-paid),status:paid>=total&&total>0?"Recebida":paid>0?"Parcial":"Pendente",expenses:expensesRows.rows}},200,origin);
    }

    if(request.method==="PUT" && /\/expenses\/?\d+$/.test(path)) {
      const match=path.match(/(\d+)$/), expenseId=Number(match[1]);
      const b=await request.json().catch(()=>null);
      const description=text(b?.description,200), amount=Number(b?.amount), observation=text(b?.observation,500), installmentTotal=Math.max(1,Number(b?.installment_total||1)), installmentNumber=Math.max(1,Number(b?.installment_number||1));
      const categoryId=idOf(b?.category_id), cardId=idOf(b?.card_id), expenseDate=text(b?.expense_date,10);
      if(!description || !Number.isFinite(amount) || amount<=0 || installmentTotal>1 || installmentNumber>installmentTotal || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate))
        return json({error:"Descrição, valor e data válidos são obrigatórios. Parcelamento não pode ser alterado pela edição individual."},400,origin);
      const r=await pool.query(`update expenses set description=$1,amount=$2,category_id=$3,card_id=$4,expense_date=$5,installment_number=$6,invoice_month=case when $4 is not null then (date_trunc('month',$5::date)+case when extract(day from $5::date)>coalesce((select closing_day from cards where id=$4),31) then interval '1 month' else interval '0 month' end)::date else null end,observation=$7,updated_at=now()
        where id=$8 and (owner_id=$9 or owner_id is null) returning id,description,amount,category_id,card_id,expense_date,observation,installment_total,installment_number,invoice_month,created_at,updated_at`,
        [description,Math.round(amount*100)/100,categoryId,cardId,expenseDate,installmentNumber,observation,expenseId,userId]);
      if(!r.rowCount) return json({error:"Gasto não encontrado."},404,origin);
      const rows=await expenseQuery("where e.id=$1 and (e.owner_id=$2 or e.owner_id is null)",[expenseId,userId]);
      return json(rows[0],200,origin);
    }

    if(request.method==="DELETE" && /\/expenses\/?\d+$/.test(path)) {
      const match=path.match(/(\d+)$/), expenseId=Number(match[1]);
      const r=await pool.query("delete from expenses where id=$1 and (owner_id=$2 or owner_id is null) returning id",[expenseId,userId]);
      if(!r.rowCount) return json({error:"Gasto não encontrado."},404,origin);
      return new Response(null,{status:204,headers:headers(origin)});
    }

    if(request.method==="POST" && path.endsWith("/expenses")) {
      const b=await request.json().catch(()=>null);
      const description=text(b?.description,200), amount=Number(b?.amount), observation=text(b?.observation,500), installmentTotal=Math.max(1,Number(b?.installment_total||1));
      const categoryId=idOf(b?.category_id), cardId=idOf(b?.card_id), expenseDate=text(b?.expense_date,10);
      if(!description || !Number.isFinite(amount) || amount<=0 || !Number.isInteger(installmentTotal) || installmentTotal>120 || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate))
        return json({error:"Descrição, valor, data e parcelamento válidos são obrigatórios."},400,origin);
      const totalCents=Math.round(amount*100),baseCents=Math.floor(totalCents/installmentTotal),remainder=totalCents-baseCents*installmentTotal;
      const client=await pool.connect(),ids=[];
      try{
        await client.query("begin");
        for(let n=1;n<=installmentTotal;n++){
          const cents=baseCents+(n>installmentTotal-remainder?1:0);
          const d=(await client.query("select (($1::date)+(($2-1)||' months')::interval)::date d",[expenseDate,n])).rows[0].d;
          const inv=cardId?(await client.query("select (date_trunc('month',$1::date)+case when extract(day from $1::date)>coalesce(closing_day,31) then interval '1 month' else interval '0 month' end)::date invoice_month from cards where id=$2",[d,cardId])).rows[0]?.invoice_month:null;
          const row=await client.query("insert into expenses(description,amount,category_id,card_id,expense_date,installment_total,installment_number,invoice_month,observation,owner_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id",[description,cents/100,categoryId,cardId,d,installmentTotal,n,inv,observation,userId]);
          ids.push(row.rows[0].id);
        }
        await client.query("commit");
      }catch(e){await client.query("rollback");throw e}finally{client.release()}
      const rows=await expenseQuery("where e.owner_id=$1 and e.id=any($2::bigint[])",[userId,ids]);
      return json({created:rows},201,origin);
    }

    return json({error:"Endpoint não encontrado."},404,origin);
  } catch(e) {
    console.error(e);
    if(e?.message==="AUTH_NOT_CONFIGURED") return json({error:"Autenticação do Neon ainda não foi provisionada nesta branch."},503,origin);
    if(e?.message==="AUTH_REQUIRED") return json({error:"Login obrigatório."},401,origin);
    if(e?.message==="AUTH_INVALID") return json({error:"Sessão inválida ou expirada."},401,origin);
    return json({error:"Erro interno no servidor."},500,origin);
  }
}
