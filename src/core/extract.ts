import { chromium, type Browser, type Page } from "playwright";
import type {
  ExtractionResult,
  DesignTokens,
  SectionInfo,
  AssetRef,
} from "./types.js";

const DESKTOP = { width: 1440, height: 900 };

export interface ExtractOptions {
  timeoutMs?: number;
  onStep?: (msg: string) => void;
}

export async function extractSite(
  url: string,
  opts: ExtractOptions = {}
): Promise<ExtractionResult> {
  const step = opts.onStep ?? (() => {});
  const timeout = opts.timeoutMs ?? 60000;

  let browser: Browser | null = null;
  try {
    step("Launching headless browser");
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    });
    const page = await ctx.newPage();

    step("Navigating to " + url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await page.waitForTimeout(2500);

    step("Triggering lazy content (full-page scroll)");
    await triggerLazyLoad(page);

    step("Extracting design tokens");
    const tokens = (await page.evaluate(tokenScript)) as DesignTokens;

    step("Mapping page topology");
    const sections = (await page.evaluate(topologyScript)) as SectionInfo[];

    step("Discovering assets");
    const assets = (await page.evaluate(assetScript)) as AssetRef[];

    step("Capturing desktop screenshot (1440)");
    let shotDesktop = "";
    let shotMobile = "";
    try {
      const buf = await page.screenshot({ fullPage: true, type: "jpeg", quality: 60 });
      shotDesktop = "data:image/jpeg;base64," + buf.toString("base64");
    } catch { /* screenshots are best-effort */ }
    try {
      step("Capturing mobile screenshot (390)");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(600);
      const bufm = await page.screenshot({ fullPage: true, type: "jpeg", quality: 55 });
      shotMobile = "data:image/jpeg;base64," + bufm.toString("base64");
      await page.setViewportSize(DESKTOP);
      await page.waitForTimeout(300);
    } catch { /* best-effort */ }

    step("Detecting smooth-scroll & metadata");
    const meta = (await page.evaluate(metaScript)) as {
      title: string; description: string; lang: string; pageHeight: number;
      videoCount: number; smoothScroll: { lenis: boolean; locomotive: boolean; scrollSnap: boolean };
      navLinks: { text: string; href: string }[];
    };

    const result: ExtractionResult = {
      url,
      finalUrl: page.url(),
      title: meta.title,
      description: meta.description,
      lang: meta.lang,
      viewport: DESKTOP,
      pageHeight: meta.pageHeight,
      tokens,
      sections,
      assets,
      smoothScroll: meta.smoothScroll,
      videoCount: meta.videoCount,
      navLinks: meta.navLinks,
      extractedAt: new Date().toISOString(),
      screenshots: { desktop: shotDesktop || undefined, mobile: shotMobile || undefined },
    };
    return result;
  } finally {
    if (browser) await browser.close();
  }
}

export interface ExtractHtmlOptions {
  onStep?: (msg: string) => void;
  baseUrl?: string;
  label?: string;
}

/** Extract design tokens from a raw HTML string (uploaded file or fetched page source). */
export async function extractHtml(
  html: string,
  opts: ExtractHtmlOptions = {}
): Promise<ExtractionResult> {
  const step = opts.onStep ?? (() => {});
  let browser: Browser | null = null;
  try {
    step("Launching headless browser");
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();

    let prepared = html;
    if (opts.baseUrl && !/<base\s/i.test(prepared)) {
      prepared = prepared.replace(/<head([^>]*)>/i, '<head$1><base href="' + opts.baseUrl + '">');
    }

    step("Rendering HTML in headless browser");
    await page.setContent(prepared, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);

    step("Extracting design tokens");
    const tokens = (await page.evaluate(tokenScript)) as DesignTokens;
    step("Mapping document topology");
    const sections = (await page.evaluate(topologyScript)) as SectionInfo[];
    step("Discovering assets");
    const assets = (await page.evaluate(assetScript)) as AssetRef[];
    step("Detecting metadata");
    const meta = (await page.evaluate(metaScript)) as {
      title: string; description: string; lang: string; pageHeight: number;
      videoCount: number; smoothScroll: { lenis: boolean; locomotive: boolean; scrollSnap: boolean };
      navLinks: { text: string; href: string }[];
    };

    const label = opts.label || meta.title || "uploaded.html";
    const result: ExtractionResult = {
      url: opts.baseUrl || label,
      finalUrl: opts.baseUrl || label,
      title: meta.title || label,
      description: meta.description,
      lang: meta.lang,
      viewport: DESKTOP,
      pageHeight: meta.pageHeight,
      tokens,
      sections,
      assets,
      smoothScroll: meta.smoothScroll,
      videoCount: meta.videoCount,
      navLinks: meta.navLinks,
      extractedAt: new Date().toISOString(),
    };
    return result;
  } finally {
    if (browser) await browser.close();
  }
}

