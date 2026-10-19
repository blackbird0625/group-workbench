/* ============================================================
 * 小组作业工作台 · 前端逻辑（app.js）
 * ------------------------------------------------------------
 * 整体结构（从上到下）：
 *   1. 基础工具函数（DOM 选择、转义、日期格式化、弹提示）
 *   2. 站点配置读取（改 config.js 即可定制，不用动本文件）
 *   3. API 请求层（统一走 /api，后端需按 API.md 实现）
 *   4. 初始化与登录流程（bootstrap → 初始化/选身份 → PIN 验证）
 *   5. 成员管理（仅管理员）
 *   6. 提醒横幅（DDL / 周日进度 / 管理员待办）
 *   7. 权限判断（谁能改状态、谁能编辑）
 *   8. 各页面渲染（总览 / 看板 / 任务详情 / 交付文档 / 资料库 /
 *      公告 / 审议意见 / 文献汇总）+ 对应的操作函数
 *   9. 备份与恢复
 * 10. 弹窗开关，最后启动 init()
 * ============================================================ */

/* ---- 1. 基础工具 ---- */
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const days=d=>{if(!d)return null;const t=new Date();t.setHours(0,0,0,0);return Math.round((new Date(d+'T00:00:00')-t)/864e5)};
const fmtD=d=>{if(!d)return'';const p=d.split('-');return p[1]+'/'+p[2]};
const fmtFull=ts=>{const d=new Date(ts);return (d.getMonth()+1)+'/'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')};
const ago=ts=>{const m=Math.floor((Date.now()-ts)/6e4);if(m<1)return'刚刚';if(m<60)return m+'分钟前';const h=Math.floor(m/60);if(h<24)return h+'小时前';const dd=Math.floor(h/24);return dd<7?dd+'天前':new Date(ts).toLocaleDateString('zh-CN')};
const fmtSize=b=>{if(b<1024)return b+'B';if(b<1048576)return (b/1024).toFixed(1)+'KB';return (b/1048576).toFixed(2)+'MB'};
function toast(msg,type){const e=document.createElement('div');e.className='toast '+(type||'');e.textContent=msg;$('#toasts').appendChild(e);setTimeout(()=>{e.style.opacity='0';e.style.transition='.2s'},2400);setTimeout(()=>e.remove(),2700)}

/* ---- 2. 站点配置 ----
 * 配置有两层来源，优先级从高到低：
 *   ① 初始化向导里保存到服务端的设置（S.settings，第一个打开的人选的）
 *   ② public/config.js 里的默认预设（作为向导的预填值）
 * 向导保存的设置跟随数据走，恢复备份也不丢。 */
const STATUS={unclaimed:'待认领',doing:'进行中',review:'待审核',rework:'需返工',done:'已完成'};
let LINES={},LINE_KEYS=[],RES_CATS={},MODS={},CFG=null;
function buildCfg(src){
  const def=window.WB_CONFIG||{};
  const s=src||{};
  const lines=(s.lines&&Object.keys(s.lines).length)?s.lines:(def.lines||{other:'其他'});
  const resCats=(s.resCats&&Object.keys(s.resCats).length)?s.resCats:(def.resCats||{other:{name:'其他',icon:'◈'}});
  return {
    title:String(s.title||def.title||'小组作业工作台').slice(0,40),
    subtitle:s.subtitle!==undefined?s.subtitle:(def.subtitle||''),
    adminLabel:s.adminLabel||def.adminLabel||'管理员',   // 管理员的显示称呼（组长/队长…）
    modules:Object.assign({},def.modules,s.modules),
    perms:Object.assign({},def.perms,s.perms),   // 权限矩阵：'admin' 仅管理员 / 'all' 所有人
    lines,resCats
  };
}
function refreshCfg(){
  CFG=buildCfg(S&&S.settings);
  LINES=CFG.lines;LINE_KEYS=Object.keys(LINES);
  RES_CATS=CFG.resCats;MODS=CFG.modules;
}
const modOn=k=>!MODS[k]||MODS[k].on!==false;  // 未配置的模块默认开启
const modName=(k,fallback)=>(MODS[k]&&MODS[k].name)||fallback;  // 模块显示名
/* 权限判断：向导里每个操作可设为 'admin'（仅管理员）或 'all'（所有成员） */
const permAll=k=>!!(CFG&&CFG.perms&&CFG.perms[k]==='all');
const can=k=>permAll(k)||isAdmin();
const lineName=k=>LINES[k]||k;
const TOKEN_KEY='workbench-session';
let S=null,me=null,view='dash',curTask=null,editTask=null;
let taskF={line:'all',who:'all'},resCat='all',revF='all';
let uploadTarget=null,serverTimeOffset=0,lastSync=0,pollTimer=null;
let taskTab='info',docEditMode=false,docViewVer=null,docQuote='';
let token=localStorage.getItem(TOKEN_KEY)||null;

const isAdmin=()=>me&&me.isAdmin;
const getMember=id=>S.members.find(m=>m.id===id);

/* ============ 分类配色（按分类顺序自动分配颜色；配置变化时重算） ============ */
let _cfgStyle=null;
function applyLineColors(){
  const palette=[
    ['var(--sec)','var(--sec-bg)'],
    ['var(--pri)','var(--pri-bg)'],
    ['var(--acc)','var(--acc-bg)'],
    ['var(--info)','var(--info-bg)'],
    ['var(--ok)','var(--ok-bg)'],
    ['#8A6BB5','#F0EAF8']
  ];
  let css='';
  LINE_KEYS.forEach((k,i)=>{
    const p=palette[i%palette.length];
    css+='.tcard.line-'+k+'{border-left-color:'+p[0]+'}'+'.line-tag-'+k+'{background:'+p[1]+';color:'+p[0]+'}';
  });
  Object.keys(RES_CATS).forEach((k,i)=>{
    const p=palette[(i+1)%palette.length];
    css+='.res-icon.cat-'+k+'{background:'+p[1]+';color:'+p[0]+'}';
  });
  if(!_cfgStyle){_cfgStyle=document.createElement('style');document.head.appendChild(_cfgStyle);}
  _cfgStyle.textContent=css;
}
function applyConfig(){
  if(!CFG)return;
  /* 浏览器标签页标题 + 左上角项目名 */
  document.title=CFG.title+' · 小组工作台';
  $('#side-title').textContent=CFG.title;
  $('#side-sub').textContent=CFG.subtitle||'';
  /* 按配置重命名侧栏按钮、关闭的模块直接隐藏
     （角标 span 里有 id，重写按钮内容时要摘下来再放回去） */
  const defs={dash:['◎','总览'],tasks:['▤','任务看板'],resources:['◈','资料库'],announcements:['◇','公告区'],lits:['📚','文献汇总'],reviews:['✎','审议意见'],help:['❓','使用说明']};
  Object.keys(defs).forEach(k=>{
    const btn=$('.nav-btn[data-v="'+k+'"]');
    if(!btn)return;
    const badge=btn.querySelector('.nav-badge');
    const m=MODS[k]||{};
    btn.innerHTML='<span>'+(m.icon||defs[k][0])+'</span>'+esc(m.name||defs[k][1]);
    if(badge)btn.appendChild(badge);
    btn.style.display=modOn(k)?'':'none';
  });
  applyLineColors();
}

/* ============ API ============ */
async function api(path,opts={}){
  const headers={'Content-Type':'application/json',...(opts.headers||{})};
  if(token)headers['X-Session']=token;
  const res=await fetch('/api'+path,{method:opts.method||'GET',headers,body:opts.body?JSON.stringify(opts.body):undefined});
  const data=await res.json().catch(()=>({error:'响应解析失败'}));
  if(!res.ok)throw new Error(data.error||('HTTP '+res.status));
  return data;
}
async function bootstrap(){
  const res=await fetch('/api/bootstrap');
  const data=await res.json();
  if(!data.ok)throw new Error('加载失败');
  S=data.state;
  serverTimeOffset=data.serverTime-Date.now();
  lastSync=Date.now();
  return data;
}
function setSync(ok){
  $('#sync-dot').className='sync'+(ok?'':' off');
  $('#sync-txt').textContent=ok?'已同步 '+new Date(lastSync).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'连接异常';
}

/* ============ Init ============ */
async function init(){
  try{
    await bootstrap();
  }catch(e){
    $('#loading').innerHTML='<div style="text-align:center;color:var(--err)"><div style="font-size:32px;margin-bottom:10px">⚠️</div>加载失败：'+esc(e.message)+'<br/><button class="btn btn-s btn-sm" style="margin-top:14px" onclick="location.reload()">重试</button></div>';
    return;
  }
  refreshCfg();
  applyConfig();
  if(!S.setupDone||!S.members.length){
    showSetup();
    $('#loading').classList.add('hide');
    return;
  }
  // 尝试自动登录：Cookie（一年有效）或本机旧令牌
  try{
    const r=await api('/auth/me');
    if(r.me){me=r.me;enterMain();$('#loading').classList.add('hide');return}
  }catch(e){/* 未登录，走登录页 */}
  token=null;localStorage.removeItem(TOKEN_KEY);
  showWelcome();
  $('#loading').classList.add('hide');
}
function showWelcome(){
  $('#welcome').classList.add('on');
  $('#wel-pin').style.display='none';
  $$('.wel-pick').forEach(e=>e.classList.remove('on'));
  $('#wel-mem').innerHTML=S.members.map(m=>
    '<div class="wel-pick" data-id="'+m.id+'" onclick="pickWho(\''+m.id+'\')">'+
      '<div class="avatar '+(m.isAdmin?'admin':'')+'">'+esc(m.name[0])+'</div>'+
      '<div><div class="wel-name">'+esc(m.name)+(m.isAdmin?' ★':'')+(m.pinBound?' 🔒':'')+'</div><div class="wel-role">'+esc(m.role)+(m.pinBound?'':' · 未设PIN')+'</div></div>'+
    '</div>').join('');
}
/* ---- 初始化向导（像装系统：名称 → 功能模块 → 任务分类 → 资料分类 → 成员与管理员） ---- */
let SU=null;
const SU_STEPS=['基本信息','功能模块','权限设置','任务分类','资料库分类','成员与管理员'];
const SU_OPTS=[   // 可选模块：key / 显示名 / 一句话说明
  ['resources','资料库','上传文件、分类管理、贴网盘链接'],
  ['announcements','公告区','会议通知、阶段目标、置顶公告'],
  ['lits','文献汇总','提交文献题目、投票审稿、导出清单'],
  ['reviews','审议意见','对任务安排提建议，管理员裁决']
];
const SU_PERMS=[  // 可配置权限：key / 显示名 / 开放给所有人时的说明
  ['createTask','新建任务','所有成员都可新建任务'],
  ['deleteTask','删除任务','所有成员都可删除任务'],
  ['assignTask','指定负责人','所有成员都可指派/更换负责人'],
  ['markRework','标记需返工','所有成员都可标记返工（仍需填意见）'],
  ['markDone','验收完成','所有成员都可标记任务完成'],
  ['announce','发布公告','所有成员都可发布/置顶/删除公告'],
  ['resolveReview','处理意见','所有成员都可处理审议意见与文档意见'],
  ['adoptLit','采纳文献','所有成员都可采纳文献条目'],
  ['memberManage','成员管理','所有成员都可改名/增删成员（谨慎）'],
  ['backup','备份恢复','所有成员都可备份/恢复数据（谨慎）']
];
/* 预设方案：一步套用，套用后仍可在下方逐项自定义 */
const SU_MOD_PRESETS=[   // [方案名, 模块开关（null=全开）]
  ['全套功能',null],
  ['极简',    {resources:true,announcements:false,lits:false,reviews:false}],
  ['文献型',  {resources:true,announcements:true,lits:true,reviews:false}]
];
const SU_PERM_PRESETS=[  // [方案名, 开放给所有人的权限 key 集合]
  ['组长集权',{}],
  ['民主协作',{createTask:1,announce:1,markDone:1,adoptLit:1}],
  ['高度自治',{createTask:1,deleteTask:1,assignTask:1,markRework:1,markDone:1,announce:1,resolveReview:1,adoptLit:1}]
];
const SU_LINE_PRESETS=[  // [方案名, 任务分类名列表]
  ['写作型',['文案写作','资料收集','其他']],
  ['视频型',['脚本','拍摄','剪辑','其他']],
  ['研究型',['文献调研','数据分析','报告撰写','其他']]
];
const SU_RESCAT_PRESETS=[  // [方案名, 资料分类名列表]
  ['文档型',['文献资料','参考文件','其他']],
  ['媒体型',['影像素材','音频素材','参考文件','其他']],
  ['通用',  ['参考资料','其他']]
];
function showSetup(){
  const def=window.WB_CONFIG||{};
  SU={step:0,title:def.title||'小组作业工作台',subtitle:def.subtitle||'',
      adminLabel:def.adminLabel||'组长',members:[{name:'',admin:true}],modules:{},perms:{},lines:[],resCats:[]};
  SU_OPTS.forEach(o=>SU.modules[o[0]]=true);                                    // 可选模块默认全开
  SU_PERMS.forEach(p=>SU.perms[p[0]]=(def.perms&&def.perms[p[0]])==='all');     // 权限默认按预设（均为仅管理员）
  Object.values(def.lines||{other:'其他'}).forEach(v=>SU.lines.push(v));        // 分类用预设预填
  Object.values(def.resCats||{}).forEach(v=>SU.resCats.push(v.name));
  $('#setup').style.display='flex';
  suRender();
}
function suRender(){
  $('#su-step').textContent='第 '+(SU.step+1)+' / '+SU_STEPS.length+' 步 · '+SU_STEPS[SU.step];
  $('#su-prev').style.visibility=SU.step?'visible':'hidden';
  $('#su-next').textContent=SU.step===SU_STEPS.length-1?'创建工作台':'下一步 →';
  let h='';
  if(SU.step===0){
    h='<div class="fg"><label class="fl">工作台名称</label><input class="fi" id="su-title" maxlength="30" value="'+esc(SU.title)+'" placeholder="如：期末视频项目工作台"/></div>'+
      '<div class="fg"><label class="fl">副标题（选填）</label><input class="fi" id="su-subtitle" maxlength="40" value="'+esc(SU.subtitle)+'" placeholder="显示在名称下方的小字"/></div>'+
      '<div class="fg"><label class="fl">管理员称呼（只影响显示）</label><input class="fi" id="su-alabel" maxlength="10" value="'+esc(SU.adminLabel)+'" placeholder="如：组长 / 队长 / 负责人"/></div>';
  }else if(SU.step===1){
    h='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">'+SU_MOD_PRESETS.map((p,i)=>'<button class="filter-chip" onclick="suModPreset('+i+')">'+p[0]+'</button>').join('')+'</div>'+
      '<div class="hint" style="margin:0 0 10px">总览、任务看板、使用说明是常驻核心。点上方方案一键套用，或在下面逐项勾选：</div>';
    SU_OPTS.forEach(o=>{
      h+='<label style="display:flex;gap:9px;align-items:flex-start;padding:9px 11px;border:1.5px solid var(--border);border-radius:var(--rs);margin-bottom:7px;cursor:pointer">'+
        '<input type="checkbox" class="su-mod" data-k="'+o[0]+'"'+(SU.modules[o[0]]?' checked':'')+' style="margin-top:3px"/>'+
        '<span><b>'+o[1]+'</b><span style="display:block;font-size:11px;color:var(--mut)">'+o[2]+'</span></span></label>';
    });
  }else if(SU.step===2){
    h='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">'+SU_PERM_PRESETS.map((p,i)=>'<button class="filter-chip" onclick="suPermPreset('+i+')">'+p[0]+'</button>').join('')+'</div>'+
      '<div class="hint" style="margin:0 0 10px">默认这些操作仅<strong>'+esc(SU.adminLabel||'管理员')+'</strong>可用。点上方方案一键套用，或勾选开放给所有成员——谁有什么权利，由你全权决定：</div>'+
      SU_PERMS.map(p=>'<label style="display:flex;gap:9px;align-items:flex-start;padding:8px 11px;border:1.5px solid var(--border);border-radius:var(--rs);margin-bottom:6px;cursor:pointer">'+
        '<input type="checkbox" class="su-perm" data-k="'+p[0]+'"'+(SU.perms[p[0]]?' checked':'')+' style="margin-top:3px"/>'+
        '<span><b>'+p[1]+'</b><span style="display:block;font-size:11px;color:var(--mut)">'+p[2]+'</span></span></label>').join('');
  }else if(SU.step===3||SU.step===4){
    const presets=SU.step===3?SU_LINE_PRESETS:SU_RESCAT_PRESETS;
    h='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">'+presets.map((p,i)=>'<button class="filter-chip" onclick="suCatPreset('+i+')">'+p[0]+'</button>').join('')+'</div>'+
      '<div class="hint" style="margin:0 0 10px">'+(SU.step===3
      ?'任务分类用在看板筛选和任务卡片上，颜色自动分配。点上方方案套用，或在下方自定义增删改。'
      :'资料库的分类，上传资料时选择。点上方方案套用，或在下方自定义增删改。')+'</div><div id="su-cats">'+suCatRows(SU.step===3?SU.lines:SU.resCats)+'</div>';
  }else{
    h='<div class="hint" style="margin:0 0 10px">填写小组全部成员，勾选「管理」的人拥有管理员权限（可以多个）。至少需要一名管理员，之后也可在成员管理里调整。</div>'+
      '<div id="su-members">'+SU.members.map((m,i)=>
        '<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">'+
        '<input class="fi su-mem" value="'+esc(m.name)+'" maxlength="12" placeholder="成员 '+(i+1)+'" style="flex:1"/>'+
        '<label style="display:flex;gap:4px;align-items:center;font-size:12px;color:var(--txt2);flex-shrink:0;cursor:pointer"><input type="checkbox" class="su-mem-admin"'+(m.admin?' checked':'')+'/>管理</label>'+
        (SU.members.length>1?'<button class="btn btn-d btn-sm" style="flex-shrink:0" onclick="suDelMem('+i+')">删</button>':'')+
        '</div>').join('')+'</div>'+
      '<button class="btn btn-s btn-sm" onclick="suAddMem()">+ 添加成员</button>';
  }
  $('#su-body').innerHTML=h;
}
/* 分类行 / 成员行：增删后重画，翻页前先把输入收进 SU（上一步回来内容不丢） */
function suCatRows(arr){
  return arr.map((v,i)=>'<div style="display:flex;gap:6px;margin-bottom:6px"><input class="fi su-cat" value="'+esc(v)+'" maxlength="20" style="flex:1" placeholder="分类名称"/><button class="btn btn-d btn-sm" onclick="suDelCat('+i+')">删</button></div>').join('')
    +'<button class="btn btn-s btn-sm" onclick="suAddCat()">+ 添加分类</button>';
}
/* 预设方案：一键套用到当前向导步骤，套用后仍可逐项自定义 */
function suModPreset(i){
  const p=SU_MOD_PRESETS[i][1];
  SU_OPTS.forEach(o=>SU.modules[o[0]]=p?!!p[o[0]]:true);
  suRender();
}
function suPermPreset(i){
  const p=SU_PERM_PRESETS[i][1]||{};
  SU_PERMS.forEach(x=>SU.perms[x[0]]=!!p[x[0]]);
  suRender();
}
function suCatPreset(i){
  suCollectCats();
  const arr=SU.step===3?SU.lines:SU.resCats;
  const p=(SU.step===3?SU_LINE_PRESETS:SU_RESCAT_PRESETS)[i][1];
  arr.length=0;
  p.forEach(v=>arr.push(v));
  suRender();
}
function suAddCat(){suCollectCats();(SU.step===3?SU.lines:SU.resCats).push('');suRender()}
function suDelCat(i){suCollectCats();(SU.step===3?SU.lines:SU.resCats).splice(i,1);suRender()}
function suCollectCats(){
  const arr=[...document.querySelectorAll('.su-cat')].map(x=>x.value);
  if(SU.step===3)SU.lines=arr;else SU.resCats=arr;
}
function suAddMem(){suCollectMems();SU.members.push({name:'',admin:false});suRender()}
function suDelMem(i){suCollectMems();SU.members.splice(i,1);suRender()}
function suCollectMems(){
  const names=[...document.querySelectorAll('.su-mem')].map(x=>x.value);
  const admins=[...document.querySelectorAll('.su-mem-admin')].map(x=>x.checked);
  SU.members=names.map((n,i)=>({name:n,admin:!!admins[i]}));
}
function suCollect(){
  if(SU.step===0){
    const t=$('#su-title'),s=$('#su-subtitle'),a=$('#su-alabel');
    if(t)SU.title=t.value;if(s)SU.subtitle=s.value;if(a)SU.adminLabel=a.value;
  }else if(SU.step===1){
    $$('.su-mod').forEach(x=>SU.modules[x.dataset.k]=x.checked);
  }else if(SU.step===2){
    $$('.su-perm').forEach(x=>SU.perms[x.dataset.k]=x.checked);
  }else if(SU.step===3||SU.step===4){
    suCollectCats();
  }else{
    suCollectMems();
  }
}
function suPrev(){suCollect();if(SU.step>0){SU.step--;suRender()}}
function suNext(){suCollect();if(SU.step<SU_STEPS.length-1){SU.step++;suRender()}else submitSetup()}
async function submitSetup(){
  const members=SU.members.map(m=>({name:m.name.trim(),admin:!!m.admin})).filter(m=>m.name);
  if(!members.length){toast('至少填写一名成员','w');SU.step=5;suRender();return}
  if(!members.some(m=>m.admin)){members[0].admin=true;toast('未勾选管理员，已将第一位成员设为管理员','w')}
  /* 分类名 → key：纯英文数字直接用，中文自动编号；一个都没有则给兜底 */
  const mkKey=(n,fb)=>/^[A-Za-z0-9-]+$/.test(n)?n.toLowerCase():fb;
  const lines={};
  SU.lines.forEach((n,i)=>{n=n.trim();if(n)lines[mkKey(n,'c'+(i+1))]=n});
  if(!Object.keys(lines).length)lines.other='其他';
  const icons=['📚','🎬','📄','🗂️','🧩','📌'];
  const resCats={};
  SU.resCats.forEach((n,i)=>{n=n.trim();if(n)resCats[mkKey(n,'rc'+(i+1))]={name:n,icon:icons[i%icons.length]}});
  if(!Object.keys(resCats).length)resCats.other={name:'其他',icon:'◈'};
  const perms={};
  SU_PERMS.forEach(p=>perms[p[0]]=SU.perms[p[0]]?'all':'admin');
  const settings={
    title:SU.title.trim()||'小组作业工作台',
    subtitle:SU.subtitle.trim(),
    adminLabel:SU.adminLabel.trim()||'管理员',
    modules:SU.modules, perms, lines, resCats
  };
  try{
    const res=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({members,settings})});
    const data=await res.json();
    if(!res.ok||!data.ok)throw new Error(data.error||'初始化失败');
    S=data.state;
    refreshCfg();applyConfig();
    $('#setup').style.display='none';
    showWelcome();
    toast('初始化完成，接下来为自己设置 PIN','ok');
  }catch(e){toast(e.message,'err')}
}
let pickedId=null;
function pickWho(id){
  pickedId=id;
  $$('.wel-pick').forEach(e=>e.classList.toggle('on',e.dataset.id===id));
  const m=S.members.find(x=>x.id===id);if(!m)return;
  const pinBox=$('#wel-pin');
  pinBox.style.display='';
  if(m.pinBound){
    $('#wel-pin-label').textContent='输入「'+m.name+'」的 PIN';
    $('#wel-pin-btn').textContent='验证进入';
  }else{
    $('#wel-pin-label').textContent='为「'+m.name+'」设置 PIN（4-8 位数字，设置后绑定身份）';
    $('#wel-pin-btn').textContent='设置并进入';
  }
  $('#wel-pin-input').value='';
  setTimeout(()=>$('#wel-pin-input').focus(),50);
}
function cancelPin(){
  pickedId=null;
  $('#wel-pin').style.display='none';
  $$('.wel-pick').forEach(e=>e.classList.remove('on'));
}
async function submitPin(){
  if(!pickedId)return;
  const pin=$('#wel-pin-input').value.trim();
  if(!/^\d{4,8}$/.test(pin)){toast('PIN 需为 4-8 位数字','w');return}
  const m=S.members.find(x=>x.id===pickedId);
  try{
    const r=await api(m.pinBound?'/auth/login':'/auth/bind',{method:'POST',body:{memberId:pickedId,pin}});
    token=r.token;localStorage.setItem(TOKEN_KEY,token);
    me=r.me;
    $('#welcome').classList.remove('on');
    enterMain();
    toast((m.pinBound?'欢迎回来，':'PIN 已设置，欢迎，')+me.name,'ok');
  }catch(e){toast(e.message,'err');$('#wel-pin-input').value='';$('#wel-pin-input').focus()}
}
function enterMain(){
  const sel=$('#who-sel');
  sel.innerHTML=S.members.map(m=>'<option value="'+m.id+'"'+(m.id===me.id?' selected':'')+'>'+esc(m.name)+(m.isAdmin?' ★':'')+'</option>').join('');
  refreshAdminBtns();
  render();
  setSync(true);
  if(pollTimer)clearInterval(pollTimer);
  pollTimer=setInterval(pollSync,12000);
}
function refreshAdminBtns(){
  $('#btn-backup').style.display=can('backup')?'':'none';
  $('#btn-restore').style.display=can('backup')?'':'none';
  $('#btn-member').style.display=can('memberManage')?'':'none';
}
async function pollSync(){
  try{
    await bootstrap();
    lastSync=Date.now();setSync(true);
    refreshCfg();applyConfig();   // 设置可能被恢复备份等操作改变，每次同步后重算
    // 正在输入/编辑/弹窗时跳过重渲染，避免打断用户
    const ae=document.activeElement;
    const typing=ae&&(ae.tagName==='TEXTAREA'||ae.tagName==='INPUT');
    if(typing||docEditMode||$$('.mask.on').length)return;
    if(view==='task-detail'&&S.tasks.find(t=>t.id===curTask)){renderView()}
    else{render()}
    const stillMe=S.members.find(m=>m.id===me.id);
    if(!stillMe){toast('你的身份已不存在','w');doLogout();return}
    else me=stillMe;
  }catch(e){setSync(false);console.warn('poll failed',e)}
}
function doLogout(){
  if(token||document.cookie)api('/auth/logout',{method:'POST'}).catch(()=>{});
  token=null;localStorage.removeItem(TOKEN_KEY);
  me=null;
  showWelcome();
}
function switchWho(id){
  // 切换身份 = 登出当前身份，重新验证（别人需要对方 PIN）
  if(token||document.cookie)api('/auth/logout',{method:'POST'}).catch(()=>{});
  token=null;localStorage.removeItem(TOKEN_KEY);
  me=null;render();
  toast('已登出，请选择身份并验证 PIN');
  showWelcome();
}

