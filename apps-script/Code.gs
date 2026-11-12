/**
 * Caixa da Família — servidor (Google Apps Script)
 *
 * Guarda os dados numa planilha do seu Google Drive e atende:
 *  - o app (ler tudo e gravar lançamentos, dívidas, plano e ajustes);
 *  - os atalhos da Siri (lançar por voz e dizer quanto ainda dá para gastar hoje).
 *
 * Antes de usar: troque a CHAVE abaixo por uma senha da família (mínimo 6 caracteres)
 * e rode a função instalar() uma vez.
 */
const CHAVE = 'TROQUE-ESTA-CHAVE';
// Depois de usada uma vez, a chave fica guardada: nas próximas atualizações pode colar o código sem mexer aqui.

const ABA_DADOS = 'dados';
const ABA_LANC = 'Lançamentos';
const COLECOES = ['config', 'plan', 'transactions', 'debts', 'bills', 'honorarios'];

/* ===== Lógica de cálculo (a mesma do app) ===== */
/* ---------- utilidades ---------- */
function brl(v,dec){v=Math.round((+v||0)*100)/100;const neg=v<0;v=Math.abs(v);const p=v.toFixed(2).split('.');const i=p[0].replace(/\B(?=(\d{3})+(?!\d))/g,'.');return(neg?'-':'')+'R$ '+i+(dec===false?'':','+p[1])}
const fmt=v=>brl(v);
const fmt0=v=>brl(Math.round(+v||0),false);
const pad=n=>String(n).padStart(2,'0');
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const r2=v=>Math.round(v*100)/100;
function todayISO(){return Utilities.formatDate(new Date(),'America/Sao_Paulo','yyyy-MM-dd')}
const monthOf=iso=>String(iso||'').slice(0,7);
function addMonths(mk,n){let[y,m]=mk.split('-').map(Number);m+=n;while(m>12){m-=12;y++}while(m<1){m+=12;y--}return y+'-'+pad(m)}
function dim(mk){const[y,m]=mk.split('-').map(Number);return new Date(y,m,0).getDate()}
const MES=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const MESL=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const mLabel=mk=>{const[y,m]=mk.split('-');return MES[+m-1]+'/'+y.slice(2)};
const mLong=mk=>{const[y,m]=mk.split('-');return MESL[+m-1]+' de '+y};
const dLabel=iso=>{const p=String(iso).split('-');return p[2]+'/'+p[1]};
function diffDays(a,b){const A=new Date(a+'T12:00:00'),B=new Date(b+'T12:00:00');return Math.round((B-A)/86400000)}
function parseMoney(s){s=String(s||'').trim().replace(/[R$\s]/g,'');if(!s)return 0;if(s.includes(','))s=s.replace(/\./g,'').replace(',','.');const n=Number(s);return isFinite(n)?n:NaN}
const sum=(a,f)=>a.reduce((s,x)=>s+(f?f(x):x),0);
const clone=o=>JSON.parse(JSON.stringify(o));
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);

/* ---------- estado ---------- */
const S={config:null,plan:null,tx:[],debts:[],bills:{},hon:[],me:null,names:{},loaded:{},dbOk:null,stale:false,gMonth:monthOf(todayISO()),scn:null,showDone:false,readOnly:false};
const OUT_FIXED=[{id:'fixas',name:'Contas fixas'},{id:'dizimo',name:'Dízimo'},{id:'dividas',name:'Dívidas e faturas'},{id:'reserva',name:'Guardar na reserva'},{id:'ajuste',name:'Ajuste de saldo'}];
const IN_CATS=[{id:'salario',name:'Salário'},{id:'servico',name:'Contrato de serviço'},{id:'honorarios',name:'Honorários'},{id:'extra',name:'Outra entrada'},{id:'resgate',name:'Tirei da reserva'},{id:'reembolso',name:'Reembolso'},{id:'ajuste',name:'Ajuste de saldo'}];
const METHODS=[{id:'pix',name:'Pix'},{id:'debito',name:'Débito'},{id:'dinheiro',name:'Dinheiro'},{id:'cartao',name:'Cartão de crédito'}];
const STATUS={a_vencer:['A vencer','p-warn'],atrasada:['Em atraso','p-bad'],negociando:['Negociando','p-acc'],acordo:['Em acordo','p-acc'],em_dia:['Em dia','p-good'],quitada:['Quitada','p-good']};
const flexCats=()=>(S.config&&S.config.categories)||[];
function catName(id){const c=flexCats().find(x=>x.id===id)||OUT_FIXED.find(x=>x.id===id)||IN_CATS.find(x=>x.id===id);return c?c.name:id}
const methodName=id=>(METHODS.find(m=>m.id===id)||{name:id||''}).name;

