const __ROOT__ = require('path').join(__dirname, '..');
const R=(__ROOT__ + '/src/');
const fs=require('fs');
// withRetry/errCode are module-private; exercise them via the same source.
const src=fs.readFileSync(R+'sftp.js','utf8');
const body=src.slice(src.indexOf('const RETRYABLE'),src.indexOf('function sftpOnActiveChange'));
const errors={record(){}};
const mod=new Function('errors','const module={exports:{}};'+body+';return {withRetry,errCode,RETRYABLE};')(errors);
const {withRetry,errCode}=mod;

let pass=0,fail=0,done=0;
const t=(n,c)=>{try{if(c()===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n)}}catch(e){fail++;console.log('  FAIL '+n+' -> '+e.message)}};
const ta=(n,run)=>{done++;run(ok=>{if(ok){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n)};if(--done===0)finish()})};

t('errCode reads err.code',()=>errCode({code:'ETXTBSY'})==='ETXTBSY');
t('errCode digs the code out of an ssh2 message string',()=>errCode({message:'Failure: ETXTBSY on write'})==='ETXTBSY');
t('errCode returns null for an unrecognised error',()=>errCode({message:'boom'})===null);
t('errCode tolerates null',()=>errCode(null)===null);

ta('retries ETXTBSY then succeeds',cb=>{
  let n=0;
  withRetry('x',d=>{n++;d(n<3?{code:'ETXTBSY'}:null)},e=>cb(!e&&n===3));
});
ta('gives up after max attempts and reports the real code',cb=>{
  let n=0;
  withRetry('x',d=>{n++;d({code:'EBUSY'})},e=>cb(!!e&&e.code==='EBUSY'&&n===4));
});
ta('does not retry a non-retryable error',cb=>{
  let n=0;
  withRetry('x',d=>{n++;d({code:'EACCES'})},e=>cb(!!e&&n===1));
});
ta('succeeds first try without retrying',cb=>{
  let n=0;
  withRetry('x',d=>{n++;d(null)},e=>cb(!e&&n===1));
});
ta('attaches a parsed code to an ssh2 error lacking .code',cb=>{
  withRetry('x',d=>d({message:'permission denied: EACCES'}),e=>cb(!!e&&e.code==='EACCES'));
});
function finish(){console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0)}
