declare module "*.sh" {
  const content: string;
  export default content;
}

declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.png" {
  const url: string;
  export default url;
}
