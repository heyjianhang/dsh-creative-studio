import { z } from "zod";

const webUrl = z
  .url()
  .max(4000)
  .refine((s) => /^https?:\/\//.test(s));
export const templateId = z.string().regex(/^[a-z0-9-]+:[a-f0-9]{16}$/);
export const templateSchema = z.object({
  id: templateId,
  sourceId: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(100),
  title: z.string().min(1).max(1000),
  prompt: z.string().min(1).max(30000),
  description: z.string().max(10000),
  coverUrl: z.union([webUrl, z.literal("")]),
  referenceImageUrls: z.array(webUrl).max(100),
  tags: z.array(z.string().max(300)).max(100),
  author: z.string().max(1000),
  sourceUrl: webUrl,
  createdAt: z.string().max(100),
  imageMode: z.enum(["", "generate", "edit"]),
  imageModel: z.string().max(200),
});
export const templateCategories = [
  "product",
  "poster",
  "portrait",
  "illustration",
  "character",
  "scene",
  "brand",
  "infographic",
  "interface",
  "other",
] as const;
export type TemplateCategory = (typeof templateCategories)[number];
export const templateSourceSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(100),
  name: z.string().min(1).max(200),
  count: z.number().int().min(0).max(10000),
});
export const templateQuerySchema = z.object({
  query: z.string().max(300).default(""),
  category: z.enum(templateCategories).optional(),
  source: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  favoritesOnly: z.boolean().default(false),
  offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(60).default(48),
  refresh: z.boolean().default(false),
});
export const templateResultSchema = z.object({
  items: z.array(templateSchema).max(60),
  total: z.number().int(),
  catalogTotal: z.number().int(),
  sources: z.array(templateSourceSchema).max(30),
  models: z.array(z.string()).max(100),
  favorites: z.array(templateId).max(10000),
  generatedAt: z.string(),
  fetchedAt: z.string(),
  stale: z.boolean(),
});
export type PromptTemplate = z.output<typeof templateSchema>;
export type TemplateQuery = z.input<typeof templateQuerySchema>;
export type TemplateResult = z.output<typeof templateResultSchema>;

const purposeRules: [TemplateCategory, RegExp][] = [
  ["product", /commerce|product|food|商品|电商|产品|美食|饮品/i],
  ["poster", /poster|typography|海报|排版|封面|缩略图/i],
  [
    "portrait",
    /portrait|fashion|photography|realism|realistic|人像|时尚|摄影|头像|写真/i,
  ],
  ["illustration", /illustrat|comic|cartoon|插画|漫画|卡通|故事板/i],
  ["character", /character|角色|人物|\bip\b/i],
  [
    "scene",
    /scene|travel|architect|interior|landscape|场景|建筑|室内|风景|自然|旅行/i,
  ],
  ["brand", /brand|logo|icon|品牌|图标|标志/i],
  ["infographic", /infographic|chart|education|信息图|图表|科普|教育|图解/i],
  ["interface", /\bui\b|interface|界面|网页|应用设计/i],
];
export function templatePurposes(t: PromptTemplate): TemplateCategory[] {
  const text = [t.title, ...t.tags].join(" ");
  const matches = purposeRules
    .filter(([, pattern]) => pattern.test(text))
    .map(([id]) => id);
  return matches.length ? matches : ["other"];
}