/* ---------- regras de cálculo ---------- */
function expectedIncomes(mk){
  const c=S.config;if(!c)return[];const out=[];
  for(const r of c.incomes||[]){if(mk>=r.from&&(!r.to||mk<=r.to)){const day=Math.min(+r.day||1,dim(mk));out.push({id:r.id+'@'+mk,name:r.name,amount:+r.amount||0,date:mk+'-'+pad(day),cat:r.cat||'extra',estimado:false})}}
  for(const o of c.oneOffs||[]){if(monthOf(o.date)===mk)out.push({id:'o-'+o.id,name:o.name,amount:+o.amount||0,date:o.date,cat:o.cat||'extra',estimado:!!o.estimado})}
  return out.sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
}
const received=id=>S.tx.some(x=>x.expectedId===id);
const reserveSaved=()=>r2(sum(S.tx.filter(x=>x.category==='reserva'&&x.type==='out'),x=>+x.amount)-sum(S.tx.filter(x=>x.category==='resgate'&&x.type==='in'),x=>+x.amount));
const debtLeft=d=>d.status==='quitada'?0:Math.max(0,(+d.total||0)-(+d.paid||0));
function billsOf(mk){const st=S.bills[mk]||{};return((S.config&&S.config.bills)||[]).filter(b=>(!b.from||mk>=b.from)&&(!b.to||mk<=b.to)).map(b=>({...b,date:mk+'-'+pad(Math.min(+b.day||1,dim(mk))),paid:!!(st[b.id]&&st[b.id].paid),prepaid:!!(st[b.id]&&st[b.id].prepaid)}))}

function computeToday(){
  const c=S.config,t=todayISO(),mk=monthOf(t);
  const mtx=S.tx.filter(x=>monthOf(x.date)===mk);
  const caixa=r2(sum(S.tx.filter(x=>x.type==='in'),x=>+x.amount)-sum(S.tx.filter(x=>x.type==='out'&&x.method!=='cartao'),x=>+x.amount));
  const entradasMes=sum(mtx.filter(x=>x.type==='in'&&x.category!=='resgate'&&x.category!=='ajuste'&&x.category!=='reembolso'),x=>+x.amount);
  const dizPago=sum(mtx.filter(x=>x.type==='out'&&x.category==='dizimo'),x=>+x.amount);
  const pct=(+c.dizimoPct||0)/100;
  const dizPend=r2(Math.max(0,entradasMes*pct-dizPago));
  const exp=[...expectedIncomes(mk),...expectedIncomes(addMonths(mk,1))].filter(e=>!received(e.id));
  const nextInc=exp.find(e=>e.date>t)||null;
  const lateInc=exp.filter(e=>e.date<=t);
  const limitDate=nextInc?nextInc.date:null;
  const before=d=>limitDate?d<limitDate:monthOf(d)<=mk;
  const billsPend=billsOf(mk).filter(b=>!b.paid&&before(b.date));
  const fixasPend=sum(billsPend,b=>+b.amount);
  const stepsPend=((S.plan&&S.plan.steps)||[]).filter(s=>!s.done&&+s.amount>0&&(s.kind==='pagar'||s.kind==='reserva'||(s.kind==='dizimo'&&s.carry))&&before(s.date));
  const pagPend=sum(stepsPend,s=>+s.amount);
  const cats=flexCats().map(cat=>{const spent=sum(mtx.filter(x=>x.type==='out'&&x.category===cat.id),x=>+x.amount);const today=sum(mtx.filter(x=>x.type==='out'&&x.category===cat.id&&x.date===t),x=>+x.amount);return{...cat,spent,today}});
  const todayFlex=sum(cats,x=>x.today);
  const flexRemBase=sum(cats,x=>Math.max(0,(+x.limit||0)-(x.spent-x.today)));
  const livreBase=caixa+todayFlex-dizPend-fixasPend-pagPend;
  const daysLeft=Math.max(1,limitDate?diffDays(t,limitDate):diffDays(t,mk+'-'+pad(dim(mk)))+1);
  const perDay=Math.max(0,Math.min(livreBase,flexRemBase))/daysLeft;
  const restHoje=perDay-todayFlex;
  const cardUse=mtx.filter(x=>x.type==='out'&&x.method==='cartao');
  return{t,mk,caixa,entradasMes,dizPend,nextInc,lateInc,limitDate,billsPend,fixasPend,stepsPend,pagPend,cats,todayFlex,flexRemBase,livreBase,daysLeft,perDay,restHoje,cardUse,comprometido:dizPend+fixasPend+pagPend};
}

