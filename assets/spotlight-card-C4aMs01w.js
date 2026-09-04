import{n as e}from"./rolldown-runtime-CbXtAM7H.js";import{it as t,rt as n,t as r}from"./motion-B4gWODd4.js";import{t as i}from"./use-in-view-Curvvogc.js";import{_ as a,g as o}from"./index-B89CU_zB.js";var s=e(t(),1),c=n(),l=[.52,.01,0,1],u=(e=.85,t=0)=>({duration:e,delay:t,ease:l}),d={rise:{hidden:{opacity:0,y:34},shown:{opacity:1,y:0}},slideLeft:{hidden:{opacity:0,x:-64},shown:{opacity:1,x:0}},slideRight:{hidden:{opacity:0,x:64},shown:{opacity:1,x:0}},scaleIn:{hidden:{opacity:0,scale:.88},shown:{opacity:1,scale:1}},drop:{hidden:{opacity:0,y:-40},shown:{opacity:1,y:0}},tilt:{hidden:{opacity:0,y:46,rotateX:-14},shown:{opacity:1,y:0,rotateX:0}},push:{hidden:{opacity:0,scale:1.08,filter:`blur(6px)`},shown:{opacity:1,scale:1,filter:`blur(0px)`}},wipe:{hidden:{opacity:0,clipPath:`inset(0 100% 0 0)`},shown:{opacity:1,clipPath:`inset(0 0% 0 0)`}}},f=[`rise`,`slideLeft`,`scaleIn`,`wipe`,`slideRight`,`tilt`,`push`,`drop`],p=e=>f[e%f.length];function m({children:e,className:t,entrance:n=`rise`,delay:o=0,duration:l=.85,repeat:f=!1,amount:p=.25,as:m=`div`}){let h=(0,s.useRef)(null),g=a(),_=i(h,{once:!f,amount:p}),v=r[m]??r.div,y=g?{hidden:{opacity:0},shown:{opacity:1}}:d[n];return(0,c.jsx)(v,{ref:h,className:t,variants:y,initial:`hidden`,animate:_?`shown`:`hidden`,transition:u(g?.4:l,o),style:n===`tilt`?{perspective:900}:void 0,children:e})}function h({text:e,className:t,stagger:n=.055,delay:l=0,as:d=`span`,accent:f=[]}){let p=(0,s.useRef)(null),m=a(),h=i(p,{once:!0,amount:.4}),g=r[d]??r.span,_=e.split(` `),v=new Set(f.map(e=>e.toLowerCase()));return m?(0,c.jsx)(g,{ref:p,className:t,initial:{opacity:0},animate:h?{opacity:1}:{opacity:0},transition:u(.4,l),children:e}):(0,c.jsx)(g,{ref:p,className:t,initial:`hidden`,animate:h?`shown`:`hidden`,transition:{staggerChildren:n,delayChildren:l},"aria-label":e,children:_.map((e,t)=>(0,c.jsxs)(`span`,{className:`inline-block align-bottom`,"aria-hidden":`true`,children:[(0,c.jsx)(r.span,{className:o(`inline-block`,v.has(e.toLowerCase().replace(/[.,]/g,``))&&`text-neon`),variants:{hidden:{opacity:0,y:`0.7em`,filter:`blur(5px)`},shown:{opacity:1,y:`0em`,filter:`blur(0px)`}},transition:u(.7),children:e}),t<_.length-1&&(0,c.jsx)(`span`,{className:`inline-block`,children:`\xA0`})]},`${e}-${t}`))})}function g({children:e,className:t,stagger:n=.09,delay:a=0,amount:o=.15}){let l=(0,s.useRef)(null),u=i(l,{once:!0,amount:o});return(0,c.jsx)(r.div,{ref:l,className:t,initial:`hidden`,animate:u?`shown`:`hidden`,variants:{hidden:{},shown:{transition:{staggerChildren:n,delayChildren:a}}},children:e})}function _({children:e,className:t,entrance:n=`rise`,duration:i=.8}){let o=a(),s=o?{hidden:{opacity:0},shown:{opacity:1}}:d[n];return(0,c.jsx)(r.div,{className:t,variants:s,transition:u(o?.4:i),style:n===`tilt`?{perspective:900}:void 0,children:e})}var v={neon:{base:138,spread:46},teal:{base:168,spread:40},gold:{base:46,spread:34},violet:{base:268,spread:40},ember:{base:22,spread:34}},y={sm:`w-48 h-64`,md:`w-64 h-80`,lg:`w-80 h-96`},b=!1;function x(){if(b)return;b=!0;let e=document.createElement(`style`);e.setAttribute(`data-glow-styles`,``),e.textContent=S,document.head.appendChild(e);let t=document.documentElement,n=0,r=0,i=0,a=()=>{t.style.setProperty(`--x`,r.toFixed(2)),t.style.setProperty(`--xp`,(r/window.innerWidth).toFixed(3)),t.style.setProperty(`--y`,i.toFixed(2)),t.style.setProperty(`--yp`,(i/window.innerHeight).toFixed(3))};document.addEventListener(`pointermove`,e=>{r=e.clientX,i=e.clientY,cancelAnimationFrame(n),n=requestAnimationFrame(a)},{passive:!0})}var S=`
  [data-glow] {
    --border-size: calc(var(--border, 2) * 1px);
    --spotlight-size: calc(var(--size, 200) * 1px);
    --hue: calc(var(--base) + (var(--xp, 0) * var(--spread, 0)));
  }

  [data-glow]::before,
  [data-glow]::after {
    pointer-events: none;
    content: "";
    position: absolute;
    inset: calc(var(--border-size) * -1);
    border: var(--border-size) solid transparent;
    border-radius: inherit;
    background-attachment: fixed;
    background-size: calc(100% + (2 * var(--border-size))) calc(100% + (2 * var(--border-size)));
    background-repeat: no-repeat;
    background-position: 50% 50%;
    mask: linear-gradient(transparent, transparent), linear-gradient(white, white);
    mask-clip: padding-box, border-box;
    mask-composite: intersect;
  }

  /* The lit edge */
  [data-glow]::before {
    background-image: radial-gradient(
      calc(var(--spotlight-size) * 0.75) calc(var(--spotlight-size) * 0.75) at
      calc(var(--x, 0) * 1px) calc(var(--y, 0) * 1px),
      hsl(var(--hue, 138) calc(var(--saturation, 100) * 1%) calc(var(--lightness, 58) * 1%) / var(--border-spot-opacity, 1)),
      transparent 100%
    );
    filter: brightness(1.6);
  }

  /* The white-hot core of the edge */
  [data-glow]::after {
    background-image: radial-gradient(
      calc(var(--spotlight-size) * 0.5) calc(var(--spotlight-size) * 0.5) at
      calc(var(--x, 0) * 1px) calc(var(--y, 0) * 1px),
      hsl(0 0% 100% / var(--border-light-opacity, 0.7)),
      transparent 100%
    );
  }

  /* Nested [data-glow] is the outer bloom */
  [data-glow] [data-glow] {
    position: absolute;
    inset: 0;
    will-change: filter;
    opacity: var(--outer, 1);
    border-radius: inherit;
    border-width: calc(var(--border-size) * 20);
    filter: blur(calc(var(--border-size) * 10));
    background: none;
    pointer-events: none;
    border: none;
  }

  [data-glow] > [data-glow]::before {
    inset: -10px;
    border-width: 10px;
  }

  /* A card that isn't being pointed at shouldn't glow at all. */
  @media (prefers-reduced-motion: reduce) {
    [data-glow]::before,
    [data-glow]::after { transition: none; }
  }
`;function C(){(0,s.useEffect)(()=>{x()},[])}var w=5.5;function T(e){let t=(0,s.useRef)(null);return(0,s.useEffect)(()=>{let n=t.current;if(!n||!e||window.matchMedia(`(prefers-reduced-motion: reduce)`).matches||!window.matchMedia(`(hover: hover)`).matches)return;let r=0,i=!1,a=(e,t,r)=>{n.style.transform=`perspective(1100px) rotateX(${e.toFixed(2)}deg) rotateY(${t.toFixed(2)}deg) translateZ(${r}px)`},o=e=>{i&&(cancelAnimationFrame(r),r=requestAnimationFrame(()=>{let t=n.getBoundingClientRect(),r=(e.clientX-t.left)/t.width-.5,i=(e.clientY-t.top)/t.height-.5;a(-i*w*2,r*w*2,6)}))},s=()=>{i=!0,n.style.transition=`transform 140ms cubic-bezier(0.52,0.01,0,1)`,window.addEventListener(`pointermove`,o,{passive:!0})},c=()=>{i=!1,cancelAnimationFrame(r),window.removeEventListener(`pointermove`,o),n.style.transition=`transform 520ms cubic-bezier(0.52,0.01,0,1)`,a(0,0,0)};return n.addEventListener(`pointerenter`,s),n.addEventListener(`pointerleave`,c),()=>{n.removeEventListener(`pointerenter`,s),n.removeEventListener(`pointerleave`,c),window.removeEventListener(`pointermove`,o),cancelAnimationFrame(r)}},[e]),t}var E=({children:e,className:t=``,glowColor:n=`neon`,size:r=`md`,width:i,height:a,customSize:o=!1,subtle:s=!1,tilt:l=!0,as:u=`div`})=>{C();let d=T(l),{base:f,spread:p}=v[n],m={"--base":f,"--spread":p,"--border":s?1:2,"--size":s?160:220,"--outer":s?.5:1,"--bg-spot-opacity":s?.06:.11,"--border-spot-opacity":s?.7:1,"--border-light-opacity":s?.4:.7,"--backdrop":`var(--color-card-h)`,backgroundImage:`radial-gradient(
        var(--spotlight-size) var(--spotlight-size) at
        calc(var(--x, 0) * 1px) calc(var(--y, 0) * 1px),
        hsl(var(--hue, 138) calc(var(--saturation, 100) * 1%) calc(var(--lightness, 70) * 1%) / var(--bg-spot-opacity)),
        transparent
      ),
      linear-gradient(160deg, #182418 0%, #101A10 55%, #0C140C 100%)`,backgroundColor:`var(--backdrop)`,backgroundSize:`calc(100% + (2 * var(--border-size))) calc(100% + (2 * var(--border-size))), 100% 100%`,backgroundPosition:`50% 50%, 0 0`,backgroundAttachment:`fixed, scroll`,border:`var(--border-size) solid var(--color-border-s)`,boxShadow:`0 1px 0 0 rgba(255,255,255,0.04) inset, 0 18px 40px -24px rgba(0,0,0,0.9)`,position:`relative`,...i!==void 0&&{width:typeof i==`number`?`${i}px`:i},...a!==void 0&&{height:typeof a==`number`?`${a}px`:a}};return(0,c.jsxs)(u,{ref:d,"data-glow":!0,style:m,className:[o?``:y[r],`rounded-2xl relative transform-gpu [transform-style:preserve-3d] transition-colors duration-300`,t].filter(Boolean).join(` `),children:[(0,c.jsx)(`div`,{"data-glow":!0,"aria-hidden":`true`}),e]})};export{_ as a,g as i,l as n,h as o,m as r,p as s,E as t};