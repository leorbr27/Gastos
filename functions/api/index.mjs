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
      updated_at timestamptz not null default now(),
      owner_id text
    );
    alter table expenses add column if not exists owner_id text;
    create index if not exists expenses_owner_date_idx on expenses(owner_id,expense_date desc);
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
  const r=await pool.query(`select e.id,e.description,e.amount,e.expense_date,e.created_at,e.updated_at,e.category_id,c.name category_name,
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
    const userId=(path==="/auth-config" || isPublicBootstrap || isPublicCreateExpense || isPublicCreateCard)?null:await requireUser(request);
    if(userId) await pool.query("update expenses set owner_id=$1 where owner_id is null",[userId]);

    if(request.method==="GET" && path==="/auth-config") return json({auth_url:AUTH_BASE},200,origin);

    if(request.method==="GET" && path==="/version") return json({api_version:"2026.09.25.6",schema_version:2,auth:true,pagination:true},200,origin);

    if(request.method==="GET" && (path==="/" || path.endsWith("/bootstrap"))) {
      const [categories,cards]=await Promise.all([
        pool.query("select id,name from categories where active=true order by name"),
        pool.query("select id,name,closing_day,due_day from cards where active=true order by case when name='Pix' then 0 when name='Dinheiro' then 1 else 2 end,name"),
      ]);
      return json({categories:categories.rows,cards:cards.rows},200,origin);
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
        where id=$6 and (owner_id=$7 or owner_id is null) returning id,description,amount,category_id,card_id,expense_date,created_at,updated_at`,
        [description,Math.round(amount*100)/100,categoryId,cardId,expenseDate,expenseId,userId]);
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
      const description=text(b?.description,200), amount=Number(b?.amount);
      const categoryId=idOf(b?.category_id), cardId=idOf(b?.card_id), expenseDate=text(b?.expense_date,10);
      if(!description || !Number.isFinite(amount) || amount<=0 || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate))
        return json({error:"Descrição, valor e data válidos são obrigatórios."},400,origin);
      const r=await pool.query(`insert into expenses(description,amount,category_id,card_id,expense_date,owner_id)
        values($1,$2,$3,$4,$5,$6) returning id,description,amount,category_id,card_id,expense_date,created_at,updated_at`,
        [description,Math.round(amount*100)/100,categoryId,cardId,expenseDate,userId]);
      const rows=await expenseQuery("where e.id=$1 and e.owner_id=$2",[r.rows[0].id,userId]);
      return json(rows[0],201,origin);
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