function project(scn){
  const c=S.config,start=monthOf(todayISO());
  const flexT=sum(c.categories||[],x=>+x.limit||0);
  let debt=sum(S.debts,debtLeft),reserve=reserveSaved();const rows=[];
  for(let i=0;i<12;i++){
    const mk=addMonths(start,i);
    const law=mk>=c.law.start?(+c.law[scn]||0):0;
    const incs=expectedIncomes(mk);const inc=sum(incs,e=>e.amount)+law;
    const diz=(sum(incs.filter(e=>e.cat!=='reembolso'),e=>e.amount)+law)*(+c.dizimoPct||0)/100;
    const casa=sum(billsOf(mk),b=>+b.amount||0)+flexT;
    const sobra=inc-diz-casa;let toRes=0,toDebt=0,fromRes=0,falta=0;
    if(sobra>=0){if(mk>=c.reserve.from&&reserve<c.reserve.goal){toRes=Math.min(sobra,c.reserve.goal-reserve);reserve+=toRes}toDebt=Math.min(debt,sobra-toRes);debt-=toDebt}
    else{fromRes=Math.min(reserve,-sobra);reserve-=fromRes;falta=-sobra-fromRes}
    rows.push({mk,inc,law,diz,casa,sobra,toRes,toDebt,fromRes,falta,debt,reserve});
  }
  return{rows,casa:rows[0].casa,startDebt:sum(S.debts,debtLeft)};
}

/* ---------- lançamento rápido (texto ou ditado) ---------- */
const nrm=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
const QCATS=[
 ['mercado',/\b(compra grande|compra do mes|atacad\w*|spani)\b/],
 ['combustivel',/\b(posto|gasolina|etanol|alcool|combustivel|abasteci\w*)\b/],
 ['farmacia',/\b(farmacia|remedio\w*|fraldas?|drogaria|medicamentos?|pomada|vitaminas?)\b/],
 ['restaurantes',/\b(restaurante|lanches?|lanchonete|pizzas?|hamburguer\w*|burger|sorvetes?|ifood|acai|bar|jantar fora|almoco fora|esfihas?|pastel|cafeteria)\b/],
 ['outros',/\b(padaria|carro|pecas?|oficina|mecanico|barbearia|cabelo|lava rapido|lavagem|estacionamento|uber|pedagio|presentes?)\b/],
 ['mercado-semana',/\b(mercado|supermercado|frango|carnes?|proteinas?|peixes?|ovos?|leite|pao|paes|frutas?|verduras?|legumes?|hortifruti|feira|sacolao|acougue|queijo|presunto|iogurtes?|banana|arroz|feijao)\b/]];
