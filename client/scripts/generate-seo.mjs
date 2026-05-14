import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const seo = {
  siteUrl: "https://asteroids.trebeljahr.com",
  outputDir: path.resolve(__dirname, "../public"),
  routes: [{ path: "/", changefreq: "monthly", priority: "1.0" }],
  lastmod: (process.env.SITEMAP_LASTMOD || new Date().toISOString()).slice(0, 10),
  title: "Asteroids",
  subtitle: "Arcade Space Shooter",
  description:
    "Play a fast browser asteroid shooter with race courses, ship upgrades, achievements, and multiplayer space battles.",
  imageAlt: "Asteroids arcade space shooter preview",
};

const escapeXml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const joinUrl = (base, urlPath) => {
  const cleanBase = base.replace(/\/$/, "");
  const cleanPath = urlPath === "/" ? "/" : `/${urlPath.replace(/^\/+/, "")}`;
  return `${cleanBase}${cleanPath}`;
};

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${seo.routes
  .map(
    (route) => `  <url>
    <loc>${escapeXml(joinUrl(seo.siteUrl, route.path))}</loc>
    <lastmod>${seo.lastmod}</lastmod>
    <changefreq>${route.changefreq}</changefreq>
    <priority>${route.priority}</priority>
  </url>`,
  )
  .join("\n")}
</urlset>
`;

const robots = `User-agent: *
Allow: /

Sitemap: ${joinUrl(seo.siteUrl, "/sitemap.xml")}
`;

const ogImage = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(seo.title)} - ${escapeXml(seo.subtitle)}</title>
  <desc id="desc">${escapeXml(seo.imageAlt)}</desc>
  <defs>
    <radialGradient id="space" cx="50%" cy="48%" r="72%">
      <stop offset="0" stop-color="#12335c" />
      <stop offset="0.55" stop-color="#061426" />
      <stop offset="1" stop-color="#010611" />
    </radialGradient>
    <linearGradient id="ship" x1="0" x2="1">
      <stop offset="0" stop-color="#7dd3fc" />
      <stop offset="1" stop-color="#fb923c" />
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="8" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#space)" />
  <g fill="#e0f2fe" opacity="0.8">
    <circle cx="96" cy="88" r="2" />
    <circle cx="184" cy="220" r="1.5" />
    <circle cx="330" cy="70" r="2.5" />
    <circle cx="516" cy="156" r="1.5" />
    <circle cx="670" cy="82" r="2" />
    <circle cx="982" cy="116" r="2.5" />
    <circle cx="1088" cy="286" r="1.6" />
    <circle cx="914" cy="512" r="2.1" />
    <circle cx="118" cy="520" r="2.2" />
  </g>
  <g opacity="0.22" stroke="#7dd3fc" stroke-width="2" fill="none">
    <circle cx="930" cy="248" r="118" />
    <circle cx="930" cy="248" r="188" />
    <path d="M80 360 C250 300 340 430 510 354 S790 206 1110 354" />
  </g>
  <g transform="translate(718 206) rotate(12)" filter="url(#glow)">
    <path d="M0 112 L235 0 L178 116 L235 232 Z" fill="url(#ship)" />
    <path d="M28 112 L170 54 L135 112 L170 178 Z" fill="#061426" opacity="0.72" />
    <path d="M-74 112 C-8 84 26 92 28 112 C26 132 -8 140 -74 112Z" fill="#f97316" opacity="0.9" />
    <path d="M-124 112 C-54 90 -18 96 -8 112 C-18 128 -54 134 -124 112Z" fill="#facc15" opacity="0.65" />
  </g>
  <g fill="#64748b" stroke="#cbd5e1" stroke-width="7">
    <path d="M162 132 l52 16 18 46 -38 38 -54 -18 -16 -52Z" />
    <path d="M214 436 l78 -32 68 48 -20 78 -82 18 -58 -50Z" />
    <path d="M1014 418 l52 -20 48 28 6 58 -42 38 -62 -14 -22 -46Z" />
  </g>
  <text x="82" y="248" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="92" font-weight="900">Asteroids</text>
  <text x="88" y="320" fill="#bae6fd" font-family="Inter, Arial, sans-serif" font-size="38" font-weight="700">Arcade Space Shooter</text>
  <text x="88" y="394" fill="#e0f2fe" font-family="Inter, Arial, sans-serif" font-size="27">Race courses, upgrades, achievements,</text>
  <text x="88" y="432" fill="#e0f2fe" font-family="Inter, Arial, sans-serif" font-size="27">and multiplayer space battles.</text>
</svg>
`;

await mkdir(seo.outputDir, { recursive: true });
await Promise.all([
  writeFile(path.join(seo.outputDir, "sitemap.xml"), sitemap),
  writeFile(path.join(seo.outputDir, "robots.txt"), robots),
  writeFile(path.join(seo.outputDir, "og-image.svg"), ogImage),
]);
