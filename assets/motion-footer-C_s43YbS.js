import{n as e}from"./rolldown-runtime-CbXtAM7H.js";import{it as t,rt as n,t as r}from"./motion-B4gWODd4.js";import{t as i}from"./Marquee-mzH15nJ9.js";import{t as a}from"./use-in-view-Curvvogc.js";import{_ as o,c as s,f as c,g as l,h as u,m as d,t as f}from"./index-B89CU_zB.js";import{n as p}from"./gsap-BJZ90ViQ.js";var m=e(t(),1),h=n(),g=`/`,_=g.endsWith(`/`)?g.slice(0,-1):g,v=`${_}/fonts/handwriting.ttf`,y=`${_}/vendor/opentype.min.js`,b=null;function x(){if(typeof window>`u`)return Promise.reject(Error(`no window`));let e=window.opentype;return e?Promise.resolve(e):(b||=new Promise((e,t)=>{let n=document.createElement(`script`);n.src=y,n.async=!0,n.onload=()=>{let n=window.opentype;n?e(n):t(Error(`opentype.js loaded but exposed nothing`))},n.onerror=()=>t(Error(`opentype.js failed to load`)),document.head.appendChild(n)}),b)}var S=new Map;function C(e){let t=S.get(e);return t||(t=Promise.all([x(),fetch(e).then(e=>{if(!e.ok)throw Error(`Font request failed: ${e.status}`);return e.arrayBuffer()})]).then(([e,t])=>e.parse(t)),S.set(e,t)),t}var w=100;function T({text:e,words:t,interval:n=3600,fontUrl:r=v,duration:i=1.5,delay:a=.05,strokeWidth:o=1.6,fill:s=!0,height:c=`1.15em`,className:l}){let u=!!(t&&t.length>0),[d,f]=(0,m.useState)(0),p=u?t[d%t.length]:e??``,[g,_]=(0,m.useState)(null),[y,b]=(0,m.useState)(null),[x,S]=(0,m.useState)(!1),[T,E]=(0,m.useState)([]),D=(0,m.useRef)([]);if((0,m.useEffect)(()=>{if(!u)return;let e=setInterval(()=>f(e=>e+1),n);return()=>clearInterval(e)},[u,n]),(0,m.useEffect)(()=>{let e=!1;return C(r).then(t=>{e||_(t)}).catch(()=>{}),()=>{e=!0}},[r]),(0,m.useEffect)(()=>{if(!g||!p)return;let e=g.getPath(p,0,w,w),t=e.getBoundingBox(),n=w*.12,r=e.toPathData(2);b({full:r,contours:r.split(/(?=M)/).filter(e=>e.trim().length>1),x:t.x1-n,y:t.y1-n,w:t.x2-t.x1+24,h:t.y2-t.y1+24}),S(!1),E([])},[g,p]),(0,m.useEffect)(()=>{if(!y)return;E(D.current.slice(0,y.contours.length).map(e=>e?e.getTotalLength():0));let e=requestAnimationFrame(()=>requestAnimationFrame(()=>S(!0)));return()=>cancelAnimationFrame(e)},[y]),!y)return(0,h.jsx)(`span`,{className:l,children:p});let O=Math.max(1,y.contours.length);return(0,h.jsxs)(`svg`,{viewBox:`${y.x} ${y.y} ${y.w} ${y.h}`,role:`img`,"aria-label":p,className:[`inline-block`,l].filter(Boolean).join(` `),style:{height:c,width:`calc(${c} * ${(y.w/y.h).toFixed(4)})`,overflow:`visible`},children:[s&&(0,h.jsx)(`path`,{d:y.full,fill:`currentColor`,stroke:`none`,style:{opacity:+!!x,transition:x?`opacity 0.45s ease-out ${(a+i*.72).toFixed(3)}s`:`none`}}),y.contours.map((e,t)=>{let n=T[t]||0,r=i/O*2.4,s=a+t/O*i;return(0,h.jsx)(`path`,{ref:e=>{D.current[t]=e},d:e,fill:`none`,stroke:`currentColor`,strokeWidth:o,strokeLinecap:`round`,strokeLinejoin:`round`,style:{strokeDasharray:n||1,strokeDashoffset:x?0:n||1,transition:x?`stroke-dashoffset ${r.toFixed(3)}s ease-out ${s.toFixed(3)}s`:`none`}},t)})]},p)}var E=`
.cg-footer {
  --pill-bg: #0B120B;
  --pill-bg-hover: #141E14;
  --pill-border: rgba(61, 255, 122, 0.20);
  --pill-border-hover: rgba(61, 255, 122, 0.55);
}

@keyframes cg-footer-breathe {
  0%   { transform: translate(-50%, -50%) scale(1);    opacity: 0.55; }
  100% { transform: translate(-50%, -50%) scale(1.12); opacity: 0.9; }
}
.cg-footer-breathe { animation: cg-footer-breathe 9s ease-in-out infinite alternate; }

@keyframes cg-footer-marquee {
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
}
.cg-footer-marquee { animation: cg-footer-marquee 44s linear infinite; }

.cg-footer-grid {
  background-size: 60px 60px;
  background-image:
    linear-gradient(to right, rgba(61,255,122,0.05) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(61,255,122,0.05) 1px, transparent 1px);
  mask-image: linear-gradient(to bottom, transparent, black 30%, black 70%, transparent);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 30%, black 70%, transparent);
}

.cg-footer-aurora {
  background: radial-gradient(
    circle at 50% 50%,
    rgba(61,255,122,0.16) 0%,
    rgba(44,199,96,0.07) 42%,
    transparent 70%
  );
}

/* Text links, not pills.
   A row of oval chips reads as a toolbar and fights the giant wordmark behind
   it. These are plain words; the only affordance is a neon rule that wipes in
   from the left on hover. background-size is animated rather than width so the
   text never reflows. */
.cg-link {
  position: relative;
  color: var(--color-muted-l);
  background-image: linear-gradient(90deg, var(--color-neon), var(--color-neon));
  background-repeat: no-repeat;
  background-position: 0 100%;
  background-size: 0% 1.5px;
  padding-bottom: 3px;
  transition: color .4s cubic-bezier(.52,.01,0,1),
              background-size .45s cubic-bezier(.52,.01,0,1);
}
.cg-link:hover, .cg-link:focus-visible {
  color: var(--color-neon);
  background-size: 100% 1.5px;
}

/* The oversized wordmark behind everything. Outline only — a filled version at
   this scale competes with the live content sitting on top of it. */
.cg-footer-giant {
  font-size: 24vw;
  line-height: 0.75;
  font-weight: 900;
  letter-spacing: -0.05em;
  color: transparent;
  -webkit-text-stroke: 1px rgba(61,255,122,0.13);
  background: linear-gradient(180deg, rgba(61,255,122,0.09) 0%, transparent 62%);
  -webkit-background-clip: text;
  background-clip: text;
}

.cg-footer-headline {
  background: linear-gradient(180deg, #FFFFFF 0%, var(--color-neon) 128%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 26px rgba(61,255,122,0.18));
}

/* The two real actions. Bordered, solid, no glass. */
.cg-cta {
  background: #0B120B;
  border: 1px solid rgba(61,255,122,0.28);
  transition: background-color .4s cubic-bezier(.52,.01,0,1),
              border-color .4s cubic-bezier(.52,.01,0,1);
}
.cg-cta:hover { background: #141E14; border-color: rgba(61,255,122,0.65); }

.cg-topbtn {
  border: 1px solid rgba(61,255,122,0.22);
  transition: border-color .4s cubic-bezier(.52,.01,0,1), color .4s cubic-bezier(.52,.01,0,1);
}
.cg-topbtn:hover { border-color: rgba(61,255,122,0.6); color: var(--color-neon); }

@media (prefers-reduced-motion: reduce) {
  .cg-footer-breathe, .cg-footer-marquee { animation: none; }
}
`,D=m.forwardRef(({className:e,children:t,as:n=`button`,...r},i)=>{let a=(0,m.useRef)(null);return(0,m.useEffect)(()=>{let e=a.current;if(!e||!window.matchMedia(`(hover: hover)`).matches||window.matchMedia(`(prefers-reduced-motion: reduce)`).matches)return;let t=p.context(()=>{let t=t=>{let n=e.getBoundingClientRect(),r=t.clientX-n.left-n.width/2,i=t.clientY-n.top-n.height/2;p.to(e,{x:r*.22,y:i*.22,scale:1.03,ease:`power3.out`,duration:.45})},n=()=>{p.to(e,{x:0,y:0,scale:1,ease:`power3.out`,duration:.6})};return e.addEventListener(`mousemove`,t),e.addEventListener(`mouseleave`,n),()=>{e.removeEventListener(`mousemove`,t),e.removeEventListener(`mouseleave`,n)}},e);return()=>t.revert()},[]),(0,h.jsx)(n,{ref:e=>{a.current=e,typeof i==`function`?i(e):i&&(i.current=e)},className:l(`cursor-pointer`,e),...r,children:t})});D.displayName=`Magnetic`;function O({route:e}){let t=(0,m.useRef)(null),n=o(),l=a(t,{once:!0,amount:.35}),p=(e=0)=>n===!0?{initial:!1}:{initial:!1,animate:l?{opacity:[0,1],y:[40,0]}:{opacity:1,y:0},transition:{duration:.7,ease:[.52,.01,0,1],delay:e}},g=e===`/for-brands`;return(0,h.jsxs)(h.Fragment,{children:[(0,h.jsx)(`style`,{dangerouslySetInnerHTML:{__html:E}}),(0,h.jsx)(`div`,{ref:t,className:`relative h-screen w-full`,style:{clipPath:`polygon(0% 0, 100% 0%, 100% 100%, 0 100%)`},children:(0,h.jsxs)(`footer`,{className:`cg-footer fixed bottom-0 left-0 flex h-screen w-full flex-col justify-between overflow-hidden bg-background text-text-c`,children:[(0,h.jsx)(`div`,{"aria-hidden":`true`,className:`cg-footer-aurora cg-footer-breathe pointer-events-none absolute left-1/2 top-1/2 z-0 h-[60vh] w-[80vw] rounded-[50%] blur-[90px]`}),(0,h.jsx)(`div`,{"aria-hidden":`true`,className:`cg-footer-grid pointer-events-none absolute inset-0 z-0`}),(0,h.jsx)(r.div,{"aria-hidden":`true`,...p(),className:`cg-footer-giant pointer-events-none absolute -bottom-[4vh] left-1/2 z-0 -translate-x-1/2 select-none whitespace-nowrap`,children:`CLIPGROW`}),(0,h.jsx)(`div`,{className:`absolute left-0 top-6 z-10 w-full md:top-10`,children:(0,h.jsx)(i,{items:c,variant:`outline`,speed:.6,single:!0})}),(0,h.jsxs)(`div`,{className:`relative z-10 mx-auto mt-24 flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-6`,children:[(0,h.jsxs)(r.h2,{...p(.06),className:`mb-12 flex flex-wrap items-baseline justify-center gap-x-4 text-center font-display text-[12vw] font-black leading-[0.95] tracking-[-0.03em] sm:text-6xl md:text-[6.5rem] lg:text-[7.5rem]`,children:[(0,h.jsx)(`span`,{className:`cg-footer-headline`,children:g?`Ready to get `:`Ready to start `}),(0,h.jsx)(T,{words:g?[`seen.`,`clipped.`,`everywhere.`,`winning.`,`growing.`]:[`clipping.`,`earning.`,`posting.`,`winning.`,`grinding.`,`stacking.`,`pumping.`,`growing.`],className:`text-neon`,height:`0.92em`,duration:1.12,strokeWidth:1.5,interval:2650})]}),(0,h.jsxs)(r.div,{...p(.14),className:`flex w-full flex-col items-center gap-5`,children:[(0,h.jsxs)(`div`,{className:`flex w-full flex-wrap justify-center gap-4`,children:[(0,h.jsxs)(D,{as:`a`,href:s.discord,target:`_blank`,rel:`noopener noreferrer`,className:`cg-cta group flex items-center gap-3 rounded-full px-9 py-4 font-display text-base font-bold text-white-c md:text-lg`,children:[(0,h.jsx)(d,{className:`h-5 w-5 text-neon`}),`Join as a clipper`]}),(0,h.jsxs)(D,{as:`a`,href:s.brandWhatsapp,target:`_blank`,rel:`noopener noreferrer`,className:`cg-cta group flex items-center gap-3 rounded-full px-9 py-4 font-display text-base font-bold text-white-c md:text-lg`,children:[(0,h.jsx)(u,{className:`h-5 w-5 text-neon`}),`Talk to us about a campaign`]})]}),(0,h.jsxs)(`div`,{className:`mt-1 flex w-full flex-wrap justify-center gap-2.5 md:gap-4`,children:[e!==`/for-clippers`&&(0,h.jsx)(f,{to:`/for-clippers`,className:`cg-link text-[0.82rem] font-medium md:text-[0.9rem]`,children:`For clippers`}),e!==`/for-brands`&&(0,h.jsx)(f,{to:`/for-brands`,className:`cg-link text-[0.82rem] font-medium md:text-[0.9rem]`,children:`For brands`}),[{href:s.guides,label:`Guides`},{href:s.clipperLogin,label:`Clipper log in`},{href:s.clientLogin,label:`Client log in`},{href:s.privacy,label:`Privacy`},{href:s.terms,label:`Terms`},{href:s.dataDeletion,label:`Data deletion`}].map(e=>(0,h.jsx)(`a`,{href:e.href,className:`cg-link text-[0.82rem] font-medium md:text-[0.9rem]`,children:e.label},e.label))]})]})]}),(0,h.jsxs)(`div`,{className:`relative z-20 flex w-full flex-col items-center justify-between gap-5 px-6 pb-8 md:flex-row md:px-12`,children:[(0,h.jsxs)(`div`,{className:`order-2 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-c md:order-1 md:text-[0.7rem]`,children:[`© `,new Date().getFullYear(),` ClipGrow · Kerala, India`]}),(0,h.jsxs)(`a`,{href:`tel:${s.phone.replace(/\s/g,``)}`,className:`order-1 flex items-center gap-2 md:order-2`,children:[(0,h.jsx)(`span`,{className:`pulse-dot h-1.5 w-1.5 rounded-full bg-neon`}),(0,h.jsx)(`span`,{className:`font-display text-[0.72rem] font-bold text-white-c md:text-[0.8rem]`,children:s.phone})]}),(0,h.jsx)(D,{as:`button`,type:`button`,"aria-label":`Back to top`,onClick:()=>window.scrollTo({top:0,behavior:`smooth`}),className:`cg-topbtn group order-3 flex h-11 w-11 items-center justify-center rounded-full text-muted-l`,children:(0,h.jsx)(`svg`,{className:`h-5 w-5 transition-transform duration-300 group-hover:-translate-y-1`,fill:`none`,stroke:`currentColor`,viewBox:`0 0 24 24`,"aria-hidden":`true`,children:(0,h.jsx)(`path`,{strokeLinecap:`round`,strokeLinejoin:`round`,strokeWidth:`2`,d:`M5 10l7-7m0 0l7 7m-7-7v18`})})})]})]})})]})}export{O as CinematicFooter};