async function triggerLazyLoad(page: Page) {
  await page.evaluate(async () => {
    const total = document.body.scrollHeight;
    const stepY = window.innerHeight / 2;
    for (let y = 0; y < total; y += stepY) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 300));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  });
}

// ---- in-page extraction scripts (run inside the headless browser) ----

function tokenScript(): unknown {
  const cs = getComputedStyle(document.body);
  const els = Array.from(document.querySelectorAll("*")).slice(0, 1200);
  const colorSet: Record<string, number> = {};
  const radiiSet: Record<string, number> = {};
  const shadowSet: Record<string, number> = {};
  els.forEach((e) => {
    const s = getComputedStyle(e as Element);
    [s.color, s.backgroundColor].forEach((c) => {
      if (c && c !== "rgba(0, 0, 0, 0)") colorSet[c] = (colorSet[c] || 0) + 1;
    });
    if (s.borderRadius && s.borderRadius !== "0px")
      radiiSet[s.borderRadius] = (radiiSet[s.borderRadius] || 0) + 1;
    if (s.boxShadow && s.boxShadow !== "none")
      shadowSet[s.boxShadow] = (shadowSet[s.boxShadow] || 0) + 1;
  });
  const top = (o: Record<string, number>, n: number) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);

  const fontFamilies = Array.from(
    new Set(
      Array.from(
        document.querySelectorAll("h1,h2,h3,h4,p,a,span,button,div")
      )
        .slice(0, 400)
        .map((e) => getComputedStyle(e as Element).fontFamily)
    )
  );

  const googleFonts = Array.from(
    document.querySelectorAll('link[href*="fonts.googleapis"]')
  ).map((l) => (l as HTMLLinkElement).href);

  let fontFaces: { family: string; src?: string; weight?: string; style?: string }[] = [];
  try {
    fontFaces = Array.from(document.styleSheets).flatMap((sheet) => {
      try {
        return Array.from((sheet as CSSStyleSheet).cssRules)
          .filter((r) => r.constructor.name === "CSSFontFaceRule")
          .map((r) => {
            const st = (r as CSSFontFaceRule).style;
            return {
              family: st.getPropertyValue("font-family"),
              src: st.getPropertyValue("src"),
              weight: st.getPropertyValue("font-weight"),
              style: st.getPropertyValue("font-style"),
            };
          });
      } catch {
        return [];
      }
    });
  } catch {
    fontFaces = [];
  }

  const headingSizes = Array.from(document.querySelectorAll("h1,h2,h3"))
    .slice(0, 8)
    .map((e) => {
      const s = getComputedStyle(e as Element);
      return {
        sample: (e as HTMLElement).innerText.trim().slice(0, 30),
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
      };
    });

  return {
    bodyBackground: cs.backgroundColor,
    bodyColor: cs.color,
    fontFamilies,
    googleFonts,
    fontFaces,
    palette: top(colorSet, 18).map(([color, count]) => ({ color, count })),
    radii: top(radiiSet, 6).map(([r]) => r),
    shadows: top(shadowSet, 5).map(([s]) => s),
    headingSizes,
  };
}