/* ============ 成员管理 ============ */
function openMemberM(){
  if(!can('memberManage')){toast('你没有成员管理权限','err');return}
  renderMemberList();
  openM('m-member');
}
function renderMemberList(){
  $('#mm-list').innerHTML=S.members.map(m=>{
    const taskN=S.tasks.filter(t=>t.assigneeId===m.id).length;
    return '<div style="display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-s)">'+
      '<span class="avatar '+(m.isAdmin?'admin':'')+'">'+esc(m.name[0])+'</span>'+
      '<input class="fi" value="'+esc(m.name)+'" maxlength="12" id="mm-name-'+m.id+'" style="flex:1.2;padding:5px 9px;font-size:12px"/>'+
      '<input class="fi" value="'+esc(m.role)+'" maxlength="20" id="mm-role-'+m.id+'" style="flex:2;padding:5px 9px;font-size:12px"/>'+
      '<span class="tag '+(m.pinBound?'tag-ok':'')+'" style="flex-shrink:0" title="身份PIN绑定状态">'+(m.pinBound?'🔒已绑定':'未设PIN')+'</span>'+
      '<label style="flex-shrink:0;display:flex;gap:4px;align-items:center;font-size:11px;color:var(--txt2);cursor:pointer" title="管理员可授予/撤销成员的管理权限"><input type="checkbox"'+(m.isAdmin?' checked':'')+' onchange="memberToggleAdmin(\''+m.id+'\')"/>管理</label>'+
      (m.pinBound?'<button class="btn btn-ghost btn-xs" style="flex-shrink:0" onclick="memberResetPin(\''+m.id+'\')">重置PIN</button>':'')+
      (taskN?'<span class="tag" style="flex-shrink:0" title="名下任务数">'+taskN+' 项任务</span>':'<button class="btn btn-d btn-xs" style="flex-shrink:0" onclick="memberDel(\''+m.id+'\')">删</button>')+
      '<button class="btn btn-s btn-xs" style="flex-shrink:0" onclick="memberSave(\''+m.id+'\')">保存</button>'+
    '</div>';
  }).join('');
}
async function memberResetPin(id){
  const m=S.members.find(x=>x.id===id);if(!m)return;
  if(!confirm('重置「'+m.name+'」的 PIN？重置后该身份解除绑定，下次登录重新设置（该成员当前设备会被登出）。'))return;
  try{
    const r=await api('/members/'+id,{method:'PATCH',body:{resetPin:true}});
    S=r.state;renderMemberList();
    toast('已重置「'+m.name+'」的 PIN','ok');
  }catch(e){toast(e.message,'err')}
}
async function memberSave(id){
  const name=$('#mm-name-'+id).value.trim(),role=$('#mm-role-'+id).value.trim();
  if(!name){toast('名字不能为空','w');return}
  try{
    const r=await api('/members/'+id,{method:'PATCH',body:{name,role}});
    S=r.state;
    const nm=S.members.find(m=>m.id===id);
    if(me&&me.id===id)me=nm;
    if(me)refreshAdminBtns();
    render();renderMemberList();
    const sel=$('#who-sel');sel.value=me.id;
    toast('已保存','ok');
  }catch(e){toast(e.message,'err')}
}
async function memberAdd(){
  const name=$('#mm-new-name').value.trim(),role=$('#mm-new-role').value.trim();
  if(!name){toast('填个名字','w');return}
  try{
    const r=await api('/members',{method:'POST',body:{name,role}});
    S=r.state;render();renderMemberList();
    $('#mm-new-name').value='';$('#mm-new-role').value='';
    toast('已添加「'+name+'」','ok');
  }catch(e){toast(e.message,'err')}
}
async function memberDel(id){
  const m=S.members.find(x=>x.id===id);if(!m)return;
  if(!confirm('删除成员「'+m.name+'」？要求其名下没有任务。'))return;
  try{
    const r=await api('/members/'+id,{method:'DELETE'});
    S=r.state;render();renderMemberList();
    toast('已删除','ok');
  }catch(e){toast(e.message,'err')}
}

