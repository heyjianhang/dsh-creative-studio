declare module "*.module.css" {
  const classes: Record<string, string>;
  export const cssText: string;
  export default classes;
}
declare module "@xyflow/react/dist/base.css" {
  const css: string;
  export default css;
}
declare module "*.svg" { const url: string; export default url; }