const QSTOP=new Set(['no','na','nos','nas','de','do','da','dos','das','em','com','o','a','os','as','um','uma','gastei','paguei','comprei','recebi','foi','foram','reais','real','r','centavos','centavo','pix','debito','credito','cartao','dinheiro','especie','hoje','ontem','anteontem','e','pelo','pela','via','entrada','saida']);
function parseQuick(text){
  const t=nrm(text);let amount=NaN,m;
  if((m=t.match(/(\d+)\s*reais?\s*e\s*(\d{1,2})\s*centavos?/)))amount=+m[1]+(+m[2])/100;
  else if((m=t.match(/(\d{1,3}(?:\.\d{3})+|\d+)(?:[,.](\d{1,2}))?/)))amount=+(m[1].replace(/\./g,''))+(m[2]?+(m[2].length===1?m[2]+'0':m[2])/100:0);
  const isIn=/\b(recebi|recebido|recebemos|entrada|entrou|ganhei|reembolso|devolveu|devolveram|me pagou|me pagaram|pagou a parte|estorno|vendi|venda|salario|honorarios?|bico)\b/.test(t);
  let category=null;
  if(isIn){category=/\b(reembolso|devolve\w*|me pagou|me pagaram|pagou a parte|estorno|vendi|venda)\b/.test(t)?'reembolso':/\b(honorarios?|cliente|consulta)\b/.test(t)?'honorarios':/\bsalario\b/.test(t)?'salario':/\bcontrato\b/.test(t)?'servico':'extra'}
  else{for(const[c,re]of QCATS){if(re.test(t)&&flexCats().some(x=>x.id===c)){category=c;break}}}
  let method='pix';
  if(/\bdebito\b/.test(t))method='debito';else if(/\b(dinheiro|especie)\b/.test(t))method='dinheiro';else if(/\b(credito|cartao)\b/.test(t))method='cartao';
  let date=todayISO();const back=/\banteontem\b/.test(t)?2:/\bontem\b/.test(t)?1:0;
  if(back){const d=new Date(date+'T12:00:00');d.setDate(d.getDate()-back);date=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
  const words=String(text||'').split(/\s+/).filter(w=>{const n=nrm(w).replace(/[^a-z0-9$]/g,'');return n&&!QSTOP.has(n)&&!/^r?\$?\d/.test(n)&&!/^r?\$$/.test(n)});
  let desc=words.join(' ').replace(/^[,.;:\-\s]+|[,.;:\-\s]+$/g,'');
  if(desc)desc=desc.charAt(0).toUpperCase()+desc.slice(1);
  return{amount:r2(amount),type:isIn?'in':'out',category,method:isIn?null:method,date,desc};
}

/* ===== Instalação ===== */

/** Rode esta função uma vez, pelo editor, depois de colar o código. */
function instalar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Abra o Apps Script pela planilha: menu Extensões > Apps Script.');
  PropertiesService.getScriptProperties().setProperty('PLANILHA_ID', ss.getId());
  const sh = abaDados_();
  let importados = 0;
  if (sh.getLastRow() < 2 && typeof DADOS_INICIAIS !== 'undefined') {
    const ops = [];
    Object.keys(DADOS_INICIAIS).forEach(function (c) {
      Object.keys(DADOS_INICIAIS[c]).forEach(function (id) {
        ops.push({ op: 'set', col: c, id: id, data: DADOS_INICIAIS[c][id] });
      });
    });
    gravar_(ops);
    importados = ops.length;
  }
  atualizarAbaLancamentos_();
  if (CHAVE === 'TROQUE-ESTA-CHAVE' || CHAVE.length < 6) {
    Logger.log('ATENÇÃO: troque a CHAVE no topo do código por uma senha com pelo menos 6 caracteres.');
  }
  Logger.log('Pronto! ' + (abaDados_().getLastRow() - 1) + ' registros na aba "dados" (' + importados + ' importados agora).');
}

/** Teste rápido pelo editor: mostra no registro o que a Siri diria. */
function testarLimite() {
  carregarEstado_(lerTudo_());
  Logger.log(textoLimite_());
}