/* ============ Reminders ============ */
function getReminders(){
  const out=[];
  const now=new Date(Date.now()+serverTimeOffset);
  const dow=now.getDay(),hour=now.getHours();
  const dismissed=(S.dismissed&&S.dismissed[me.id])||{};
  if(dow===0&&hour>=20){
    const key='sun-'+now.toISOString().slice(0,10);
    if(!dismissed[key]){
      const myTasks=S.tasks.filter(t=>t.assigneeId===me.id&&t.status!=='done');
      out.push({id:key,type:'warn',icon:'📢',title:'周日 20:00 · 全员进度更新',body:'请更新你负责的所有任务进度（共 <strong>'+myTasks.length+'</strong> 项）。已完成的任务需要上传交付文件后由管理员验收。'});
    }
  }
  const myTasks=S.tasks.filter(t=>t.assigneeId===me.id&&t.status!=='done');
  myTasks.forEach(t=>{
    const d=days(t.ddl);
    if(d===1){const key='ddl1-'+t.id;if(!dismissed[key])out.push({id:key,type:'err',icon:'⏰',title:'明天到期：'+esc(t.title),body:'你负责的任务将于 <strong>明天（'+fmtD(t.ddl)+'）</strong> 到期，当前状态「'+STATUS[t.status]+'」。',taskId:t.id})}
    else if(d===0){const key='ddl0-'+t.id;if(!dismissed[key])out.push({id:key,type:'err',icon:'🔥',title:'今天到期：'+esc(t.title),body:'任务今天到期，当前状态「'+STATUS[t.status]+'」。',taskId:t.id})}
    else if(d<0){const key='od-'+t.id;if(!dismissed[key])out.push({id:key,type:'err',icon:'⚠️',title:'已逾期 '+(-d)+' 天：'+esc(t.title),body:'请立即处理或与组长沟通调整。',taskId:t.id})}
  });
  if(isAdmin()){
    const pending=S.tasks.filter(t=>t.status==='review');
    if(pending.length){
      const key='admin-review-'+pending.map(t=>t.id).join(',');
      if(!dismissed[key])out.push({id:key,type:'info',icon:'📋',title:'待你审核：'+pending.length+' 个任务',body:pending.map(t=>'<strong>'+esc(t.title)+'</strong>（'+esc((getMember(t.assigneeId)||{}).name||'?')+'）').join('、')+' — 请验收附件后决定通过或返工。'});
    }
    const pr=S.reviews.filter(r=>r.resolution==='pending');
    if(pr.length){const key='admin-rev-'+pr.length;if(!dismissed[key])out.push({id:key,type:'warn',icon:'✎',title:'待你处理：'+pr.length+' 条审议意见',body:'请在「审议意见」栏目标注采纳/不采纳。'})}
  }
  return out;
}
async function dismissRem(id){
  try{await api('/reminders/dismiss',{method:'POST',body:{key:id}});if(!S.dismissed[me.id])S.dismissed[me.id]={};S.dismissed[me.id][id]=Date.now();render()}
  catch(e){toast(e.message,'err')}
}
function renderReminders(){
  const rems=getReminders();
  const nb=$('#nb-rem');
  if(rems.length){nb.style.display='';nb.textContent=rems.length;nb.className='nav-badge alert'}else{nb.style.display='none'}
  if(!rems.length)return '';
  return '<div class="reminders">'+rems.map(r=>
    '<div class="reminder '+r.type+'"><span class="reminder-icon">'+r.icon+'</span>'+
    '<div class="reminder-body"><strong>'+r.title+'</strong><br/>'+r.body+(r.taskId?' <a href="#" onclick="event.preventDefault();openTask(\''+r.taskId+'\')" style="color:inherit;text-decoration:underline;font-weight:600">查看任务 →</a>':'')+'</div>'+
    '<span class="reminder-dismiss" onclick="dismissRem(\''+r.id+'\')">知道了</span></div>').join('')+'</div>';
}

/* ============ Permissions ============ */
function canEdit(t){if(isAdmin())return true;return t.assigneeId===me.id}
function canChangeStatusTo(t,to){
  if(to===t.status)return{ok:false,reason:'已经是该状态'};
  if(to==='unclaimed')return{ok:false,reason:'任务不能被退回待认领'};
  if(to==='doing'){
    if(t.status==='unclaimed')return{ok:true};
    if(t.status==='rework'&&t.assigneeId===me.id)return{ok:true};
    if(isAdmin())return{ok:true};
    return{ok:false,reason:'仅本人或管理员可以调整'};
  }
  if(to==='review'){
    if(!isAdmin()&&t.assigneeId!==me.id)return{ok:false,reason:'仅负责人本人可以提交审核'};
    if(!t.attachments||!t.attachments.length){
      const hasDoc=t.doc&&t.doc.versions&&t.doc.versions.length>0;
      if(!hasDoc)return{ok:false,reason:'规则要求：需先上传附件或完成交付文档'};
    }
    return{ok:true};
  }
  if(to==='rework')return can('markRework')?{ok:true}:{ok:false,reason:'你没有标记返工的权限'};
  if(to==='done')return can('markDone')?{ok:true}:{ok:false,reason:'你没有验收的权限'};
  return{ok:false,reason:'未知状态'};
}

/* ============ Render ============ */
function render(){
  if(!S||!me)return;
  const sel=$('#who-sel');sel.className='who-sel'+(isAdmin()?' admin':'');
  $('#role-tag').className='role-tag '+(isAdmin()?'role-admin':'role-member');
  $('#role-tag').textContent=isAdmin()?(CFG.adminLabel||'管理员'):'普通成员';
  $('#nb-task').textContent=S.tasks.filter(t=>t.status!=='done').length;
  $('#nb-res').textContent=S.resources.length;
  $('#nb-ann').textContent=S.announcements.length;
  $('#nb-lit').textContent=(S.literatures||[]).length;
  const pr=S.reviews.filter(r=>r.resolution==='pending').length;
  $('#nb-rev').textContent=pr;
  $('#nb-rev').className='nav-badge'+(pr?' alert':'');
  renderView();
}
function go(v){
  view=v;
  $$('.nav-btn').forEach(b=>b.classList.toggle('on',b.dataset.v===v));
  $$('.view').forEach(e=>e.classList.remove('on'));
  /* 页面标题也跟随 modules 配置的名称 */
  const titles={dash:[modName('dash','总览'),'项目状态、你的任务、待办提醒'],tasks:[modName('tasks','任务看板'),'按 5 种状态管理所有任务'],resources:[modName('resources','资料库'),'上传与分类管理文件'],announcements:[modName('announcements','公告区'),'会议通知、阶段目标、重要事项'],lits:[modName('lits','文献汇总'),'组员提交的文献清单与共同审稿'],reviews:[modName('reviews','审议意见'),'对任务的建议与管理员处理结果'],help:[modName('help','使用说明'),'操作指引与常见问题'],'task-detail':['任务详情','']};
  const pair=titles[v]||['',''];
  $('#pg-title').textContent=pair[0];$('#pg-sub').textContent=pair[1];
  $('#v-'+v).classList.add('on');
  renderView();
}
function renderView(){
  const rems=renderReminders();
  if(view==='dash')$('#v-dash').innerHTML=rems+rDash();
  else if(view==='tasks')$('#v-tasks').innerHTML=rems+rTasks();
  else if(view==='resources')$('#v-resources').innerHTML=rems+rRes();
  else if(view==='announcements')$('#v-announcements').innerHTML=rems+rAnn();
  else if(view==='lits')$('#v-lits').innerHTML=rems+rLit();
  else if(view==='reviews')$('#v-reviews').innerHTML=rems+rRev();
  else if(view==='help')$('#v-help').innerHTML='<div class="card" style="padding:8px 28px 28px"><div class="md-body" style="max-height:none;padding:18px 4px">'+renderMd(HELP_MD)+'</div></div>';
  else if(view==='task-detail'){$('#v-task-detail').innerHTML=rTaskDetail();if(taskTab==='doc')updDocPrev();}
}
$$('.nav-btn').forEach(b=>b.onclick=()=>go(b.dataset.v));

