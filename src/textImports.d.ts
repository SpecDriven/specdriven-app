// Text assets the server bundles in — `import x from "./file.md" with
// { type: "text" }` — which Bun's own types do not declare for markdown.
declare module "*.md" {
  const text: string;
  export default text;
}