/* ===== Web app ===== */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const acao = p.acao || '';
  const voz = acao === 'lancar' || acao === 'limite' || acao === 'detalhe';
  if (acao === 'ping' && !p.chave) return json_({ ok: true, app: 'Caixa da Família' });
  const recusa = voz && p.t ? checarChaveVoz_(p.t) : checarChave_(p.chave);
  if (recusa) return voz ? texto_(recusa) : json_({ erro: 'chave', mensagem: recusa });
  try {
    if (acao === 'ping') return json_({ ok: true, app: 'Caixa da Família' });
    if (acao === 'tudo') return json_({ ok: true, dados: lerTudo_(), agora: new Date().toISOString() });
    if (acao === 'lancar') return texto_(lancarPorTexto_(p.texto || '', p.quem || ''));
    if (acao === 'limite') { carregarEstado_(lerTudo_()); return texto_(textoLimite_()); }
    if (acao === 'detalhe') { carregarEstado_(lerTudo_()); return texto_(textoDetalhe_()); }
    if (acao === 'tokenvoz') return json_({ ok: true, token: chaveVoz_() });
    return json_({ erro: 'acao' });
  } catch (err) {
    console.error(err);
    return voz ? texto_('Não consegui registrar agora. Tente de novo em instantes.') : json_({ erro: String(err && err.message || err) });
  }
}