function rDash(){
  const my=S.tasks.filter(t=>t.assigneeId===me.id);
  const myOpen=my.filter(t=>t.status!=='done');
  const myReview=my.filter(t=>t.status==='review');
  const myRework=my.filter(t=>t.status==='rework');
  const overdue=S.tasks.filter(t=>t.status!=='done'&&t.ddl&&days(t.ddl)<0);
  const unclaimed=S.tasks.filter(t=>t.status==='unclaimed');
  const adminPending=isAdmin()?S.tasks.filter(t=>t.status==='review'):[];
  const revPending=S.reviews.filter(r=>r.resolution==='pending');

  let html='<div class="stats">'+
    '<div class="card stat"><div class="stat-l">我的进行中</div><div class="stat-n">'+myOpen.filter(t=>t.status==='doing').length+'</div><div class="stat-d">共'+my.length+'项分配给我</div></div>'+
    '<div class="card stat w"><div class="stat-l">我的待审核</div><div class="stat-n">'+myReview.length+'</div><div class="stat-d">已提交等待验收</div></div>'+
    (myRework.length?'<div class="card stat e"><div class="stat-l">我的需返工</div><div class="stat-n">'+myRework.length+'</div><div class="stat-d">查看评论区意见</div></div>':'')+
    '<div class="card stat i"><div class="stat-l">待认领任务</div><div class="stat-n">'+unclaimed.length+'</div><div class="stat-d">'+(unclaimed.length?'去任务看板认领':'全部分配完毕')+'</div></div>'+
    (isAdmin()?'<div class="card stat g"><div class="stat-l">待你审核</div><div class="stat-n">'+adminPending.length+'</div><div class="stat-d">需验收附件后决定</div></div>':'')+
    '<div class="card stat '+(overdue.length?'e':'g')+'"><div class="stat-l">全组逾期</div><div class="stat-n">'+overdue.length+'</div><div class="stat-d">'+(overdue.length?'需要立即处理':'节奏良好')+'</div></div>'+
  '</div>';

  html+='<div class="dash-cols"><div class="card"><div class="card-h"><span>✎</span>我的任务<button class="btn btn-g btn-sm" style="margin-left:auto" onclick="go(\'tasks\')">全部→</button></div><div class="card-b" style="padding:6px 15px;max-height:340px;overflow-y:auto">';
  const mySorted=myOpen.slice().sort((a,b)=>(a.ddl||'9999').localeCompare(b.ddl||'9999'));
  if(mySorted.length){
    mySorted.forEach(t=>{
      const d=days(t.ddl);const cls=d<0?'urg':d<=2?'soon':'';
      html+='<div class="dash-list-item" onclick="openTask(\''+t.id+'\')">'+
        '<span class="st st-'+t.status+'">'+STATUS[t.status]+'</span>'+
        '<div style="flex:1;min-width:0"><div style="font-weight:600;color:var(--txt)">'+esc(t.title)+'</div>'+
        '<div style="font-size:10.5px;color:var(--mut);margin-top:2px"><span class="tcard-line line-tag-'+t.line+'">'+esc(lineName(t.line))+'</span> · DDL '+fmtD(t.ddl)+' <span class="ddl-tag '+cls+'" style="margin-left:4px">'+(d<0?'逾期'+(-d)+'天':d===0?'今天':d+'天后')+'</span>'+(t.attachments.length?' · 📎'+t.attachments.length:'')+'</div></div>'+
      '</div>';
    });
  }else{html+='<div class="empty" style="padding:24px">你没有进行中的任务<br/><span style="font-size:11px">去任务看板认领一个吧</span></div>'}
  html+='</div></div><div style="display:flex;flex-direction:column;gap:12px">';

  html+='<div class="card"><div class="card-h"><span>◎</span>待认领任务<span style="margin-left:auto;font-size:11px;color:var(--mut);font-weight:400">'+unclaimed.length+' 项</span></div><div class="card-b" style="padding:6px 15px;max-height:180px;overflow-y:auto">';
  if(unclaimed.length){
    unclaimed.slice(0,5).forEach(t=>{
      html+='<div class="dash-list-item" onclick="openTask(\''+t.id+'\')">'+
        '<span class="tcard-line line-tag-'+t.line+'">'+esc(lineName(t.line))+'</span>'+
        '<div style="flex:1;min-width:0"><div style="font-weight:500">'+esc(t.title)+'</div><div style="font-size:10.5px;color:var(--mut);margin-top:1px">DDL '+fmtD(t.ddl)+'</div></div>'+
        '<button class="btn btn-p btn-xs" onclick="event.stopPropagation();claimTask(\''+t.id+'\')">认领</button></div>';
    });
  }else{html+='<div class="empty" style="padding:16px;font-size:11px">全部任务已分配</div>'}
  html+='</div></div>';

  html+='<div class="card"><div class="card-h"><span>✎</span>待处理审议<span style="margin-left:auto;font-size:11px;color:var(--mut);font-weight:400">'+revPending.length+' 条</span></div><div class="card-b" style="padding:6px 15px;max-height:180px;overflow-y:auto">';
  if(revPending.length){
    revPending.slice(0,4).forEach(r=>{
      const t=S.tasks.find(x=>x.id===r.taskId);
      html+='<div class="dash-list-item" onclick="go(\'reviews\')"><div style="flex:1;min-width:0"><div style="font-weight:500">'+esc(r.authorName)+' → '+esc(t?t.title:'?')+'</div><div style="font-size:10.5px;color:var(--mut);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(r.content.slice(0,50))+(r.content.length>50?'...':'')+'</div></div></div>';
    });
  }else{html+='<div class="empty" style="padding:16px;font-size:11px">暂无待处理意见</div>'}
  html+='</div></div></div></div>';

  const recentAnn=S.announcements.slice().sort((a,b)=>((b.pinned?1:0)-(a.pinned?1:0))||(b.ts-a.ts)).slice(0,2);
  if(recentAnn.length){
    html+='<div class="card" style="margin-top:14px"><div class="card-h"><span>◇</span>最新公告<button class="btn btn-g btn-sm" style="margin-left:auto" onclick="go(\'announcements\')">全部→</button></div><div class="card-b" style="padding:8px 15px">';
    recentAnn.forEach(a=>{
      html+='<div class="dash-list-item" onclick="go(\'announcements\')">'+(a.pinned?'<span style="color:var(--acc)">📌</span>':'')+'<div style="flex:1;min-width:0"><div style="font-weight:600">'+esc(a.title)+'</div><div style="font-size:11px;color:var(--mut);margin-top:2px">'+esc(a.authorName)+' · '+ago(a.ts)+'</div></div></div>';
    });
    html+='</div></div>';
  }
  return html;
}

function rTasks(){
  let list=S.tasks.slice();
  if(taskF.line!=='all')list=list.filter(t=>t.line===taskF.line);
  if(taskF.who==='me')list=list.filter(t=>t.assigneeId===me.id);
  else if(taskF.who==='unassigned')list=list.filter(t=>!t.assigneeId);
  else if(taskF.who!=='all')list=list.filter(t=>t.assigneeId===taskF.who);

  let html='<div class="board-toolbar">';
  if(can('createTask'))html+='<button class="btn btn-p btn-sm" onclick="openTaskEdit()">+ 新建任务</button>';
  html+='<span style="font-size:11px;color:var(--mut);margin-left:6px">分类</span>';
  ['all'].concat(LINE_KEYS).forEach(f=>{html+='<button class="filter-chip '+(taskF.line===f?'on':'')+'" onclick="taskF.line=\''+f+'\';render()">'+(f==='all'?'全部':esc(lineName(f)))+'</button>'});
  html+='<span style="font-size:11px;color:var(--mut);margin-left:12px">人</span>';
  html+='<button class="filter-chip '+(taskF.who==='all'?'on':'')+'" onclick="taskF.who=\'all\';render()">全部</button>';
  html+='<button class="filter-chip '+(taskF.who==='me'?'on':'')+'" onclick="taskF.who=\'me\';render()">我的</button>';
  html+='<button class="filter-chip '+(taskF.who==='unassigned'?'on':'')+'" onclick="taskF.who=\'unassigned\';render()">未分配</button>';
  S.members.forEach(m=>{html+='<button class="filter-chip '+(taskF.who===m.id?'on':'')+'" onclick="taskF.who=\''+m.id+'\';render()">'+esc(m.name)+'</button>'});
  html+='</div><div class="kanban">';
  ['unclaimed','doing','review','rework','done'].forEach(sk=>{
    const items=list.filter(t=>t.status===sk).sort((a,b)=>a.line===b.line?a.order-b.order:(LINE_KEYS.indexOf(a.line)-LINE_KEYS.indexOf(b.line)));
    html+='<div class="kcol s-'+sk+'"><div class="kcol-h"><span>'+STATUS[sk]+'</span><span class="kcol-n">'+items.length+'</span></div>';
    items.forEach(t=>{
      const d=days(t.ddl);const od=t.status!=='done'&&d<0;const cls=d<0?'urg':d<=2?'soon':'';
      const a=getMember(t.assigneeId);
      html+='<div class="tcard line-'+t.line+' '+(od?'overdue':'')+'" onclick="openTask(\''+t.id+'\')">'+
        (t.attachments.length?'<span class="tcard-attach">📎'+t.attachments.length+'</span>':'')+
        '<div class="tcard-t">'+esc(t.title)+'</div>'+
        '<div class="tcard-m"><span class="tcard-line line-tag-'+t.line+'">'+esc(lineName(t.line))+'</span>'+(t.ddl?'<span class="ddl-tag '+cls+'">'+(od?'逾期'+(-d)+'天':fmtD(t.ddl))+'</span>':'')+'</div>'+
        '<div class="tcard-who">'+(a?'<span class="avatar '+(a.isAdmin?'admin':'')+'" style="width:18px;height:18px;font-size:9px">'+esc(a.name[0])+'</span><span>'+esc(a.name)+'</span>':'<span style="color:var(--mut)">未分配</span>')+(t.comments.length?'<span style="margin-left:auto;color:var(--mut)">💬'+t.comments.length+'</span>':'')+'</div>'+
      '</div>';
    });
    if(!items.length)html+='<div class="empty" style="padding:14px 6px;font-size:11px">暂无</div>';
    html+='</div>';
  });
  html+='</div><div class="hint" style="margin-top:14px"><strong>状态流转规则：</strong>待认领 → 任何人可认领（成为负责人）→ 进行中 → 负责人上传附件或完成交付文档后可提交「待审核」→ 管理员验收：通过则「已完成」，否则「需返工」（需写明意见）→ 负责人修改后重新提交。</div>';
  return html;
}

async function claimTask(id){
  try{const r=await api('/tasks/'+id+'/claim',{method:'POST'});const idx=S.tasks.findIndex(t=>t.id===id);if(idx>=0)S.tasks[idx]=r.task;render();toast('已认领','ok')}
  catch(e){toast(e.message,'err')}
}

