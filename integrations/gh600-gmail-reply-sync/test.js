const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(__dirname + '/Code.gs', 'utf8');

class FakeRange {
  constructor(sheet, row, col, height=1, width=1) { Object.assign(this,{sheet,row,col,height,width}); }
  getValues() { return Array.from({length:this.height},(_,i)=>Array.from({length:this.width},(_,j)=>this.sheet.get(this.row+i,this.col+j))); }
  getValue(){return this.sheet.get(this.row,this.col);}
  getDisplayValue() { return String(this.sheet.get(this.row,this.col)||''); }
  setValues(rows) { assert.equal(rows.length,this.height); rows.forEach((r,i)=>{assert.equal(r.length,this.width);r.forEach((v,j)=>this.sheet.put(this.row+i,this.col+j,v));}); return this; }
  setValue(v){this.sheet.put(this.row,this.col,v);return this;}
}
class FakeSheet {
  constructor(name){this.name=name;this.data=[];this.frozen=0;}
  get(row,col){return (this.data[row-1]||[])[col-1]??'';}
  put(row,col,value){while(this.data.length<row)this.data.push([]);this.data[row-1][col-1]=value;}
  getRange(row,col,height=1,width=1){return new FakeRange(this,row,col,height,width);}
  getLastRow(){return this.data.length;}
  appendRow(row){this.data.push(row.slice());}
  setFrozenRows(v){this.frozen=v;}
}
class FakeBook{
  constructor(){this.sheets=new Map();}
  getSheetByName(name){return this.sheets.get(name)||null;}
  insertSheet(name){let s=new FakeSheet(name);this.sheets.set(name,s);return s;}
}
const book=new FakeBook();
const master=book.insertSheet('MASTER_LEADS'),supp=book.insertSheet('GH600_SUPPRESSION');
master.getRange(1,1,1,49).setValues([Array.from({length:49},(_,i)=>'COLUMN '+i)]);
supp.getRange(1,1).setValue('Lead ID');
const props = new Map([['GH600_SPREADSHEET_ID','sandbox-fake'],['GH600_E2E_MESSAGE_ID','live-controlled-inbox-msg-0001'],['GH600_E2E_SENDER','visualjambo@gmail.com']]);
const raw = (name,value)=>({name,value});
function msg(id,from,extras={}){
 return {id, threadId:'thread-'+id, internalDate:'1792728000000', labelIds:['INBOX'],payload:{headers:[raw('From',from),raw('Subject',extras.subject||'Re: GH600 e2e'),raw('Message-ID','<rfc-'+id+'>'),raw('In-Reply-To','<original-id>'),...(extras.headers||[])]}};
}
const controlled=msg('live-controlled-inbox-msg-0001','Name <visualjambo@gmail.com>');
const cx={Object,Array,String,Number,Date,RegExp,JSON,Error,console,
 Session:{getEffectiveUser:()=>({getEmail:()=> 'hello@ghoulhouse.fi'})},
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v)})},
 SpreadsheetApp:{openById:id=>{assert.equal(id,'sandbox-fake');return book;},flush:()=>{}},
 Gmail:{Users:{Messages:{get:(_me,id)=>{assert.equal(id,controlled.id);return controlled;}},
 Threads:{get:(_me,tid)=>({messages:[{labelIds:['SENT'],payload:{headers:[raw('From','GhoulHouse <hello@ghoulhouse.fi>'),raw('To',tid==='thread-live-controlled-inbox-msg-0001' ? 'visualjambo@gmail.com' : (tid==='thread-retry-msg' || tid==='thread-suppressed-msg' ? 'person@client.example' : tid==='thread-ambiguous' ? 'duplicate@example.com' : tid==='thread-lost-email' ? 'lost@example.com' : 'dry@example.com'))]}}]})}}},
 LockService:{getScriptLock:()=>({waitLock:()=>{},releaseLock:()=>{}})},
 Utilities:{formatDate:(_d,_z,format)=>{assert.equal(format,'yyyy-MM-dd');return '2026-10-23';}},
 ScriptApp:{getProjectTriggers:()=>[],newTrigger:()=>({timeBased:()=>({everyMinutes:()=>({create:()=>{}})})})}
};
vm.createContext(cx);vm.runInContext(code,cx,{filename:'Code.gs'});
assert.equal(cx.gh600Email_('Mr <Hello@Example.com>'),'hello@example.com');
assert.equal(cx.gh600IsReply_(controlled),true);
assert.equal(cx.gh600IsReply_(msg('auto','bot@example.com',{headers:[raw('List-Id','robots')]})),false);
assert.equal(cx.gh600IsReply_(msg('self','hello@ghoulhouse.fi')),false);
assert.equal(cx.gh600Safe_('=IMPORTXML("a","b")'),"'=IMPORTXML(\"a\",\"b\")");
const e2e1=cx.gh600RunAuthenticatedE2E();
assert.equal(e2e1.result,'PASS');
assert.equal(e2e1.first,'DONE');assert.equal(e2e1.second,'DUPLICATE');assert.equal(e2e1.eventRows,1);
const tl=book.getSheetByName('GH600_E2E_TEST_LEADS'),te=book.getSheetByName('GH600_E2E_TEST_EVENTS');
assert.equal(tl.get(2,33),'Kontaktoitu');
assert.equal(tl.get(2,34),'2026-10-23');
assert.equal(te.getLastRow(),2);
assert.equal(props.get('GH600_E2E_PASS'),'true');
const e2e2=cx.gh600RunAuthenticatedE2E();assert.equal(e2e2.first,'DUPLICATE');assert.equal(e2e2.second,'DUPLICATE');assert.equal(te.getLastRow(),2);
// Fail/retry midway: durable ledger PENDING is recoverable without writing a second event.
const event2=cx.gh600EnsureEvents_(book,'GH600_RETRY_TEST_EVENTS');
const lead2=book.insertSheet('GH600_RETRY_TEST_LEADS');lead2.getRange(1,1,1,49).setValues([Array(49).fill('')]);const row=Array(49).fill('');row[0]='TEST-2';row[8]='person@client.example';row[32]='Uusi';lead2.getRange(2,1,1,49).setValues([row]);
const r2=msg('retry-msg','person@client.example');
event2.appendRow([r2.id,'','','','','','','TEST-2',2,'REPLY_RECEIVED','PENDING','','']);
assert.equal(cx.gh600Process_(r2,lead2,supp,event2,false),'DONE');assert.equal(cx.gh600Process_(r2,lead2,supp,event2,false),'DUPLICATE');assert.equal(event2.getLastRow(),2);
// A suppressed lead receives a reply: record HOLD, never change its status.
supp.appendRow(['TEST-2','','','NEGATIVE SALES REPLY']);
const s2=msg('suppressed-msg','person@client.example');assert.equal(cx.gh600Process_(s2,lead2,supp,event2,false),'HOLD');assert.equal(event2.getLastRow(),3);
// Duplicate active email in two CRM rows -> quarantine and no mutation.
const dup=book.insertSheet('GH600_DUP_LEADS');dup.getRange(1,1,1,49).setValues([Array(49).fill('')]);
for(let k=2;k<=3;k++){let z=Array(49).fill('');z[0]='GH-'+k;z[8]='duplicate@example.com';z[32]='Uusi';dup.getRange(k,1,1,49).setValues([z]);}
assert.equal(cx.gh600Process_(msg('ambiguous','duplicate@example.com'),dup,supp,event2,false),'QUARANTINE');assert.equal(dup.get(2,33),'Uusi');assert.equal(dup.get(3,33),'Uusi');
// Immutable CRM stage must remain unchanged.
const imm=book.insertSheet('GH600_IMM_LEADS');imm.getRange(1,1,1,49).setValues([Array(49).fill('')]);let x=Array(49).fill('');x[0]='GH-IMM';x[8]='lost@example.com';x[32]='Hävitty';imm.getRange(2,1,1,49).setValues([x]);
assert.equal(cx.gh600Process_(msg('lost-email','lost@example.com'),imm,supp,event2,false),'HOLD');assert.equal(imm.get(2,33),'Hävitty');
// Dry-run should leave existing records unchanged.
const dry=book.insertSheet('GH600_DRY_LEADS');dry.getRange(1,1,1,49).setValues([Array(49).fill('')]);const dy=Array(49).fill('');dy[0]='GH-DRY';dy[8]='dry@example.com';dy[32]='Uusi';dry.getRange(2,1,1,49).setValues([dy]);const before=event2.getLastRow();
assert.equal(cx.gh600Process_(msg('dry-email','dry@example.com'),dry,supp,event2,true),'DONE');assert.equal(event2.getLastRow(),before);assert.equal(dry.get(2,33),'Uusi');
console.log('PASS: 13 checks; real-message-shaped isolated E2E, 1 event after 2 passes, retry, suppression, ambiguity, immutable stage, dry-run, formula safety');