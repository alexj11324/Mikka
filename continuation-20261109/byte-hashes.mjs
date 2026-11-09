// Evidence-byte hashing only; not part of Mikka product/runtime.
// Recovered after transient orchestration storage reset; verified against known SHA vectors and existing immutable source digest.
export function utf8(s){const bytes=[];for(const char of s){let cp=char.codePointAt(0);if(cp>=0xd800&&cp<=0xdfff)cp=0xfffd;if(cp<0x80)bytes.push(cp);else if(cp<0x800)bytes.push(0xc0|(cp>>6),0x80|(cp&63));else if(cp<0x10000)bytes.push(0xe0|(cp>>12),0x80|((cp>>6)&63),0x80|(cp&63));else bytes.push(0xf0|(cp>>18),0x80|((cp>>12)&63),0x80|((cp>>6)&63),0x80|(cp&63));}return bytes;}
export function sha256(bytes){
 const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
 const data=Array.from(bytes),bits=data.length*8;data.push(128);while(data.length%64!==56)data.push(0);const hi=Math.floor(bits/4294967296),lo=bits>>>0;for(let s=24;s>=0;s-=8)data.push((hi>>>s)&255);for(let s=24;s>=0;s-=8)data.push((lo>>>s)&255);
 const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],r=(x,n)=>(x>>>n)|(x<<(32-n));
 for(let p=0;p<data.length;p+=64){const w=new Array(64);for(let i=0;i<16;i++){let q=p+i*4;w[i]=((data[q]<<24)|(data[q+1]<<16)|(data[q+2]<<8)|data[q+3])>>>0;}for(let i=16;i<64;i++){let x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(r(x,7)^r(x,18)^(x>>>3))+w[i-7]+(r(y,17)^r(y,19)^(y>>>10)))>>>0;}
 let[a,b,c,d,e,f,g,z]=h;for(let i=0;i<64;i++){const t1=(z+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+k[i]+w[i])>>>0,t2=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0;z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}[a,b,c,d,e,f,g,z].forEach((v,i)=>h[i]=(h[i]+v)>>>0);}
 return h.map(v=>v.toString(16).padStart(8,"0")).join("");
}
export function sha1(bytes){
 const data=Array.from(bytes),bits=data.length*8;data.push(128);while(data.length%64!==56)data.push(0);const hi=Math.floor(bits/4294967296),lo=bits>>>0;for(let s=24;s>=0;s-=8)data.push((hi>>>s)&255);for(let s=24;s>=0;s-=8)data.push((lo>>>s)&255);
 let h=[0x67452301,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0];const rot=(x,n)=>(x<<n)|(x>>>(32-n));
 for(let p=0;p<data.length;p+=64){let w=new Array(80);for(let i=0;i<16;i++){const q=p+i*4;w[i]=(data[q]<<24)|(data[q+1]<<16)|(data[q+2]<<8)|data[q+3];}for(let i=16;i<80;i++)w[i]=rot(w[i-3]^w[i-8]^w[i-14]^w[i-16],1);let[a,b,c,d,e]=h;for(let i=0;i<80;i++){const f=i<20?(b&c)|(~b&d):i<40?b^c^d:i<60?(b&c)|(b&d)|(c&d):b^c^d;const k=i<20?0x5a827999:i<40?0x6ed9eba1:i<60?0x8f1bbcdc:0xca62c1d6;const t=(rot(a,5)+f+e+k+w[i])>>>0;e=d;d=c;c=rot(b,30);b=a;a=t;}[a,b,c,d,e].forEach((v,i)=>h[i]=(h[i]+v)>>>0);}
 return h.map(v=>v.toString(16).padStart(8,"0")).join("");
}