function openTask(id){curTask=id;taskTab='info';docEditMode=false;docViewVer=null;docQuote='';go('task-detail')}
function rTaskDetail(){
  const t=S.tasks.find(x=>x.id===curTask);
  if(!t)return '<div class="empty">任务不存在<br/><button class="btn btn-s btn-sm" style="margin-top:10px" onclick="go(\'tasks\')">返回看板</button></div>';
  const a=getMember(t.assigneeId);
  const d=days(t.ddl);
  const canE=canEdit(t);

  let html='<button class="btn btn-g btn-sm" onclick="go(\'tasks\')" style="margin-bottom:10px">← 返回看板</button>';
  html+='<div class="card" style="padding:16px 20px;margin-bottom:12px"><div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:10px"><div style="flex:1"><h2 style="font-size:17px;font-weight:600;line-height:1.4">'+esc(t.title)+'</h2><div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="tcard-line line-tag-'+t.line+'">'+esc(lineName(t.line))+'</span><span class="st st-'+t.status+'">'+STATUS[t.status]+'</span>';
  if(t.ddl){const cls=d<0?'urg':d<=2?'soon':'';html+='<span class="ddl-tag '+cls+'">DDL '+fmtD(t.ddl)+' · '+(d<0?'逾期'+(-d)+'天':d===0?'今天到期':d+'天后')+'</span>'}
  html+='</div></div>';
  if(canE)html+='<button class="btn btn-s btn-sm" onclick="openTaskEdit(\''+t.id+'\')">✎ 编辑</button>';
  if(can('deleteTask'))html+='<button class="btn btn-d btn-sm" onclick="editTask=\''+t.id+'\';delTask()">删除</button>';
  html+='</div>';
  if(t.desc)html+='<div style="padding:10px 12px;background:var(--bg);border-radius:var(--rs);font-size:12.5px;line-height:1.65;color:var(--txt2);white-space:pre-wrap;margin-bottom:12px">'+esc(t.desc)+'</div>';

  const docVerN=(t.doc&&t.doc.versions.length)?' · v'+t.doc.versions[t.doc.versions.length-1].num:'';
  html+='<div class="dtabs">'+
    '<div class="dtab '+(taskTab==='info'?'on':'')+'" onclick="taskTab=\'info\';render()">☰ 任务详情</div>'+
    '<div class="dtab '+(taskTab==='doc'?'on':'')+'" onclick="taskTab=\'doc\';docEditMode=false;docViewVer=null;render()">📄 交付文档'+docVerN+'</div>'+
  '</div>';
  if(taskTab==='doc'){html+=rTaskDoc(t);return html}

  html+='<div class="td-grid"><div><div class="td-section"><div class="td-section-h">◈ 状态流转</div><div class="status-flow">';
  ['unclaimed','doing','review','rework','done'].forEach(s=>{
    if(s===t.status){html+='<span class="status-btn current">✓ '+STATUS[s]+'（当前）</span>';return}
    if(s==='unclaimed')return;
    const chk=canChangeStatusTo(t,s);
    const clsMap={doing:'to-doing',review:'to-review',rework:'to-rework',done:'to-done'};
    html+='<button class="status-btn '+clsMap[s]+'" '+(chk.ok?'':'disabled title="'+esc(chk.reason)+'"')+' onclick="changeStatus(\''+t.id+'\',\''+s+'\')">→ '+STATUS[s]+(chk.ok?'':' 🔒')+'</button>';
  });
  html+='</div>';
  const reasons=[];
  ['doing','review','rework','done'].forEach(s=>{
    if(s===t.status)return;
    const chk=canChangeStatusTo(t,s);
    if(!chk.ok&&chk.reason!=='已经是该状态'&&chk.reason!=='未知状态'&&chk.reason!=='任务不能被退回待认领')reasons.push('<strong>'+STATUS[s]+'</strong>：'+chk.reason);
  });
  if(reasons.length)html+='<div class="hint" style="margin-top:6px"><strong>权限说明：</strong><br/>'+reasons.join('<br/>')+'</div>';
  html+='</div>';

  html+='<div class="td-section"><div class="td-section-h">📎 交付附件（'+t.attachments.length+'）';
  if(t.status!=='done')html+='<span style="margin-left:auto;font-weight:400;text-transform:none;letter-spacing:0;color:var(--mut);font-size:10.5px">'+((t.assigneeId===me.id||isAdmin())?'负责人/管理员可上传':'仅负责人可上传')+'</span>';
  html+='</div>';
  if((t.assigneeId===me.id||isAdmin())&&t.status!=='done')html+='<div class="attach-drop" onclick="triggerUpload(\''+t.id+'\')">点击或拖拽文件到此处上传<br/><span style="font-size:10.5px">单个文件限 6MB 以内</span></div>';
  if(t.attachments.length){
    html+='<div class="attach-list">'+t.attachments.map(at=>
      '<div class="attach-item"><span>📄</span><span class="attach-name">'+esc(at.name)+'</span><span class="attach-size">'+fmtSize(at.size)+'</span><span style="color:var(--mut);font-size:10.5px">'+esc(at.uploadedByName)+' · '+ago(at.uploadedAt)+'</span>'+
      '<span class="attach-actions">'+(at.dataUrl?'<button class="btn btn-ghost btn-xs" onclick="downloadAtt(\''+at.dataUrl.replace(/'/g,"\\'")+'\',\''+esc(at.name).replace(/'/g,"\\'")+'\')">下载</button>':'<span class="tag">示例</span>')+
      ((isAdmin()||at.uploadedBy===me.id)?'<button class="btn btn-ghost btn-xs" style="color:var(--err)" onclick="delAtt(\''+t.id+'\',\''+at.id+'\')">删</button>':'')+'</span></div>').join('')+'</div>';
  }
  html+='</div>';

  html+='<div class="td-section"><div class="td-section-h">💬 评论区（'+t.comments.length+'）<span style="margin-left:auto;font-weight:400;text-transform:none;letter-spacing:0;color:var(--mut);font-size:10.5px">'+((isAdmin()||t.assigneeId===me.id)?'负责人与管理员可发言':'只读 · 意见请走审议意见')+'</span></div><div class="comment-list">';
  if(t.comments.length){
    t.comments.slice().sort((a,b)=>a.ts-b.ts).forEach(c=>{
      const canDelC=isAdmin()||c.authorId===me.id;
      html+='<div class="comment '+(c.type==='rework'?'rework':'')+'"><div class="comment-h"><span class="comment-who">'+esc(c.authorName)+'</span>'+(c.type==='rework'?'<span class="comment-tag">返工意见</span>':'')+(c.type==='system'?'<span class="tag">系统</span>':'')+'<span class="comment-time">'+fmtFull(c.ts)+'</span>'+(canDelC?'<button class="btn btn-ghost btn-xs" style="color:var(--err)" onclick="delComment(\''+t.id+'\',\''+c.id+'\')">删</button>':'')+'</div><div class="comment-body">'+esc(c.content)+'</div></div>';
    });
  }else{html+='<div class="empty" style="padding:14px;font-size:11px">还没有评论</div>'}
  html+='</div>';
  if(isAdmin()||t.assigneeId===me.id){
    html+='<div class="comment-input"><textarea id="cm-in" placeholder="写下你的问题、进度或说明..."></textarea><button class="btn btn-p btn-sm" onclick="addComment(\''+t.id+'\')">发送</button></div>';
  }else{
    html+='<div class="hint">评论区是该任务的工作记录，仅<strong>负责人</strong>与<strong>管理员</strong>可发言。你对这个任务有意见或建议，请点右侧「相关审议意见」里的「+ 对此任务提意见」，由管理员统一裁决。</div>';
  }
  html+='</div>';

  html+='</div><div><div class="td-section"><div class="td-section-h">◉ 任务信息</div><div class="td-info">'+
    '<div class="td-info-item"><span class="td-info-l">负责人</span><span class="td-info-v">'+(a?esc(a.name)+(a.isAdmin?' ★':''):'<span style="color:var(--mut)">未分配</span>')+'</span></div>'+
    '<div class="td-info-item"><span class="td-info-l">任务分类</span><span class="td-info-v">'+esc(lineName(t.line))+'</span></div>'+
    '<div class="td-info-item"><span class="td-info-l">截止日期</span><span class="td-info-v">'+(t.ddl?fmtD(t.ddl):'未设置')+'</span></div>'+
    '<div class="td-info-item"><span class="td-info-l">顺序</span><span class="td-info-v">第 '+t.order+' 步</span></div>'+
    '<div class="td-info-item"><span class="td-info-l">创建时间</span><span class="td-info-v">'+ago(t.createdAt)+'</span></div>'+
    '<div class="td-info-item"><span class="td-info-l">最近更新</span><span class="td-info-v">'+ago(t.updatedAt)+'</span></div>'+
  '</div></div>';
  if(!a&&t.status==='unclaimed')html+='<div class="td-section"><button class="btn btn-p" style="width:100%;justify-content:center;padding:10px" onclick="claimTask(\''+t.id+'\')">🙋 认领此任务</button><div class="hint" style="margin-top:6px">认领后你将成为负责人，可以上传附件并提交审核。</div></div>';

  html+='<div class="td-section"><div class="td-section-h">✎ 相关审议意见</div>';
  const relRev=S.reviews.filter(r=>r.taskId===t.id);
  if(relRev.length){
    relRev.forEach(r=>{html+='<div style="padding:8px 10px;background:var(--bg);border-radius:var(--rs);margin-bottom:5px;font-size:11.5px"><div style="display:flex;gap:5px;align-items:center;margin-bottom:3px"><strong>'+esc(r.authorName)+'</strong><span class="rev-resolution res-'+r.resolution+'">'+({pending:'待处理',accepted:'已采纳',rejected:'不采纳'})[r.resolution]+'</span></div><div style="color:var(--txt2);line-height:1.5">'+esc(r.content.slice(0,80))+(r.content.length>80?'...':'')+'</div></div>'});
  }else{html+='<div style="font-size:11px;color:var(--mut);padding:6px 0">暂无</div>'}
  html+='<button class="btn btn-s btn-sm" style="margin-top:6px;width:100%;justify-content:center" onclick="openRevModal(\''+t.id+'\')">+ 对此任务提意见</button></div></div></div></div>';
  return html;
}

async function changeStatus(id,to){
  const t=S.tasks.find(x=>x.id===id);if(!t)return;
  const chk=canChangeStatusTo(t,to);
  if(!chk.ok){toast(chk.reason,'w');return}
  if(to==='rework'){openReworkModal(id);return}
  if(to==='done'){
    if(!t.attachments.length){if(!confirm('此任务尚无附件，仍要标记为已完成吗？'))return}
    if(!confirm('确认验收通过，标记为「已完成」？'))return;
  }
  try{
    const r=await api('/tasks/'+id+'/status',{method:'POST',body:{status:to}});
    const idx=S.tasks.findIndex(t=>t.id===id);if(idx>=0)S.tasks[idx]=r.task;
    render();toast('状态已更新为「'+STATUS[to]+'」','ok');
  }catch(e){toast(e.message,'err')}
}
function openReworkModal(id){editTask=id;$('#rw-body').value='';openM('m-rework');setTimeout(()=>$('#rw-body').focus(),50)}
async function confirmRework(){
  const body=$('#rw-body').value.trim();
  if(!body){toast('返工意见必填','w');return}
  try{
    const r=await api('/tasks/'+editTask+'/status',{method:'POST',body:{status:'rework',note:body}});
    const idx=S.tasks.findIndex(t=>t.id===editTask);if(idx>=0)S.tasks[idx]=r.task;
    closeM('m-rework');render();toast('已标记为需返工','ok');
  }catch(e){toast(e.message,'err')}
}
async function addComment(id){
  const t=S.tasks.find(x=>x.id===id);if(!t)return;
  if(!isAdmin()&&t.assigneeId!==me.id){toast('评论区仅负责人与管理员可发言，意见请走审议意见','err');return}
  const inp=$('#cm-in');const c=inp.value.trim();if(!c){toast('写点什么吧','w');return}
  try{
    const r=await api('/tasks/'+id+'/comments',{method:'POST',body:{content:c}});
    const idx=S.tasks.findIndex(t=>t.id===id);if(idx>=0)S.tasks[idx]=r.task;
    inp.value='';render();toast('已发送','ok');
  }catch(e){toast(e.message,'err')}
}
async function delComment(taskId,cid){
  if(!confirm('删除这条评论？'))return;
  try{
    const r=await api('/tasks/'+taskId+'/comments/'+cid,{method:'DELETE'});
    const idx=S.tasks.findIndex(t=>t.id===taskId);if(idx>=0)S.tasks[idx]=r.task;
    render();toast('已删除','ok');
  }catch(e){toast(e.message,'err')}
}

/* ============ 交付文档模块 ============ */
function rTaskDoc(t){
  if(!t.doc)t.doc={versions:[],comments:[]};
  const doc=t.doc;
  const canEditDoc=isAdmin()||t.assigneeId===me.id;
  const latest=doc.versions[doc.versions.length-1];
  let html='<div class="docview"><div class="card" style="overflow:hidden"><div class="doc-toolbar">';
  if(docViewVer){
    const v=doc.versions.find(x=>x.id===docViewVer);
    html+='<span style="font-size:12px;font-weight:600;color:var(--sec)">🕚 正在查看 v'+v.num+'（历史版本，只读）</span><span style="margin-left:auto"></span><button class="btn btn-s btn-sm" onclick="docViewVer=null;render()">↩ 返回当前版本</button>';
  }else if(canEditDoc&&docEditMode){
    html+='<span style="font-size:12px;font-weight:600;color:var(--pri)">✎ 编辑交付文档</span><span style="margin-left:auto;font-size:10.5px;color:var(--mut)">Markdown 语法 · 保存后生成新版本</span><button class="btn btn-s btn-sm" onclick="docEditMode=false;render()">取消编辑</button>';
  }else{
    html+='<span style="font-size:12px;font-weight:600;color:var(--txt2)">📄 交付文档'+(latest?' · 当前 v'+latest.num+' · '+esc(latest.editorName)+' 更新于 '+ago(latest.ts):' · 暂未创建')+'</span><span style="margin-left:auto"></span>';
    if(latest)html+='<button class="btn btn-s btn-sm" onclick="captureQuote()">💬 引用选中文字提意见</button>';
    if(canEditDoc)html+='<button class="btn btn-p btn-sm" onclick="docEditMode=true;render()">'+(latest?'✎ 编辑':'✎ 开始撰写')+'</button>';
  }
  html+='</div>';
  if(docViewVer){
    const v=doc.versions.find(x=>x.id===docViewVer);
    html+='<div class="md-body">'+renderMd(v.content)+'</div>';
  }else if(canEditDoc&&docEditMode){
    html+='<textarea class="doc-edit-input" id="doc-edit" oninput="updDocPrev()">'+esc(latest?latest.content:'')+'</textarea>';
    html+='<div class="md-body" id="doc-prev" style="border-top:1px solid var(--border-s);max-height:36vh"></div>';
    html+='<div style="padding:8px 14px;background:#FAF6F0;border-top:1px solid var(--border-s);display:flex;gap:8px;align-items:center"><input id="doc-note" placeholder="本次修改说明（选填，写入版本历史）" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:var(--rs);background:var(--card);outline:none;font-size:12px"/><button class="btn btn-p btn-sm" onclick="saveDocVer(\''+t.id+'\')">💾 保存为新版本</button></div>';
  }else if(latest){
    html+='<div class="md-body">'+renderMd(latest.content)+'</div>';
  }else{
    html+='<div class="empty" style="padding:56px 20px"><div class="empty-icon">📄</div>还没有交付文档<br/><span style="font-size:11px">'+(canEditDoc?'点击右上「✎ 开始撰写」创建':'负责人撰写后即可在此阅读和提意见')+'</span></div>';
  }
  if(doc.versions.length){
    html+='<div style="border-top:1px solid var(--border-s);padding:10px 14px;max-height:150px;overflow-y:auto"><div style="font-size:10px;color:var(--mut);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">版本历史（'+doc.versions.length+'）</div>';
    doc.versions.slice().reverse().forEach(v=>{
      html+='<div style="display:flex;gap:8px;align-items:center;font-size:11px;padding:4px 0;border-bottom:1px dashed var(--border-s)"><span class="tag tag-p">v'+v.num+'</span><strong>'+esc(v.editorName)+'</strong><span style="color:var(--txt2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">'+esc(v.note||'')+'</span><span style="color:var(--mut);flex-shrink:0">'+ago(v.ts)+'</span>'+(docViewVer!==v.id?'<button class="btn btn-ghost btn-xs" onclick="docViewVer=\''+v.id+'\';render()">查看</button>':'<span class="tag tag-ok">查看中</span>')+'</div>';
    });
    html+='</div>';
  }
  html+='</div>';
  const openC=doc.comments.filter(c=>!c.resolved).length;
  html+='<div class="card" style="position:sticky;top:0"><div class="card-h"><span>💬</span>文档意见<span style="margin-left:auto;font-size:11px;color:var(--mut);font-weight:400">'+openC+' 条待处理 / 共 '+doc.comments.length+'</span></div><div style="max-height:380px;overflow-y:auto">';
  if(doc.comments.length){
    doc.comments.slice().sort((a,b)=>b.ts-a.ts).forEach(c=>{
      html+='<div style="padding:10px 14px;border-bottom:1px solid var(--border-s);font-size:12px;'+(c.resolved?'opacity:.5;':'')+'">'+
        '<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px"><span class="avatar" style="width:20px;height:20px;font-size:10px'+(isAdminById(c.authorId)?';background:linear-gradient(135deg,var(--acc),#E0B361)':'')+'">'+esc(c.authorName[0])+'</span><strong style="font-size:11.5px">'+esc(c.authorName)+'</strong>'+(c.resolved?'<span class="tag tag-ok">已处理</span>':'')+'<span style="margin-left:auto;color:var(--mut);font-size:10px">'+ago(c.ts)+'</span></div>'+
        (c.quote?'<div class="dcomment-quote">「'+esc(c.quote)+'」</div>':'')+
        '<div style="color:var(--txt2);line-height:1.55;white-space:pre-wrap">'+esc(c.content)+'</div>'+
        '<div style="margin-top:5px;display:flex;gap:8px">'+(isAdmin()?'<span class="comment-action" onclick="resolveDocComment(\''+t.id+'\',\''+c.id+'\')">'+(c.resolved?'↺ 重新打开':'✓ 标记已处理')+'</span>':'')+((isAdmin()||c.authorId===me.id)?'<span class="comment-action" style="color:var(--err)" onclick="delDocComment(\''+t.id+'\',\''+c.id+'\')">删</span>':'')+'</div>'+
      '</div>';
    });
  }else{
    html+='<div class="empty" style="padding:24px;font-size:11px">还没有意见<br/><span style="font-size:10px;color:var(--mut)">选中左侧文档里的一段文字<br/>再点上方「引用选中文字提意见」<br/>就能精确指出问题位置</span></div>';
  }
  html+='</div><div style="padding:10px 14px;border-top:1px solid var(--border-s);background:#FAF6F0">';
  if(docQuote)html+='<div class="quote-chip">💬 <span class="q">'+esc(docQuote)+'</span><span style="cursor:pointer;font-weight:700" onclick="docQuote=\'\';render()">✕</span></div>';
  html+='<textarea id="dcm-in" placeholder="写下你对这份文档的意见或问题..." style="width:100%;padding:7px 10px;border:1.5px solid var(--border);border-radius:var(--rs);background:var(--card);outline:none;font-size:12px;resize:vertical;min-height:56px;font-family:inherit"></textarea><div style="display:flex;justify-content:flex-end;margin-top:6px"><button class="btn btn-p btn-sm" onclick="addDocComment(\''+t.id+'\')">提交意见</button></div></div></div></div>';
  return html;
}
function isAdminById(id){const m=getMember(id);return !!(m&&m.isAdmin)}
function updDocPrev(){
  const i=$('#doc-edit'),p=$('#doc-prev');
  if(!i||!p)return;
  try{p.innerHTML=(window.DOMPurify&&DOMPurify.sanitize)?DOMPurify.sanitize(marked.parse(i.value)):esc(i.value)}catch(e){p.textContent=i.value}
}
async function saveDocVer(id){
  const t=S.tasks.find(x=>x.id===id);if(!t)return;
  if(!isAdmin()&&t.assigneeId!==me.id){toast('仅负责人与管理员可编辑交付文档','err');return}
  const inp=$('#doc-edit'),note=$('#doc-note');
  const content=inp.value;
  if(!content.trim()){toast('文档内容为空','w');return}
  const latest=t.doc.versions[t.doc.versions.length-1];
  if(latest&&content===latest.content){toast('内容没有变化','w');return}
  try{
    const r=await api('/tasks/'+id+'/doc/versions',{method:'POST',body:{content,note:note.value.trim()}});
    const idx=S.tasks.findIndex(t=>t.id===id);if(idx>=0)S.tasks[idx]=r.task;
    docEditMode=false;docViewVer=null;
    render();toast('已保存为 v'+r.version.num,'ok');
  }catch(e){toast(e.message,'err')}
}
async function addDocComment(id){
  const t=S.tasks.find(x=>x.id===id);if(!t)return;
  const inp=$('#dcm-in');const c=inp.value.trim();
  if(!c){toast('写点什么吧','w');return}
  try{
    const r=await api('/tasks/'+id+'/doc/comments',{method:'POST',body:{quote:docQuote,content:c}});
    const idx=S.tasks.findIndex(t=>t.id===id);if(idx>=0)S.tasks[idx]=r.task;
    docQuote='';
    render();toast('意见已提交','ok');
  }catch(e){toast(e.message,'err')}
}
async function resolveDocComment(tid,cid){
  if(!can('resolveReview')){toast('你没有处理意见的权限','err');return}
  try{const r=await api('/tasks/'+tid+'/doc/comments/'+cid,{method:'PATCH'});const idx=S.tasks.findIndex(x=>x.id===tid);if(idx>=0)S.tasks[idx]=r.task;render()}
  catch(e){toast(e.message,'err')}
}
async function delDocComment(tid,cid){
  if(!confirm('删除这条意见？'))return;
  try{const r=await api('/tasks/'+tid+'/doc/comments/'+cid,{method:'DELETE'});const idx=S.tasks.findIndex(x=>x.id===tid);if(idx>=0)S.tasks[idx]=r.task;render();toast('已删除','ok')}
  catch(e){toast(e.message,'err')}
}
function captureQuote(){
  const sel=window.getSelection?String(window.getSelection()):'';
  const q=sel.trim();
  if(!q){toast('请先在左侧文档中选中一段文字，再点这个按钮','w');return}
  docQuote=q.slice(0,200);
  render();toast('已引用选中文字，写下意见后提交','ok');
}

/* ============ File Upload ============ */
function triggerUpload(taskId){uploadTarget={type:'task',id:taskId};$('#file-input').click()}
function triggerUploadRes(){uploadTarget={type:'res'};$('#file-input').click()}
$('#file-input').addEventListener('change',e=>{
  const files=[...e.target.files];
  files.forEach(f=>handleFile(f));
  e.target.value='';
});
/* ---- 资料上传弹窗（替代原 prompt 选分类）：多文件排队，逐个确认 ---- */
let _pendingUploads=[];
function nextUploadModal(){
  const f=_pendingUploads[0];
  if(!f){closeM('m-upload');return}
  $('#up-name').textContent=f.name+'（'+fmtSize(f.size)+'）';
  $('#up-cat').innerHTML=Object.keys(RES_CATS).map(k=>'<option value="'+k+'">'+esc(RES_CATS[k].name)+'</option>').join('');
  $('#up-desc').value='';
  openM('m-upload');
}
async function confirmUpload(){
  const f=_pendingUploads.shift();
  if(!f)return;
  try{
    const r=await api('/resources',{method:'POST',body:{name:f.name,size:f.size,type:f.type,cat:$('#up-cat').value,desc:$('#up-desc').value.trim(),dataUrl:f.dataUrl}});
    S.resources.push(r.resource);
    toast('资料已上传','ok');
    render();
  }catch(e){toast(e.message,'err')}
  nextUploadModal();   // 队列里还有文件就继续弹下一个
}
function cancelUpload(){_pendingUploads=[];closeM('m-upload');toast('已取消上传','w')}
function handleFile(file){
  if(!uploadTarget)return;
  if(file.size>6*1024*1024){toast('文件超过 6MB，无法上传（'+fmtSize(file.size)+'）','err');return}
  const reader=new FileReader();
  reader.onload=async ev=>{
    const dataUrl=ev.target.result;
    try{
      if(uploadTarget.type==='task'){
        const r=await api('/tasks/'+uploadTarget.id+'/attachments',{method:'POST',body:{name:file.name,size:file.size,type:file.type,dataUrl}});
        const idx=S.tasks.findIndex(t=>t.id===uploadTarget.id);if(idx>=0)S.tasks[idx]=r.task;
        toast('附件已上传','ok');
      }else{
        /* 资料库上传：进弹窗队列，逐个选分类/描述；取消则整批不上传 */
        _pendingUploads.push({name:file.name,size:file.size,type:file.type,dataUrl});
        if(!$('#m-upload').classList.contains('on'))nextUploadModal();
      }
      render();
    }catch(e){toast(e.message,'err')}
  };
  reader.onerror=()=>toast('读取文件失败','err');
  reader.readAsDataURL(file);
}
function downloadAtt(dataUrl,name){const link=document.createElement('a');link.href=dataUrl;link.download=name;link.click()}
async function delAtt(taskId,attId){
  if(!confirm('删除此附件？'))return;
  try{const r=await api('/tasks/'+taskId+'/attachments/'+attId,{method:'DELETE'});const idx=S.tasks.findIndex(t=>t.id===taskId);if(idx>=0)S.tasks[idx]=r.task;render();toast('已删除','ok')}
  catch(e){toast(e.message,'err')}
}
document.addEventListener('dragover',e=>{e.preventDefault();const d=e.target.closest('.attach-drop');if(d)d.classList.add('drag')});
document.addEventListener('dragleave',e=>{const d=e.target.closest('.attach-drop');if(d)d.classList.remove('drag')});
document.addEventListener('drop',e=>{
  e.preventDefault();
  const d=e.target.closest('.attach-drop');if(!d)return;
  d.classList.remove('drag');
  [...e.dataTransfer.files].forEach(f=>handleFile(f));
});

/* ============ Task Modal ============ */
function openTaskEdit(id){
  if(id){
    const t=S.tasks.find(x=>x.id===id);if(!t)return;
    if(!isAdmin()&&t.assigneeId!==me.id){toast('无编辑权限','err');return}
  }else if(!can('createTask')){toast('你没有新建任务的权限','err');return}
  editTask=id||null;
  const t=id?S.tasks.find(x=>x.id===id):null;
  $('#mt-title').textContent=id?'编辑任务':'新建任务';
  $('#t-del').style.display=(id&&isAdmin())?'inline-flex':'none';
  $('#t-name').value=t?t.title:'';
  $('#t-desc').value=t?t.desc:'';
  $('#t-line').innerHTML=LINE_KEYS.map(k=>'<option value="'+k+'">'+esc(lineName(k))+'</option>').join('');
  $('#t-line').value=t?t.line:LINE_KEYS[0];
  $('#t-ddl').value=t?t.ddl:'';
  $('#t-assignee').innerHTML='<option value="">未分配（待认领）</option>'+S.members.map(m=>'<option value="'+m.id+'"'+(t&&t.assigneeId===m.id?' selected':'')+'>'+esc(m.name)+(m.isAdmin?' ★':'')+'</option>').join('');
  openM('m-task');
}
async function saveTaskEdit(){
  const name=$('#t-name').value.trim();if(!name){toast('填个任务名称','w');return}
  const body={title:name,desc:$('#t-desc').value.trim(),line:$('#t-line').value,ddl:$('#t-ddl').value,assigneeId:$('#t-assignee').value||null};
  try{
    if(editTask){
      const r=await api('/tasks/'+editTask,{method:'PATCH',body});
      const idx=S.tasks.findIndex(t=>t.id===editTask);if(idx>=0)S.tasks[idx]=r.task;
      toast('已更新','ok');
    }else{
      const r=await api('/tasks',{method:'POST',body});
      S.tasks.push(r.task);toast('已创建','ok');
    }
    closeM('m-task');render();
  }catch(e){toast(e.message,'err')}
}
async function delTask(){
  if(!editTask||!can('deleteTask')){toast('你没有删除任务的权限','err');return}
  if(!confirm('确定删除这个任务？附件和评论都会一并删除。'))return;
  try{
    await api('/tasks/'+editTask,{method:'DELETE'});
    const t=S.tasks.find(x=>x.id===editTask);
    S.tasks=S.tasks.filter(x=>x.id!==editTask);
    S.reviews=S.reviews.filter(r=>r.taskId!==editTask);
    closeM('m-task');
    if(view==='task-detail')go('tasks');else render();
    toast('已删除「'+(t?t.title:'')+'」','ok');
  }catch(e){toast(e.message,'err')}
}

/* ============ Resources ============ */
function rRes(){
  const catKeys=Object.keys(RES_CATS);
  let html='<div class="res-toolbar"><button class="btn btn-p btn-sm" onclick="triggerUploadRes()">+ 上传资料</button><span style="font-size:11px;color:var(--mut);margin-left:6px">分类</span>';
  ['all'].concat(catKeys).forEach(c=>{const n=S.resources.filter(r=>c==='all'||r.cat===c).length;html+='<button class="filter-chip '+(resCat===c?'on':'')+'" onclick="resCat=\''+c+'\';render()">'+(c==='all'?'全部':esc(RES_CATS[c].name))+' ('+n+')</button>'});
  html+='</div>';
  const list=resCat==='all'?S.resources:S.resources.filter(r=>r.cat===resCat);
  if(!list.length)return html+'<div class="empty"><div class="empty-icon">◈</div>暂无资料<br/><span style="font-size:11px">点击上方"上传资料"添加</span></div>';
  html+='<div class="res-grid">';
  list.slice().sort((a,b)=>b.uploadedAt-a.uploadedAt).forEach(r=>{
    const up=getMember(r.uploadedBy);
    html+='<div class="card res-card"><div style="display:flex;align-items:flex-start;gap:10px">'+
      '<div class="res-icon cat-'+r.cat+'">'+(RES_CATS[r.cat]?RES_CATS[r.cat].icon:'◈')+'</div>'+
      '<div style="flex:1;min-width:0"><div class="res-name">'+esc(r.name)+'</div><div class="res-meta" style="margin-top:3px"><span class="tag">'+(RES_CATS[r.cat]?esc(RES_CATS[r.cat].name):esc(r.cat))+'</span><span>'+fmtSize(r.size)+'</span></div></div>'+
    '</div>'+(r.desc?'<div style="font-size:11.5px;color:var(--txt2);line-height:1.5">'+esc(r.desc)+'</div>':'')+
    '<div class="res-meta" style="border-top:1px solid var(--border-s);padding-top:6px;margin-top:auto"><span>'+esc((up||{}).name||'?')+'</span><span>·</span><span>'+ago(r.uploadedAt)+'</span>'+
    '<span style="margin-left:auto;display:flex;gap:4px">'+(r.dataUrl?'<button class="btn btn-ghost btn-xs" onclick="downloadRes(\''+r.id+'\')">下载</button>':'')+((isAdmin()||r.uploadedBy===me.id)?'<button class="btn btn-ghost btn-xs" style="color:var(--err)" onclick="delRes(\''+r.id+'\')">删</button>':'')+'</span></div></div>';
  });
  return html+'</div>';
}
function downloadRes(id){const r=S.resources.find(x=>x.id===id);if(!r||!r.dataUrl){toast('无实际文件（示例数据）','w');return}downloadAtt(r.dataUrl,r.name)}
async function delRes(id){
  if(!confirm('删除此资料？'))return;
  try{await api('/resources/'+id,{method:'DELETE'});S.resources=S.resources.filter(r=>r.id!==id);render();toast('已删除','ok')}
  catch(e){toast(e.message,'err')}
}

/* ============ Announcements ============ */
function rAnn(){
  let html='<div class="board-toolbar">';
  if(can('announce'))html+='<button class="btn btn-p btn-sm" onclick="openAnnM()">+ 发布公告</button>';
  else html+='<span style="font-size:11px;color:var(--mut)">仅管理员可发布公告</span>';
  html+='</div>';
  const list=S.announcements.slice().sort((a,b)=>((b.pinned?1:0)-(a.pinned?1:0))||(b.ts-a.ts));
  if(!list.length)return html+'<div class="empty"><div class="empty-icon">◇</div>暂无公告</div>';
  html+='<div class="ann-list">';
  list.forEach(a=>{
    html+='<div class="card ann '+(a.pinned?'pinned':'')+'"><div class="ann-h">'+(a.pinned?'<span class="ann-pin">📌</span>':'')+'<div class="ann-title">'+esc(a.title)+'</div>'+
      (isAdmin()?'<button class="btn btn-ghost btn-xs" onclick="togglePin(\''+a.id+'\')">'+(a.pinned?'取消置顶':'置顶')+'</button><button class="btn btn-ghost btn-xs" style="color:var(--err)" onclick="delAnn(\''+a.id+'\')">删除</button>':'')+
      '</div><div class="ann-body">'+renderMd(a.body)+'</div>'+
      '<div class="ann-meta"><span>'+esc(a.authorName)+'</span><span>·</span><span>'+fmtFull(a.ts)+'</span><span style="margin-left:auto">'+ago(a.ts)+'</span></div></div>';
  });
  return html+'</div>';
}
/* ============ 使用说明（页面内置） ============ */
const HELP_MD=[
'# 小组作业工作台 · 使用说明','',
'## 一、三分钟上手','',
'1. 打开链接，选择自己的名字并输入 PIN 进入。**首次选择名字时会让你设置一个 4-8 位数字 PIN**，这个 PIN 绑定你的身份：换设备登录、重新登录都要输入它，别人不知道你的 PIN 就无法冒用你的身份。','',
'2. 进来先看**总览页**：顶部横幅是提醒（可点"知道了"关掉），下面是你的任务、待认领任务、待处理审议意见和最新公告。','',
'3. 页面每 12 秒自动同步一次别人做的改动；你正在打字时不会被打断。左下角"已同步"变红说明断线了，稍等会自动恢复。登录一次后本设备**一年内打开即自动进入**，无需重复输 PIN。','',
'4. 手机也能用：直接在手机浏览器打开同一个链接。','',
'模块开关、任务分类、以及各项操作权限（哪些仅管理员可用、哪些开放给所有人）都在初始化向导中由搭建者配置（模板预设见 config.js）。本说明中的"管理员"泛指拥有对应权限的人。','',
'## 二、两种角色，权限不同','',
'| 操作 | 管理员（组长 ★） | 普通成员 |','|---|---|---|','| 新建 / 删除任务 | ✅ | ❌ |','| 指定 / 更换任务负责人 | ✅ | ❌ |','| 编辑任务信息（自己的任务） | ✅ | ✅ |','| 认领"待认领"任务 | ✅ | ✅ |','| 上传交付附件 | 任何任务 | 自己负责的任务 |','| 编辑交付文档 | 任何任务 | 自己负责的任务 |','| 任务评论区发言 | 任何任务 | 自己负责的任务 |','| 标记"需返工" | ✅ | ❌ |','| 标记"已完成"（验收） | ✅ | ❌ |','| 公告发布 / 置顶 / 删除 | ✅ | 只能看 |','| 审议意见的处理结果 | ✅ | 只能提交 |','| 成员管理（改名/增删） | ✅ | ❌ |','| 数据备份 / 恢复 | ✅ | ❌ |','',
'## 三、任务状态流转（核心规则）','',
'每个任务只有五种状态：**待认领 → 进行中 → 待审核 →（需返工 ⇄ 进行中）→ 已完成**','',
'- **待认领**：任何人都可以点"认领此任务"，认领后自动成为负责人并进入进行中','',
'- **进行中**：负责人自己做，随时可以在评论区更新进度','',
'- **待审核**：负责人交付后自己提交。**门槛：必须先上传附件或在"交付文档"里写好内容，否则按钮是锁定的**','',
'- **需返工**：只有管理员能标记，必须写返工意见（自动写入评论区，负责人会看到具体哪里要改）；负责人改完自己转回进行中，重新提交','',
'- **已完成**：只有管理员验收后能标记','',
'页面上不能点的状态按钮会显示 🔒，鼠标悬停（手机上点一下）能看到原因。任务卡片左侧的颜色代表任务分类（由部署者在 config.js 中自定义）。','',
'## 四、交付文档怎么用','',
'每个任务自带一个交付文档，在任务详情页顶部第二个标签「📄 交付文档」：','',
'- **撰写**：负责人或管理员点右上角"✎ 开始撰写 / ✎ 编辑"，用 Markdown 写，左边写右边实时预览；保存即生成 v1、v2、v3…每个版本带一句修改说明，历史版本随时可回看（只读）','',
'- **提意见（所有人）**：打开文档直接读，右侧就是意见墙；想精确指出位置，**先在文档里选中那句话，再点上方"💬 引用选中文字提意见"**，你的意见会带上引用原文','',
'- **处理**：管理员可以把意见"标记已处理"；谁都能删自己提的意见，管理员能删任何人的','',
'## 五、审议意见（对任务本身的想法）','',
'觉得任务安排不合理、想提建议，去「审议意见」栏目：每条意见关联一个任务，意见人自动记录不可代填。管理员会标注**已采纳 / 不采纳**并写备注。注意区分：对**任务安排**的想法走这里，对**文档内容**的意见走交付文档的意见墙。','',
'## 六、资料库与公告区','',
'- **资料库**：所有人可上传（分类由部署者自定义），文件限 6MB 以内，大文件放网盘贴链接；上传者和管理员可删','',
'- **公告区**：只有管理员能发，用于会议时间、阶段目标、重要通知，可置顶','',
'## 七、文献汇总（查文献专用）','',
'查文献不再刷群：「📚 文献汇总」里每人直接提交文献题目（可附来源、推荐理由），即时入清单、自动查重。','- **共同审稿**：每条文献所有人可点 👍/👎 表态、写审稿意见（值不值得读、用在哪部分）','- **采纳与导出**：管理员标记「✅ 采纳」进入最终清单；「📋 复制清单」一键导出 Markdown，直接贴进作业/报告的参考文献','',
'## 八、提醒机制','',
'- 任务**到期前 1 天、当天、逾期后**：提醒负责人（页面顶部红色横幅）','',
'- **每周日晚 8 点后**：全员提醒更新各自任务进度','',
'- **管理员专属**：待审核任务清单、待处理审议意见数量的提醒','',
'注意：提醒只在**打开工作台时**出现，不会推送到微信，所以重要的事还是要在群里说一声让大家来看。','',
'## 九、数据备份（管理员务必做）','',
'右上角「📥 备份」把全部数据导出成一个 JSON 文件，「📤 恢复」可以导回去。**建议每 2-3 天备份一次**，文件按日期命名存好。万一服务器数据出问题，恢复备份就能救回来。附件文件包含在备份里。','',
'---','',
'# 常见问题（FAQ）','',
'**Q1：为什么我看不到"编辑文档"按钮？**','只有该任务的负责人和管理员能编辑。如果你是普通成员且不是负责人，进去是阅读模式，右侧提意见就好。','',
'**Q2：为什么"待审核"按钮是锁的？**','规则要求先交付：要么在任务里上传附件，要么在「交付文档」里写好内容并保存，按钮自动解锁。','',
'**Q3：为什么我不能在别人任务的评论区发言？**','评论区是该任务的工作记录，只有负责人和管理员能发言。你对别人任务的想法请走「审议意见」。','',
'**Q4：别人怎么知道我改了东西？**','页面每 12 秒自动同步；任务评论区的系统记录也会写明谁在什么时间做了什么。','',
'**Q5：我把名字打错了 / 有人退组了怎么办？**','管理员右上角「👤 成员」里可以改名、添加、删除成员（删除要求名下没有任务）。历史记录里显示的还是当时的名字，属正常。','',
'**Q6：文件上传失败？**','单个文件限 6MB。视频等大文件请放网盘/群文件，然后在资料库描述里贴链接。','',
'**Q7：数据会丢吗？**','数据存在运行这个网站的服务器上（data 目录）。请管理员养成定期「备份」的习惯；万一丢失，用备份文件「恢复」即可。','',
'**Q8：误删了任务/公告怎么办？**','没有回收站。如果你最近备份过，管理员可以恢复备份（注意：恢复会覆盖当前全部数据，恢复前先备份一份当前的）。','',
'**Q9：两个人同时编辑同一份文档会怎样？**','以先保存的为准，后保存的会覆盖先保存的（提示"内容没有变化"说明你看到的已是最新）。建议同一时间只有一个人编辑，其他人用意见墙提意见——这正是本工作台的设计。','',
'**Q10：这工作台有密码吗？别人能冒用我的身份吗？**','每个身份有一个 PIN（首次登录时自己设置）。设置后，任何设备要用你的名字进入都必须输入这个 PIN，所以别人无法冒用你。PIN 是 4-8 位数字，别用生日。','',
'**Q11：忘了 PIN 怎么办？**','找管理员，在右上角「👤 成员」里对你的名字点「重置PIN」，重置后你下次登录重新设置一个新 PIN（当前已登录的设备会被登出）。','',
'**Q12：换了手机/电脑要重新登录吗？**','新设备/新浏览器第一次打开需要选名字+输 PIN，之后该设备一年内自动进入。清除了浏览器数据或用无痕模式则需要重新验证。','',
'**Q13：手机上排版乱吗？**','做了响应式适配，手机浏览器直接打开即可，小屏幕上文档和意见墙会上下排列。','',
'**Q14：文献汇总和资料库有什么区别？**','资料库存**文件**（PDF、图片、网盘链接）；文献汇总存**题目**，专门用于查文献阶段的收集与共同审稿——每人提交题目、大家投票评论、管理员采纳、一键导出清单。两边各管各的。',''
].join('\n');
/* Markdown 渲染：marked 解析后必须过 DOMPurify 净化（公告/文档是用户可写的，
 * 不过滤会被注入脚本）。DOMPurify 加载失败时降级为纯文本转义，绝不裸渲染。 */
function renderMd(txt){
  try{
    const html=marked.parse(txt||'');
    if(window.DOMPurify&&DOMPurify.sanitize)return DOMPurify.sanitize(html);
    return esc(txt||'').replace(/\n/g,'<br/>');
  }catch(e){return esc(txt||'').replace(/\n/g,'<br/>')}
}
function openAnnM(){$('#a-title').value='';$('#a-body').value='';$('#a-pin').checked=false;openM('m-ann')}
async function saveAnn(){
  const title=$('#a-title').value.trim();const body=$('#a-body').value.trim();
  if(!title){toast('填个标题','w');return}
  try{const r=await api('/announcements',{method:'POST',body:{title,body,pinned:$('#a-pin').checked}});S.announcements.push(r.announcement);closeM('m-ann');render();toast('已发布','ok')}
  catch(e){toast(e.message,'err')}
}
async function togglePin(id){
  try{const r=await api('/announcements/'+id+'/pin',{method:'PATCH'});const idx=S.announcements.findIndex(x=>x.id===id);if(idx>=0)S.announcements[idx]=r.announcement;render()}
  catch(e){toast(e.message,'err')}
}
async function delAnn(id){
  if(!confirm('删除此公告？'))return;
  try{await api('/announcements/'+id,{method:'DELETE'});S.announcements=S.announcements.filter(a=>a.id!==id);render();toast('已删除','ok')}
  catch(e){toast(e.message,'err')}
}

/* ============ Reviews ============ */
function rRev(){
  let html='<div class="board-toolbar"><button class="btn btn-p btn-sm" onclick="openRevModal()">+ 提交审议意见</button><span style="font-size:11px;color:var(--mut);margin-left:6px">状态</span>';
  ['all','pending','accepted','rejected'].forEach(f=>{html+='<button class="filter-chip '+(revF===f?'on':'')+'" onclick="revF=\''+f+'\';render()">'+({all:'全部',pending:'待处理',accepted:'已采纳',rejected:'不采纳'})[f]+'</button>'});
  html+='</div>';
  let list=S.reviews.slice().sort((a,b)=>b.ts-a.ts);
  if(revF!=='all')list=list.filter(r=>r.resolution===revF);
  if(!list.length)return html+'<div class="empty"><div class="empty-icon">✎</div>暂无审议意见</div>';
  html+='<div class="rev-list">';
  list.forEach(r=>{
    const t=S.tasks.find(x=>x.id===r.taskId);
    html+='<div class="card rev"><div class="rev-h"><span class="rev-task" onclick="openTask(\''+r.taskId+'\')">▤ '+esc(t?t.title:'（任务已删除）')+'</span>'+(t?'<span class="tag tag-i">'+esc(lineName(t.line))+'</span>':'')+'<span class="rev-resolution res-'+r.resolution+'">'+({pending:'待处理',accepted:'已采纳',rejected:'不采纳'})[r.resolution]+'</span>'+
      (can('resolveReview')&&r.resolution==='pending'?'<span class="rev-admin-actions"><button class="btn btn-ok btn-xs" onclick="setRes(\''+r.id+'\',\'accepted\')">✓ 采纳</button><button class="btn btn-err btn-xs" onclick="setRes(\''+r.id+'\',\'rejected\')">✗ 不采纳</button></span>':'')+
      '</div><div class="rev-body">'+esc(r.content)+'</div>'+
      '<div class="rev-foot"><span>意见人：<strong>'+esc(r.authorName)+'</strong></span><span>·</span><span>'+fmtFull(r.ts)+'</span>'+(r.resolvedAt?'<span style="margin-left:auto">处理人：'+esc((getMember(r.resolvedBy)||{}).name||'?')+' · '+ago(r.resolvedAt)+'</span>':'')+'</div>'+
      (r.adminNote?'<div style="margin-top:8px;padding:8px 11px;background:'+(r.resolution==='accepted'?'var(--ok-bg)':'var(--err-bg)')+';border-radius:var(--rs);font-size:11.5px;color:'+(r.resolution==='accepted'?'#2F5540':'#8A2E25')+';border-left:2px solid '+(r.resolution==='accepted'?'var(--ok)':'var(--err)')+'"><strong>管理员备注：</strong>'+esc(r.adminNote)+'</div>':'')+
      (can('resolveReview')&&r.resolution!=='pending'?'<div style="margin-top:6px"><button class="btn btn-ghost btn-xs" onclick="setRes(\''+r.id+'\',\'pending\')">↺ 改回待处理</button></div>':'')+
    '</div>';
  });
  return html+'</div>';
}
function openRevModal(taskId){
  $('#r-task').innerHTML=S.tasks.map(t=>'<option value="'+t.id+'"'+(taskId===t.id?' selected':'')+'>'+esc(t.title)+' ('+esc(lineName(t.line))+')</option>').join('');
  if(taskId)$('#r-task').value=taskId;
  $('#r-author').value=me.name+'（自动记录，不可修改）';
  $('#r-body').value='';
  openM('m-rev');setTimeout(()=>$('#r-body').focus(),50);
}
async function saveRev(){
  const body=$('#r-body').value.trim();
  if(!body){toast('请填写意见内容','w');return}
  try{const r=await api('/reviews',{method:'POST',body:{taskId:$('#r-task').value,content:body}});S.reviews.push(r.review);closeM('m-rev');render();toast('审议意见已提交','ok')}
  catch(e){toast(e.message,'err')}
}
async function setRes(id,res){
  if(!can('resolveReview')){toast('你没有处理意见的权限','err');return}
  const r=S.reviews.find(x=>x.id===id);
  let note=r.adminNote||'';
  if(res!=='pending'){
    const n=prompt(res==='accepted'?'采纳说明（可留空）：':'不采纳原因（建议填写）：',note);
    if(n===null)return;
    note=n;
  }
  try{const rr=await api('/reviews/'+id,{method:'PATCH',body:{resolution:res,adminNote:note}});const idx=S.reviews.findIndex(x=>x.id===id);if(idx>=0)S.reviews[idx]=rr.review;render();toast('已更新处理结果','ok')}
  catch(e){toast(e.message,'err')}
}

/* ============ 文献汇总 ============ */
let litF='all';
function rLit(){
  const list=S.literatures||[];
  const adopted=list.filter(x=>x.adopted).length;
  const myN=list.filter(x=>x.authorId===me.id).length;
  let html='<div class="card" style="padding:14px 16px;margin-bottom:14px">'+
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><span style="font-size:13px;font-weight:600">📚 提交一条文献</span><span style="margin-left:auto;font-size:11px;color:var(--mut)">共 '+list.length+' 条 · 已采纳 '+adopted+' · 我提交 '+myN+' 条</span></div>'+
    '<div style="display:flex;gap:6px;flex-wrap:wrap">'+
      '<input class="fi" id="lit-title" placeholder="文献/专著题目（必填）" style="flex:2;min-width:220px" maxlength="300"/>'+
      '<input class="fi" id="lit-source" placeholder="来源/作者（选填）" style="flex:1;min-width:140px" maxlength="200"/>'+
    '</div>'+
    '<div style="display:flex;gap:6px;margin-top:6px">'+
      '<input class="fi" id="lit-note" placeholder="推荐理由（选填）" style="flex:1" maxlength="500"/>'+
      '<button class="btn btn-p btn-sm" onclick="submitLit()">提交</button>'+
    '</div>'+
    '<div class="hint" style="margin:8px 0 0">提交后直接入清单（重复题目会被拦截）。再点一次同方向的 👍/👎 可取消投票。</div>'+
  '</div>';
  html+='<div class="board-toolbar"><span style="font-size:11px;color:var(--mut)">筛选</span>';
  ['all','pending','adopted'].forEach(f=>{html+='<button class="filter-chip '+(litF===f?'on':'')+'" onclick="litF=\''+f+'\';render()">'+({all:'全部',pending:'待定',adopted:'已采纳'})[f]+'</button>'});
  html+='<button class="btn btn-s btn-sm" style="margin-left:auto" onclick="exportLit()">📋 复制清单</button></div>';
  const items=litF==='all'?list:list.filter(x=>litF==='adopted'?x.adopted:!x.adopted);
  if(!items.length)return html+'<div class="empty"><div class="empty-icon">📚</div>暂无文献</div>';
  items.slice().sort((a,b)=>(b.adopted-a.adopted)||(b.ts-a.ts)).forEach(x=>{
    const votes=x.votes||{};
    const ups=Object.values(votes).filter(v=>v==='up').length;
    const downs=Object.values(votes).filter(v=>v==='down').length;
    const myVote=votes[me.id];
    html+='<div class="card" style="padding:12px 15px;margin-bottom:10px;'+(x.adopted?'border-left:3px solid var(--ok)':'')+'">'+
      '<div style="display:flex;gap:8px;align-items:flex-start">'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-size:13.5px;font-weight:600;line-height:1.5">'+esc(x.title)+(x.adopted?' <span class="tag tag-ok">✅ 已采纳</span>':'')+'</div>'+
          '<div style="font-size:11px;color:var(--mut);margin-top:3px">'+(x.source?esc(x.source)+' · ':'')+esc(x.authorName)+' · '+ago(x.ts)+'</div>'+
        '</div>'+
        '<div style="display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">'+
          '<button class="btn '+(myVote==='up'?'btn-ok':'btn-s')+' btn-xs" onclick="voteLit(\''+x.id+'\',\'up\')">👍'+(ups||'')+'</button>'+
          '<button class="btn '+(myVote==='down'?'btn-err':'btn-s')+' btn-xs" onclick="voteLit(\''+x.id+'\',\'down\')">👎'+(downs||'')+'</button>'+
          (can('adoptLit')?'<button class="btn btn-s btn-xs" onclick="adoptLit(\''+x.id+'\')">'+(x.adopted?'取消采纳':'✅ 采纳')+'</button>':'')+
          ((isAdmin()||x.authorId===me.id)?'<button class="btn btn-d btn-xs" onclick="delLit(\''+x.id+'\')">删</button>':'')+
        '</div>'+
      '</div>'+
      (x.note?'<div style="font-size:12px;color:var(--txt2);line-height:1.55;margin-top:6px;padding:6px 10px;background:var(--bg);border-radius:var(--rs)">💡 '+esc(x.note)+'</div>':'')+
      '<div style="margin-top:8px"><span class="comment-action" onclick="toggleLitCm(\''+x.id+'\')">💬 共同审稿（'+(x.comments||[]).length+'）</span></div>'+
      '<div id="litcm-'+x.id+'" style="display:none;margin-top:8px;border-top:1px dashed var(--border-s);padding-top:8px">'+
        ((x.comments||[]).slice().sort((a,b)=>a.ts-b.ts).map(c=>'<div class="comment"><div class="comment-h"><span class="comment-who">'+esc(c.authorName)+'</span><span class="comment-time">'+fmtFull(c.ts)+'</span>'+((isAdmin()||c.authorId===me.id)?'<button class="btn btn-ghost btn-xs" style="color:var(--err)" onclick="delLitCm(\''+x.id+'\',\''+c.id+'\')">删</button>':'')+'</div><div class="comment-body">'+esc(c.content)+'</div></div>').join('')||'<div class="empty" style="padding:8px;font-size:11px">还没有审稿意见</div>')+
        '<div class="comment-input"><textarea id="litcm-in-'+x.id+'" placeholder="对这篇的意见：值不值得读、用在哪部分..." style="min-height:34px"></textarea><button class="btn btn-p btn-sm" onclick="addLitCm(\''+x.id+'\')">发送</button></div>'+
      '</div>'+
    '</div>';
  });
  return html;
}
async function submitLit(){
  const title=$('#lit-title').value.trim();
  if(!title){toast('填一下题目','w');return}
  try{
    const r=await api('/literatures',{method:'POST',body:{title,source:$('#lit-source').value.trim(),note:$('#lit-note').value.trim()}});
    if(!S.literatures)S.literatures=[];
    S.literatures.push(r.item);
    $('#lit-title').value='';$('#lit-source').value='';$('#lit-note').value='';
    render();toast('已加入清单','ok');
  }catch(e){toast(e.message,'err')}
}
async function voteLit(id,vote){
  try{const r=await api('/literatures/'+id,{method:'PATCH',body:{action:'vote',vote}});
    const i=S.literatures.findIndex(x=>x.id===id);if(i>=0)S.literatures[i]=r.item;
    render();
  }catch(e){toast(e.message,'err')}
}
async function adoptLit(id){
  try{const r=await api('/literatures/'+id,{method:'PATCH',body:{action:'adopt'}});
    const i=S.literatures.findIndex(x=>x.id===id);if(i>=0)S.literatures[i]=r.item;
    render();toast(r.item.adopted?'已采纳进最终清单':'已取消采纳','ok');
  }catch(e){toast(e.message,'err')}
}
async function delLit(id){
  if(!confirm('删除这条文献？'))return;
  try{await api('/literatures/'+id,{method:'DELETE'});
    S.literatures=S.literatures.filter(x=>x.id!==id);
    render();toast('已删除','ok');
  }catch(e){toast(e.message,'err')}
}
function toggleLitCm(id){const el=$('#litcm-'+id);if(el)el.style.display=el.style.display==='none'?'':'none'}
async function addLitCm(id){
  const inp=$('#litcm-in-'+id);const c=inp.value.trim();if(!c){toast('写点什么吧','w');return}
  try{const r=await api('/literatures/'+id+'/comments',{method:'POST',body:{content:c}});
    const i=S.literatures.findIndex(x=>x.id===id);if(i>=0)S.literatures[i]=r.item;
    render();toast('已发送','ok');
  }catch(e){toast(e.message,'err')}
}
async function delLitCm(id,cid){
  try{const r=await api('/literatures/'+id+'/comments/'+cid,{method:'DELETE'});
    const i=S.literatures.findIndex(x=>x.id===id);if(i>=0)S.literatures[i]=r.item;
    render();
  }catch(e){toast(e.message,'err')}
}
function exportLit(){
  const adopted=(S.literatures||[]).filter(x=>x.adopted);
  const src=adopted.length?adopted:(S.literatures||[]);
  if(!src.length){toast('清单是空的','w');return}
  let md='## 文献清单（'+(adopted.length?'已采纳':'全部')+'，共 '+src.length+' 条）\n\n';
  src.forEach((x,i)=>{md+=(i+1)+'. '+x.title+(x.source?'（'+x.source+'）':'')+'\n'});
  navigator.clipboard.writeText(md).then(()=>toast('清单已复制，可粘贴到作业或群','ok')).catch(()=>{prompt('请手动复制：',md)});
}

/* ============ Backup ============ */
async function exportBackup(){
  try{
    const r=await api('/backup');
    const blob=new Blob([JSON.stringify(r.state,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download='工作台备份_'+new Date().toISOString().slice(0,10)+'.json';a.click();
    URL.revokeObjectURL(url);
    toast('备份已下载','ok');
  }catch(e){toast(e.message,'err')}
}
function importBackup(){$('#restore-input').click()}
$('#restore-input').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  if(!confirm('恢复备份会覆盖当前所有数据，确定继续？'))return;
  const reader=new FileReader();
  reader.onload=async ev=>{
    try{
      const backup=JSON.parse(ev.target.result);
      const r=await api('/restore',{method:'POST',body:{state:backup}});
      S=r.state||backup;
      render();toast('备份已恢复','ok');
    }catch(err){toast('恢复失败：'+err.message,'err')}
  };
  reader.readAsText(file);
  e.target.value='';
});

/* ============ Modal ============ */
function openM(id){$('#'+id).classList.add('on')}
function closeM(id){$('#'+id).classList.remove('on')}
$$('.mask').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('on')}));
document.addEventListener('keydown',e=>{if(e.key==='Escape')$$('.mask.on').forEach(m=>m.classList.remove('on'))});

init();