function topologyScript(): unknown {
  function pick(node: Element): Element[] {
    const tall = Array.from(node.children).filter(
      (c) => c.getBoundingClientRect().height > 200
    );
    return tall;
  }
  let node: Element = document.body;
  for (let i = 0; i < 8; i++) {
    const tall = pick(node);
    if (tall.length >= 3) break;
    if (tall.length >= 1) {
      node = tall.sort(
        (a, b) =>
          b.getBoundingClientRect().height - a.getBoundingClientRect().height
      )[0];
    } else break;
  }
  const children = pick(node);
  return children.slice(0, 30).map((c, index) => {
    const r = c.getBoundingClientRect();
    const s = getComputedStyle(c);
    const layout =
      s.display.includes("grid")
        ? "grid"
        : s.display.includes("flex")
        ? "flex"
        : "block";
    const cls = (c.className?.toString?.() || "").toLowerCase();
    const interaction = /pin|sticky|scroll/.test(cls)
      ? "scroll"
      : c.querySelector("button,[role=tab]")
      ? "click"
      : "static";
    const colCount = layout === "grid"
      ? (s.gridTemplateColumns ? s.gridTemplateColumns.split(" ").filter(Boolean).length : 0)
      : layout === "flex"
      ? Array.from(c.children).filter((ch) => (ch as HTMLElement).getBoundingClientRect().width > 40).length
      : 0;
    const stateLabels = Array.from(c.querySelectorAll('[role=tab],.tab,.pill,[data-tab]'))
      .map((t) => ((t as HTMLElement).innerText || "").replace(/\s+/g, " ").trim())
      .filter(Boolean).slice(0, 8);
    return {
      index,
      name: c.id || cls.split(" ")[0] || c.tagName.toLowerCase() + "-" + index,
      tag: c.tagName.toLowerCase(),
      top: Math.round(r.top + window.scrollY),
      height: Math.round(r.height),
      textPreview: ((c as HTMLElement).innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 90),
      layout,
      interaction,
      display: s.display,
      gridTemplateColumns: layout === "grid" ? s.gridTemplateColumns : undefined,
      flexDirection: layout === "flex" ? s.flexDirection : undefined,
      columnCount: colCount || undefined,
      gap: (s.gap && s.gap !== "normal") ? s.gap : undefined,
      paddingPx: s.padding,
      background: (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") ? s.backgroundColor : ((s.backgroundImage && s.backgroundImage !== "none") ? "image" : undefined),
      imageCount: c.querySelectorAll("img,video,svg").length || undefined,
      states: stateLabels.length ? stateLabels : undefined,
    };
  });
}

function assetScript(): unknown {
  const out: AssetRef[] = [];
  document.querySelectorAll("img").forEach((img) => {
    const src = (img as HTMLImageElement).currentSrc || img.src;
    if (src && !src.startsWith("data:"))
      out.push({
        src,
        alt: img.alt,
        width: img.naturalWidth,
        height: img.naturalHeight,
        kind: "image",
      });
  });
  document.querySelectorAll("video").forEach((v) => {
    const src = v.src || v.querySelector("source")?.src || "";
    if (src) out.push({ src, kind: "video" });
  });
  Array.from(document.querySelectorAll("*"))
    .slice(0, 1000)
    .forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== "none" && bg.includes("url(")) {
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1] && !m[1].startsWith("data:"))
          out.push({ src: m[1], kind: "background" });
      }
    });
  document
    .querySelectorAll('link[rel*="icon"],link[rel="apple-touch-icon"]')
    .forEach((l) => {
      const href = (l as HTMLLinkElement).href;
      if (href) out.push({ src: href, kind: "favicon" });
    });
  // dedupe by src
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.src) ? false : (seen.add(a.src), true)));
}

function metaScript(): unknown {
  const header = document.querySelector("header,nav");
  const navLinks = header
    ? Array.from(header.querySelectorAll("a"))
        .map((a) => ({
          text: (a as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
          href: (a as HTMLAnchorElement).getAttribute("href") || "",
        }))
        .filter((x) => x.text)
        .slice(0, 20)
    : [];
  return {
    title: document.title,
    description:
      document
        .querySelector('meta[name="description"]')
        ?.getAttribute("content") || "",
    lang: document.documentElement.lang || "",
    pageHeight: document.body.scrollHeight,
    videoCount: document.querySelectorAll("video").length,
    smoothScroll: {
      lenis: !!document.querySelector(".lenis,[data-lenis]"),
      locomotive: !!document.querySelector(
        ".locomotive-scroll,[data-scroll-container]"
      ),
      scrollSnap: getComputedStyle(document.documentElement).scrollSnapType !== "none" ||
        getComputedStyle(document.body).scrollSnapType !== "none",
    },
    navLinks,
  };
}
