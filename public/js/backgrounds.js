/**
 * 背景预设。css 值为 background-image 可直接赋给 .bg-layer
 * 需要纯 CSS 渐变 / SVG data-uri 图案，避免外部依赖。
 */
const svg = (inner, w = 1200, h = 800) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${inner}</svg>`
  )}")`;

export const BACKGROUNDS = [
  {
    id: 'cockpit',
    name: '驾驶舱',
    // 与「驾驶舱」主题配套：深海军蓝底 + 细网格 + 顶部青蓝辉光
    css: `radial-gradient(1400px 700px at 50% -14%, rgba(4, 132, 186, 0.30), transparent 62%), radial-gradient(1000px 760px at 4% 108%, rgba(4, 110, 160, 0.24), transparent 60%), radial-gradient(1000px 760px at 97% 104%, rgba(6, 150, 190, 0.20), transparent 60%), linear-gradient(rgba(90, 180, 255, .05) 1px, transparent 1px) 0 0 / 48px 48px, linear-gradient(90deg, rgba(90, 180, 255, .05) 1px, transparent 1px) 0 0 / 48px 48px, linear-gradient(180deg, #05101f 0%, #061524 55%, #04101c 100%)`,
  },
  {
    id: 'midnight',
    name: '午夜',
    css: 'radial-gradient(1200px 700px at 15% -10%, #1c2a52 0%, transparent 60%), radial-gradient(900px 600px at 90% 110%, #3b1d4e 0%, transparent 62%), linear-gradient(160deg, #0b0e17 0%, #111421 55%, #0a0c14 100%)',
  },
  {
    id: 'aurora',
    name: '极光',
    css: 'radial-gradient(900px 500px at 10% 10%, rgba(34,197,94,.35) 0%, transparent 60%), radial-gradient(800px 520px at 85% 20%, rgba(59,130,246,.35) 0%, transparent 62%), radial-gradient(900px 600px at 60% 100%, rgba(168,85,247,.32) 0%, transparent 65%), linear-gradient(180deg, #05070d, #0b1220)',
  },
  {
    id: 'sunset',
    name: '晚霞',
    css: 'radial-gradient(1000px 600px at 80% 0%, rgba(251,146,60,.42) 0%, transparent 58%), radial-gradient(900px 620px at 10% 100%, rgba(244,63,94,.34) 0%, transparent 60%), linear-gradient(180deg, #1a1024, #2a1428 60%, #100a16)',
  },
  {
    id: 'grid',
    name: '网格',
    css: `linear-gradient(rgba(255,255,255,.055) 1px, transparent 1px) 0 0 / 34px 34px, linear-gradient(90deg, rgba(255,255,255,.055) 1px, transparent 1px) 0 0 / 34px 34px, radial-gradient(900px 600px at 50% 0%, #16203a 0%, transparent 65%), #0a0d15`,
  },
  {
    id: 'dots',
    name: '圆点',
    css: `radial-gradient(rgba(255,255,255,.09) 1.4px, transparent 1.4px) 0 0 / 22px 22px, linear-gradient(160deg, #0d1018, #141a2a)`,
  },
  {
    id: 'topo',
    name: '等高线',
    // SVG 有固有尺寸（1200x800），简写里必须显式给尺寸与不重复，否则会平铺而不铺满
    css: `${svg(
      `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#0d1220'/><stop offset='1' stop-color='#181c33'/></linearGradient></defs>
       <rect width='1200' height='800' fill='url(#g)'/>
       ${Array.from({ length: 14 }, (_, i) => {
         const y = 40 + i * 56;
         const d = `M0,${y} C 240,${y - 55} 420,${y + 55} 660,${y - 20} S 1040,${y + 60} 1200,${y - 30}`;
         return `<path d='${d}' fill='none' stroke='rgba(120,170,255,${0.05 + (i % 4) * 0.028})' stroke-width='1.2'/>`;
       }).join('')}`
    )} center / cover no-repeat`,
  },
  {
    id: 'paper',
    name: '纸纹',
    css: `linear-gradient(180deg, rgba(255,255,255,.04), rgba(0,0,0,.22)), repeating-linear-gradient(90deg, rgba(255,255,255,.022) 0 1px, transparent 1px 44px), repeating-linear-gradient(0deg, rgba(255,255,255,.022) 0 1px, transparent 1px 44px), #12141c`,
  },
  {
    id: 'mesh',
    name: '光斑',
    css: 'radial-gradient(600px 420px at 20% 30%, rgba(79,140,255,.4), transparent 60%), radial-gradient(520px 420px at 75% 25%, rgba(139,92,246,.36), transparent 62%), radial-gradient(620px 460px at 45% 90%, rgba(14,165,233,.32), transparent 64%), #080a11',
  },
  {
    id: 'plain',
    name: '纯色',
    css: 'none',
  },
];

export const getBackground = (id) => BACKGROUNDS.find((b) => b.id === id) || null;
