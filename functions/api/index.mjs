import pg from "pg";
import { attachDatabasePool } from "@neon/functions";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });
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
    insert into categories(name) values
      ('Alimentação'),('Transporte'),('Contas da casa'),('Saúde'),('Lazer'),
      ('Compras'),('Educação'),('Assinaturas'),('Trabalho'),('Outros')
    on conflict(name) do nothing;
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
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
});
const json = (data,status,origin) => new Response(JSON.stringify(data),{status,headers:headers(origin)});
const text = (v,max=200) => String(v ?? "").trim().slice(0,max);
const idOf = v => Number.isInteger(Number(v)) && Number(v)>0 ? Number(v) : null;

async function expenseQuery(where="", params=[]) {
  const r=await pool.query(`select e.id,e.description,e.amount,e.expense_date,e.created_at,e.updated_at,e.category_id,c.name category_name,
    e.card_id,ca.name card_name,e.installment_total,e.installment_number,e.invoice_month
    from expenses e
    left join categories c on c.id=e.category_id
    left join cards ca on ca.id=e.card_id
    ${where} order by e.expense_date desc,e.id desc`,params);
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

    if(request.method==="GET" && path==="/version") return json({api_version:"2026.09.25.4",schema_version:1},200,origin);

    if(request.method==="GET" && (path==="/" || path.endsWith("/bootstrap"))) {
      const [categories,cards,expenses]=await Promise.all([
        pool.query("select id,name from categories where active=true order by name"),
        pool.query("select id,name,closing_day,due_day from cards where active=true order by case when name='Pix' then 0 when name='Dinheiro' then 1 else 2 end,name"),
        expenseQuery()
      ]);
      return json({categories:categories.rows,cards:cards.rows,expenses},200,origin);
    }

    if(request.method==="GET" && path.endsWith("/expenses")) {
      const params=[], where=[];
      const start=text(url.searchParams.get("start"),10), end=text(url.searchParams.get("end"),10);
      const category=idOf(url.searchParams.get("category_id")), card=idOf(url.searchParams.get("card_id"));
      if(start && /^\d{4}-\d{2}-\d{2}$/.test(start)){params.push(start);where.push(`e.expense_date >= $${params.length}`)}
      if(end && /^\d{4}-\d{2}-\d{2}$/.test(end)){params.push(end);where.push(`e.expense_date <= $${params.length}`)}
      if(category){params.push(category);where.push(`e.category_id = $${params.length}`)}
      if(card){params.push(card);where.push(`e.card_id = $${params.length}`)}
      return json({expenses:await expenseQuery(where.length?"where "+where.join(" and "):"",params)},200,origin);
    }

    if(request.method==="POST" && path.endsWith("/categories")) {
      const b=await request.json().catch(()=>null), name=text(b?.name,100);
      if(!name) return json({error:"Nome da categoria é obrigatório."},400,origin);
      const r=await pool.query(`insert into categories(name) values($1) on conflict(name) do update set active=true returning id,name`,[name]);
      return json(r.rows[0],201,origin);
    }

    if(request.method==="POST" && path.endsWith("/cards")) {
      const b=await request.json().catch(()=>null), name=text(b?.name,100);
      if(!name) return json({error:"Nome do meio de pagamento é obrigatório."},400,origin);
      const r=await pool.query(`insert into cards(name) values($1) on conflict(name) do update set active=true
        returning id,name,closing_day,due_day`,[name]);
      return json(r.rows[0],201,origin);
    }

    if(request.method==="PUT" && /\/expenses\/?\d+$/.test(path)) {
      const match=path.match(/(\d+)$/), expenseId=Number(match[1]);
      const b=await request.json().catch(()=>null);
      const description=text(b?.description,200), amount=Number(b?.amount);
      const categoryId=idOf(b?.category_id), cardId=idOf(b?.card_id), expenseDate=text(b?.expense_date,10);
      if(!description || !Number.isFinite(amount) || amount<=0 || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate))
        return json({error:"Descrição, valor e data válidos são obrigatórios."},400,origin);
      const r=await pool.query(`update expenses set description=$1,amount=$2,category_id=$3,card_id=$4,expense_date=$5,updated_at=now()
        where id=$6 returning id,description,amount,category_id,card_id,expense_date,created_at,updated_at`,
        [description,Math.round(amount*100)/100,categoryId,cardId,expenseDate,expenseId]);
      if(!r.rowCount) return json({error:"Gasto não encontrado."},404,origin);
      const rows=await expenseQuery("where e.id=$1",[expenseId]);
      return json(rows[0],200,origin);
    }

    if(request.method==="DELETE" && /\/expenses\/?\d+$/.test(path)) {
      const match=path.match(/(\d+)$/), expenseId=Number(match[1]);
      const r=await pool.query("delete from expenses where id=$1 returning id",[expenseId]);
      if(!r.rowCount) return json({error:"Gasto não encontrado."},404,origin);
      return new Response(null,{status:204,headers:headers(origin)});
    }

    if(request.method==="POST" && path.endsWith("/expenses")) {
      const b=await request.json().catch(()=>null);
      const description=text(b?.description,200), amount=Number(b?.amount);
      const categoryId=idOf(b?.category_id), cardId=idOf(b?.card_id), expenseDate=text(b?.expense_date,10);
      if(!description || !Number.isFinite(amount) || amount<=0 || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate))
        return json({error:"Descrição, valor e data válidos são obrigatórios."},400,origin);
      const r=await pool.query(`insert into expenses(description,amount,category_id,card_id,expense_date)
        values($1,$2,$3,$4,$5) returning id,description,amount,category_id,card_id,expense_date,created_at,updated_at`,
        [description,Math.round(amount*100)/100,categoryId,cardId,expenseDate]);
      const rows=await expenseQuery("where e.id=$1",[r.rows[0].id]);
      return json(rows[0],201,origin);
    }

    return json({error:"Endpoint não encontrado."},404,origin);
  } catch(e) {
    console.error(e);
    return json({error:"Erro interno no servidor."},500,origin);
  }
}
