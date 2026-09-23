import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });
const ALLOWED_ORIGIN = "https://leorbr27.github.io";
const headers = (origin) => ({
  "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
});
const json = (data,status,origin) => new Response(JSON.stringify(data),{status,headers:headers(origin)});
const text = (v,max=200) => String(v ?? "").trim().slice(0,max);
export default async function handler(request) {
  const origin=request.headers.get("origin")||"";
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:headers(origin)});
  const path=new URL(request.url).pathname.replace(/\/+$/,"")||"/";
  try {
    if(request.method==="GET" && (path==="/" || path.endsWith("/bootstrap"))) {
      const [categories,cards,expenses]=await Promise.all([
        pool.query("select id,name from categories where active=true order by name"),
        pool.query("select id,name,closing_day,due_day from cards where active=true order by name"),
        pool.query(`select e.id,e.description,e.amount,e.expense_date,e.category_id,c.name category_name,e.card_id,ca.name card_name
          from expenses e left join categories c on c.id=e.category_id left join cards ca on ca.id=e.card_id
          order by e.expense_date desc,e.id desc limit 1000`)
      ]);
      return json({categories:categories.rows,cards:cards.rows,expenses:expenses.rows},200,origin);
    }
    if(request.method==="POST" && path.endsWith("/cards")) {
      const b=await request.json().catch(()=>null), name=text(b?.name,100);
      if(!name) return json({error:"Nome do cartão é obrigatório."},400,origin);
      const r=await pool.query(`insert into cards(name) values($1) on conflict(name) do update set active=true returning id,name,closing_day,due_day`,[name]);
      return json(r.rows[0],201,origin);
    }
    if(request.method==="POST" && path.endsWith("/expenses")) {
      const b=await request.json().catch(()=>null);
      const description=text(b?.description,200), amount=Number(b?.amount);
      const categoryId=b?.category_id?Number(b.category_id):null, cardId=b?.card_id?Number(b.card_id):null;
      const expenseDate=text(b?.expense_date,10);
      if(!description || !Number.isFinite(amount) || amount<=0 || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate))
        return json({error:"Descrição, valor e data válidos são obrigatórios."},400,origin);
      const r=await pool.query(`insert into expenses(description,amount,category_id,card_id,expense_date)
        values($1,$2,$3,$4,$5) returning id,description,amount,category_id,card_id,expense_date`,
        [description,Math.round(amount*100)/100,categoryId,cardId,expenseDate]);
      return json(r.rows[0],201,origin);
    }
    return json({error:"Endpoint não encontrado."},404,origin);
  } catch(e) {
    console.error(e);
    return json({error:"Erro interno no servidor."},500,origin);
  }
}