function doPost(e) {
  let corpo = {};
  try { corpo = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { return json_({ erro: 'corpo' }); }
  const recusa = checarChave_(corpo.chave);
  if (recusa) return json_({ erro: 'chave', mensagem: recusa });
  try {
    if (corpo.acao === 'gravar') { gravar_(corpo.ops || []); return json_({ ok: true }); }
    if (corpo.acao === 'lancar') return texto_(lancarPorTexto_(corpo.texto || '', corpo.quem || ''));
    return json_({ erro: 'acao' });
  } catch (err) {
    console.error(err);
    return json_({ erro: String(err && err.message || err) });
  }
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function texto_(t) { return ContentService.createTextOutput(String(t)).setMimeType(ContentService.MimeType.TEXT); }

/** A chave da família: a da linha 11 ou, se ela estiver com o texto padrão, a última que foi guardada. */
function chaveEfetiva_() {
  const props = PropertiesService.getScriptProperties();
  if (CHAVE !== 'TROQUE-ESTA-CHAVE' && CHAVE.length >= 6) {
    if (props.getProperty('CHAVE_SALVA') !== CHAVE) props.setProperty('CHAVE_SALVA', CHAVE);
    return CHAVE;
  }
  return props.getProperty('CHAVE_SALVA') || '';
}

function falhou_(cache, falhas) { cache.put('falhas', String(falhas + 1), 900); }

function checarChave_(c) {
  const cache = CacheService.getScriptCache();
  const falhas = +(cache.get('falhas') || 0);
  if (falhas >= 20) return 'Muitas tentativas com a chave errada. Espere 15 minutos.';
  const chave = chaveEfetiva_();
  if (!chave) return 'A chave da família ainda não foi definida no Apps Script.';
  if (String(c || '') !== chave) { falhou_(cache, falhas); return 'Chave incorreta.'; }
  return null;
}

/** Chave só da Siri: lança e informa o limite, mas não lê nem apaga os dados. */
function chaveVoz_() {
  const props = PropertiesService.getScriptProperties();
  let t = props.getProperty('CHAVE_VOZ');
  if (!t) { t = Utilities.getUuid().replace(/-/g, '').slice(0, 24); props.setProperty('CHAVE_VOZ', t); }
  return t;
}

function checarChaveVoz_(t) {
  const cache = CacheService.getScriptCache();
  const falhas = +(cache.get('falhas') || 0);
  if (falhas >= 20) return 'Muitas tentativas com a chave errada. Espere 15 minutos.';
  if (String(t || '') !== chaveVoz_()) { falhou_(cache, falhas); return 'O atalho está com uma chave antiga. Copie o link de novo no app.'; }
  return null;
}

/** Rode pelo editor se um link de atalho vazar: os links antigos param de funcionar. */
function trocarChaveVoz() {
  PropertiesService.getScriptProperties().deleteProperty('CHAVE_VOZ');
  chaveVoz_();
  Logger.log('Nova chave da Siri criada. No app, em Ajustes, copie os links de novo e atualize os atalhos.');
}

/* ===== Planilha ===== */

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('PLANILHA_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function abaDados_() {
  const ss = ss_();
  let sh = ss.getSheetByName(ABA_DADOS);
  if (!sh) {
    sh = ss.insertSheet(ABA_DADOS);
    sh.getRange(1, 1, 1, 4).setValues([['colecao', 'id', 'json', 'atualizado']]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:B').setNumberFormat('@');
  }
  return sh;
}

function lerTudo_() {
  const sh = abaDados_();
  const n = sh.getLastRow();
  const out = {};
  COLECOES.forEach(function (c) { out[c] = {}; });
  if (n < 2) return out;
  sh.getRange(2, 1, n - 1, 3).getValues().forEach(function (r) {
    const c = String(r[0]), id = String(r[1]);
    if (!c || !id || !out[c]) return;
    try { out[c][id] = JSON.parse(r[2]); } catch (x) { /* linha corrompida: ignora */ }
  });
  return out;
}

function mesclar_(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const r = JSON.parse(JSON.stringify(a));
  Object.keys(b).forEach(function (k) { r[k] = mesclar_(r[k], b[k]); });
  return r;
}

function gravar_(ops) {
  if (!Array.isArray(ops)) throw new Error('operações inválidas');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = abaDados_();
    const n = sh.getLastRow();
    const keys = n > 1 ? sh.getRange(2, 1, n - 1, 2).getValues().map(function (r) { return r[0] + '/' + r[1]; }) : [];
    const agora = new Date();
    let mexeuLanc = false;
    ops.forEach(function (o) {
      if (!o || COLECOES.indexOf(o.col) < 0 || !o.id || !/^[\w.\-:@+~]{1,200}$/.test(o.id)) throw new Error('operação inválida');
      const k = o.col + '/' + o.id;
      const idx = keys.indexOf(k);
      if (o.op === 'delete') {
        if (idx >= 0) { sh.deleteRow(idx + 2); keys.splice(idx, 1); }
      } else if (o.op === 'set' || o.op === 'update') {
        let data = o.data;
        if (o.op === 'update' && idx >= 0) data = mesclar_(JSON.parse(sh.getRange(idx + 2, 3).getValue()), o.data);
        const txt = JSON.stringify(data);
        if (txt.length > 49000) throw new Error('documento grande demais: ' + k);
        if (idx >= 0) sh.getRange(idx + 2, 3, 1, 2).setValues([[txt, agora]]);
        else {
          const linha = sh.getLastRow() + 1;
          sh.getRange(linha, 1, 1, 2).setNumberFormat('@');
          sh.getRange(linha, 1, 1, 4).setValues([[o.col, o.id, txt, agora]]);
          keys.push(k);
        }
      } else throw new Error('operação inválida');
      if (o.col === 'transactions') mexeuLanc = true;
    });
    SpreadsheetApp.flush();
    if (mexeuLanc) atualizarAbaLancamentos_();
  } finally {
    lock.releaseLock();
  }
}

/** Aba só para leitura humana: todos os lançamentos, do mais novo para o mais antigo. */
function atualizarAbaLancamentos_() {
  const ss = ss_();
  const sh = ss.getSheetByName(ABA_LANC) || ss.insertSheet(ABA_LANC);
  carregarEstado_(lerTudo_());
  const linhas = S.tx.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1); })
    .map(function (x) {
      const p = String(x.date || '').split('-');
      return [p[2] + '/' + p[1] + '/' + p[0], x.type === 'in' ? 'Entrada' : 'Saída', (x.type === 'in' ? 1 : -1) * (+x.amount || 0),
        catName(x.category), x.method ? methodName(x.method) : '', x.desc || '', x.by || ''];
    });
  sh.clearContents();
  sh.getRange(1, 1, 1, 7).setValues([['Data', 'Tipo', 'Valor (R$)', 'Categoria', 'Forma', 'Descrição', 'Quem']]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (linhas.length) {
    sh.getRange(2, 1, linhas.length, 7).setValues(linhas);
    sh.getRange(2, 1, linhas.length, 1).setNumberFormat('@');
    sh.getRange(2, 3, linhas.length, 1).setNumberFormat('#,##0.00');
  }
}

