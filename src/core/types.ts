export interface AssetRef {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
  kind: "image" | "video" | "background" | "font" | "favicon" | "logo";
}

export interface SectionInfo {
  index: number;
  name: string;
  tag: string;
  top: number;
  height: number;
  textPreview: string;
  layout: string; // grid | flex | block
  interaction: string; // static | scroll | click | hover | time
}

export interface DesignTokens {
  bodyBackground: string;
  bodyColor: string;
  fontFamilies: string[];
  googleFonts: string[];
  fontFaces: { family: string; src?: string; weight?: string; style?: string }[];
  palette: { color: string; count: number }[];
  radii: string[];
  shadows: string[];
  headingSizes: { sample: string; fontSize: string; fontWeight: string; lineHeight: string }[];
}

export interface SmoothScroll {
  lenis: boolean;
  locomotive: boolean;
  scrollSnap: boolean;
}

export interface ExtractionResult {
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  lang: string;
  viewport: { width: number; height: number };
  pageHeight: number;
  tokens: DesignTokens;
  sections: SectionInfo[];
  assets: AssetRef[];
  smoothScroll: SmoothScroll;
  videoCount: number;
  navLinks: { text: string; href: string }[];
  extractedAt: string;
}

export interface DesignReport {
  summary: string;
  vibe: string[];
  colorAnalysis: string;
  typographyAnalysis: string;
  layoutAnalysis: string;
  motionAnalysis: string;
  score: { overall: number; notes: string };
  recommendations: string[];
  sameStylePrompt: string;
}