function carregarEstado_(d) {
  S.config = d.config && d.config.main ? d.config.main : null;
  S.plan = d.plan && d.plan.main ? d.plan.main : { steps: [] };
  if (!S.plan.steps) S.plan.steps = [];
  const vals = function (o) { return Object.keys(o || {}).map(function (k) { return o[k]; }); };
  S.tx = vals(d.transactions); S.debts = vals(d.debts); S.bills = d.bills || {}; S.hon = vals(d.honorarios);
}

/* ===== Voz (Siri) ===== */

function catFalada_(id) { return catName(id).replace(/\s*\([^)]*\)/g, '').trim(); }
const FORMA_FALADA = { pix: 'no Pix', debito: 'no débito', dinheiro: 'em dinheiro', cartao: 'no cartão de crédito' };

function lancarPorTexto_(texto, quem) {
  carregarEstado_(lerTudo_());
  if (!S.config) return 'A Caixa ainda não tem dados. Rode a função instalar no Apps Script.';
  const p = parseQuick(texto);
  if (!(p.amount > 0)) return 'Não entendi o valor. Diga, por exemplo: 32 reais de frango no Pix.';
  let semCategoria = false;
  if (!p.category) {
    semCategoria = true;
    p.category = p.type === 'in' ? 'extra' : (flexCats().some(function (c) { return c.id === 'outros'; }) ? 'outros' : (flexCats()[0] || { id: 'outros' }).id);
  }
  const id = 't-' + uid();
  const body = { id: id, type: p.type, amount: p.amount, desc: p.desc || catName(p.category), category: p.category, method: p.method,
    date: p.date, by: quem || 'Siri', createdAt: new Date().toISOString(), origem: 'voz' };
  gravar_([{ op: 'set', col: 'transactions', id: id, data: body }]);
  carregarEstado_(lerTudo_());
  let msg = (p.type === 'in' ? 'Entrada lançada: ' : 'Lançado: ') + fmt(p.amount) + ' em ' + catFalada_(p.category) + (p.method ? ', ' + FORMA_FALADA[p.method] : '') + '.';
  if (p.method === 'cartao') msg += ' Atenção: foi no cartão de crédito.';
  if (semCategoria) msg += ' Não reconheci a categoria, então coloquei em ' + catFalada_(p.category) + '. Se precisar, corrija no app.';
  if (p.type === 'out') {
    const k = computeToday();
    msg += k.restHoje >= 0 ? ' Hoje ainda dá para gastar ' + fmt(k.restHoje) + '.' : ' Você passou ' + fmt(-k.restHoje) + ' do limite de hoje.';
  } else if (p.category !== 'reembolso' && p.category !== 'ajuste' && +S.config.dizimoPct) {
    msg += ' O dízimo de ' + fmt(p.amount * S.config.dizimoPct / 100) + ' já entrou na lista.';
  }
  return msg;
}

function textoLimite_() {
  if (!S.config) return 'A Caixa ainda não tem dados.';
  const k = computeToday();
  if (k.restHoje < 0) return 'Hoje você já passou ' + fmt(-k.restHoje) + ' do limite.';
  return 'Você pode gastar ' + fmt(k.restHoje) + ' hoje.';
}

function textoDetalhe_() {
  if (!S.config) return 'A Caixa ainda não tem dados.';
  const k = computeToday();
  const ate = k.nextInc ? ' até o dia ' + (+k.nextInc.date.slice(8)) + ', quando entra ' + k.nextInc.name.replace(/\s*\([^)]*\)/g, '') : ' até o fim do mês';
  return 'Seu limite é de ' + fmt(k.perDay) + ' por dia' + ate + '. Hoje você já gastou ' + fmt(k.todayFlex) + '.';
}
